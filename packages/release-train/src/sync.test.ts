// All repository and package names in these tests are made up.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRAIN_LABEL, apply, applySummary, bodyFingerprint, publicReport, syncPrBody } from "./apply.ts";
import type { Updater } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { gitHub } from "./github.ts";
import { buildGraph } from "./graph.ts";
import { plan } from "./plan.ts";
import {
  CLI_COPY_SCRIPT,
  SYNC_BRANCH,
  SYNC_KIND,
  WORKFLOWS_WAIT,
  inSurface,
  movePins,
  pinSurface,
  pinsOf,
  pinsStale,
  syncFacts,
  syncRepo,
  workflowsRefused,
} from "./sync.ts";
import type { RepoFiles, RunFacts, SyncFacts, SyncJob, SyncPush, SyncUpdater } from "./sync.ts";
import type { RepoSnapshot } from "./types.ts";
import { gitUpdater } from "./workspace.ts";
import type { RunFn } from "./workspace.ts";

const OWNER = "example-owner";
const OLD = "1".repeat(40);
const MID = "2".repeat(40);
const NEW = "3".repeat(40);
const T = `${OWNER}/template`;

function mem(files: Record<string, string>): RepoFiles {
  return { paths: Object.keys(files).sort(), read: async (p) => files[p] ?? null };
}

function facts(extra: Partial<SyncFacts> = {}): SyncFacts {
  return {
    owner: OWNER,
    repo: "demo-repo",
    templateSha: NEW,
    templatePaths: new Set([".github/workflows/reusable-ci.yml", ".github/workflows/reusable-release-build.yml", ".github/actions/npm-publish"]),
    cliVersion: "0.4.1",
    releaseInFlight: false,
    // MID and NEW contain the merge of the release scripts change. OLD does not.
    contains: async (sha) => sha === MID || sha === NEW,
    ...extra,
  };
}

const ci = (sha: string) => `jobs:\n  ci:\n    uses: ${T}/.github/workflows/reusable-ci.yml@${sha} # v1\n`;
const release = (sha: string) =>
  [
    "jobs:",
    "  build:",
    `    uses: "${T}/.github/workflows/reusable-release-build.yml@${sha}" # main`,
    "  publish:",
    "    steps:",
    `      - uses: ${T}/.github/actions/npm-publish@${sha}`,
    "",
  ].join("\n");
const scripts = { "scripts/release/pack.mjs": "x", "scripts/release/tags.mjs": "y" };
const rootPkg = (s: Record<string, string>, dev: Record<string, string> = { "a-tool": "^1.0.0", "z-tool": "^1.0.0" }) =>
  `${JSON.stringify({ name: "demo", private: true, scripts: s, devDependencies: dev }, null, 2)}\n`;
const outcome = (r: Awaited<ReturnType<typeof syncRepo>>, rule: string) => r.outcomes.find((o) => o.rule === rule);

describe("pins", () => {
  it("moves each pin of the template to main, with the comment main, and keeps the quotes and the line ends", () => {
    const text = release(OLD).replace(/\n/g, "\r\n");
    const r = movePins(text, OWNER, NEW, null);
    expect(r.moved).toBe(2);
    expect(r.text).toContain(`uses: "${T}/.github/workflows/reusable-release-build.yml@${NEW}" # main\r\n`);
    expect(r.text).toContain(`- uses: ${T}/.github/actions/npm-publish@${NEW} # main\r\n`);
    expect(movePins(r.text, OWNER, NEW, null).moved).toBe(0);
  });

  it("does not move a pin to a path that the template does not have, and reports it", async () => {
    const files = mem({ ".github/workflows/x.yml": `    uses: ${T}/.github/workflows/gone.yml@${OLD}\n` });
    const r = await syncRepo(files, facts());
    expect(outcome(r, "pins")).toMatchObject({ state: "report", changes: [] });
    expect(outcome(r, "pins")?.needs[0]).toContain("`.github/workflows/gone.yml`");
  });

  describe("the surface of a pin", () => {
    const shared = [
      "jobs:",
      "  ci:",
      "    steps:",
      "      - uses: actions/checkout@v6",
      "        with:",
      "          repository: ${{ job.workflow_repository }}",
      "          ref: ${{ job.workflow_sha }}",
      "          sparse-checkout: .github/actions",
      "      - uses: actions/checkout@v6",
      "        with:",
      "          repository: ${{ job.workflow_repository }}",
      "          sparse-checkout: |",
      "            scripts/release",
      "            scripts/ai-review/",
      "          path: x",
      "",
    ].join("\n");

    it("is the file of a shared workflow and the sparse-checkout paths of its checkouts of the template", () => {
      expect(pinSurface(".github/workflows/reusable-ci.yml", shared)).toEqual([
        ".github/workflows/reusable-ci.yml",
        ".github/actions",
        "scripts/release",
        "scripts/ai-review",
      ]);
      expect(pinSurface(".github/actions/npm-publish", null)).toEqual([".github/actions/npm-publish"]);
    });

    it("is the whole template when a checkout of the template has no sparse-checkout, or the text is not known", () => {
      expect(pinSurface(".github/workflows/reusable-ci.yml", shared.replace("          sparse-checkout: .github/actions\n", ""))).toBeNull();
      expect(pinSurface(".github/workflows/reusable-ci.yml", null)).toBeNull();
    });

    it("has a file of a folder, but not a file whose name only starts with the folder name", () => {
      expect(inSurface(".github/actions/site-pages/action.yml", [".github/actions"])).toBe(true);
      expect(inSurface(".github/actions-test.yml", [".github/actions"])).toBe(false);
    });

    const surfaceFacts = (changed: string[] | null) =>
      facts({
        changedSince: async (sha) => (sha === OLD ? changed : []),
        readTemplate: async (p) => (p === ".github/workflows/reusable-ci.yml" ? shared : null),
      });

    it("moves no pin when only files outside the surface changed, such as the docs of the template", async () => {
      const files = mem({ ".github/workflows/ci.yml": ci(OLD) });
      const r = await syncRepo(files, surfaceFacts(["docs/ROADMAP.md", "README.md", ".github/workflows/actions-test.yml"]));
      expect(r.writes).toEqual({});
      expect(outcome(r, "pins")).toBeUndefined();
      expect(await pinsStale(pinsOf(ci(OLD), OWNER), surfaceFacts(["docs/ROADMAP.md"]))).toBe(false);
    });

    it("moves all pins of the repository when a file of one surface changed", async () => {
      const files = mem({ ".github/workflows/ci.yml": ci(OLD), ".github/workflows/release.yml": release(NEW).replace(`npm-publish@${NEW}`, `npm-publish@${OLD}`) });
      const r = await syncRepo(files, surfaceFacts(["scripts/release/pack.ts"]));
      expect(Object.keys(r.writes).sort()).toEqual([".github/workflows/ci.yml", ".github/workflows/release.yml"]);
    });

    it("moves the pins when the change is not known, as before", async () => {
      const r = await syncRepo(mem({ ".github/workflows/ci.yml": ci(OLD) }), surfaceFacts(null));
      expect(Object.keys(r.writes)).toEqual([".github/workflows/ci.yml"]);
      expect(await pinsStale(pinsOf(ci(OLD), OWNER), facts())).toBe(true);
    });
  });

  it("keeps the pins of release.yml while a version is in flight", async () => {
    const files = mem({ ".github/workflows/ci.yml": ci(OLD), ".github/workflows/release.yml": release(OLD) });
    const r = await syncRepo(files, facts({ releaseInFlight: true }));
    expect(Object.keys(r.writes)).toEqual([".github/workflows/ci.yml"]);
    expect(outcome(r, "pins")?.waits[0]).toContain("in flight");
  });

  it("does not change the template repository", async () => {
    const r = await syncRepo(mem({ ".github/workflows/ci.yml": ci(OLD) }), facts({ repo: "template" }));
    expect(r.outcomes).toEqual([]);
    expect(r.fingerprint).toBe("");
  });

  it("waits for the Workflows permission of the App", async () => {
    const r = await syncRepo(mem({ ".github/workflows/ci.yml": ci(OLD) }), facts(), undefined, false);
    expect(outcome(r, "pins")).toMatchObject({ state: "held", waits: [WORKFLOWS_WAIT] });
    expect(r.writes).toEqual({});
    expect(r.fingerprint).toBe("");
  });
});

describe("release-scripts", () => {
  it("deletes scripts/release/ after the pins move to a template commit with the change", async () => {
    const r = await syncRepo(mem({ ".github/workflows/release.yml": release(OLD), ...scripts }), facts());
    expect(outcome(r, "release-scripts")?.state).toBe("applied");
    expect(r.removes).toEqual(["scripts/release"]);
  });

  it("waits with the pins when the App cannot change workflow files", async () => {
    const r = await syncRepo(mem({ ".github/workflows/release.yml": release(OLD), ...scripts }), facts(), undefined, false);
    expect(outcome(r, "release-scripts")).toMatchObject({ state: "held" });
    expect(outcome(r, "release-scripts")?.waits).toContain(WORKFLOWS_WAIT);
    expect(r.removes).toEqual([]);
  });

  it("deletes scripts/release/ without the Workflows permission when the pin already has the change", async () => {
    const r = await syncRepo(mem({ ".github/workflows/release.yml": release(MID), ...scripts }), facts(), undefined, false);
    expect(outcome(r, "pins")?.state).toBe("held");
    expect(outcome(r, "release-scripts")?.state).toBe("applied");
    expect(r.removes).toEqual(["scripts/release"]);
  });

  it("keeps scripts/release/ when a script still refers to it, and asks for a hand", async () => {
    const files = mem({ ".github/workflows/release.yml": release(NEW), ...scripts, "package.json": rootPkg({ "test:release": "node --test scripts/release/*.test.mjs" }) });
    const r = await syncRepo(files, facts());
    expect(outcome(r, "release-scripts")).toMatchObject({ state: "report", changes: [] });
    expect(outcome(r, "release-scripts")?.needs[0]).toContain("`test:release`");
    expect(r.removes).toEqual([]);
  });

  it("ignores a comment that names scripts/release", async () => {
    const files = mem({ ".github/workflows/release.yml": `# It runs scripts/release/pack.mjs.\n${release(NEW)}`, ...scripts });
    expect((await syncRepo(files, facts())).removes).toEqual(["scripts/release"]);
  });
});

describe("template-cli", () => {
  const copy = { "packages/cli/package.json": JSON.stringify({ name: "@demo/cli", private: true }), "packages/cli/src/index.ts": "x" };

  it("deletes packages/cli/, starts the published CLI and asks for a lockfile update", async () => {
    const files = mem({ "package.json": rootPkg({ package: CLI_COPY_SCRIPT, template: "tsx packages/cli/src/index.ts repo" }), ...copy });
    const r = await syncRepo(files, facts());
    expect(outcome(r, "template-cli")?.state).toBe("applied");
    expect(r.removes).toEqual(["packages/cli"]);
    expect(r.install).toBe(true);
    const m = JSON.parse(r.writes["package.json"] ?? "{}") as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(m.scripts).toEqual({ package: "template package", template: "template repo" });
    expect(Object.entries(m.devDependencies)).toEqual([
      ["@example-owner/template-cli", "^0.4.1"],
      ["a-tool", "^1.0.0"],
      ["z-tool", "^1.0.0"],
    ]);
    expect(r.writes["package.json"]?.endsWith("}\n")).toBe(true);
  });

  it("does not add the template script when the repository has none", async () => {
    const r = await syncRepo(mem({ "package.json": rootPkg({ package: CLI_COPY_SCRIPT }), ...copy }), facts());
    const m = JSON.parse(r.writes["package.json"] ?? "{}") as { scripts: Record<string, string> };
    expect(m.scripts).toEqual({ package: "template package" });
  });

  it("keeps packages/cli/ when another script uses the copy", async () => {
    const files = mem({ "package.json": rootPkg({ package: CLI_COPY_SCRIPT, build: "pnpm --filter @demo/cli build" }), ...copy });
    const r = await syncRepo(files, facts());
    expect(outcome(r, "template-cli")).toMatchObject({ state: "report", changes: [] });
    expect(outcome(r, "template-cli")?.needs[0]).toContain("`build`");
    expect(r.removes).toEqual([]);
  });

  it("keeps packages/cli/ when its package is not private, and when npm has no CLI", async () => {
    const pub = mem({ "package.json": rootPkg({ package: CLI_COPY_SCRIPT }), "packages/cli/package.json": JSON.stringify({ name: "@demo/cli" }) });
    expect(outcome(await syncRepo(pub, facts()), "template-cli")?.needs[0]).toContain("not private");
    const none = mem({ "package.json": rootPkg({ package: CLI_COPY_SCRIPT }), ...copy });
    expect(outcome(await syncRepo(none, facts({ cliVersion: null })), "template-cli")?.needs[0]).toContain("npm has no version");
  });

  it("does not change a repository that already uses the published CLI", async () => {
    const r = await syncRepo(mem({ "package.json": rootPkg({ package: "template package" }) }), facts());
    expect(r.outcomes).toEqual([]);
  });
});

describe("callers", () => {
  it("reports a release.yml and a ci.yml that do not call the shared workflows, and changes nothing", async () => {
    const files = mem({ ".github/workflows/release.yml": "jobs:\n  x:\n    runs-on: ubuntu-latest\n", ".github/workflows/ci.yml": `# ${T}/.github/workflows/reusable-ci.yml@x\njobs: {}\n` });
    const r = await syncRepo(files, facts());
    expect(outcome(r, "callers")).toMatchObject({ state: "report", changes: [] });
    expect(outcome(r, "callers")?.needs).toHaveLength(2);
    expect(r.fingerprint).toBe("");
  });
});

describe("fingerprint", () => {
  it("is the same for the same changes and changes with the template commit", async () => {
    const files = mem({ ".github/workflows/ci.yml": ci(OLD) });
    const a = await syncRepo(files, facts());
    expect(a.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect((await syncRepo(files, facts())).fingerprint).toBe(a.fingerprint);
    expect((await syncRepo(files, facts({ templateSha: MID }))).fingerprint).not.toBe(a.fingerprint);
    expect(bodyFingerprint(syncPrBody(a, null))).toBe(a.fingerprint);
  });
});

describe("workflowsRefused", () => {
  it("matches the refusal of GitHub", () => {
    expect(workflowsRefused("refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission")).toBe(true);
    expect(workflowsRefused("remote: Permission denied")).toBe(false);
  });
});

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}
type Handler = (body: Record<string, unknown> | undefined, url: URL) => [number, unknown];

function server(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const f: FetchFn = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path: `${u.pathname}${u.search}`, body });
    const h = routes[`${method} ${u.pathname}`];
    const [status, data] = h ? h(body, u) : [404, { message: "Not Found" }];
    return new Response(status === 204 || data === null ? null : JSON.stringify(data), { status });
  };
  return { gh: gitHub({ token: "t", fetch: f }), calls, f };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const base = `/repos/${OWNER}`;

/** A GitHub with one public repository: its CI pins an old template commit and it has a copy of the template CLI. */
function repoRoutes(repo: string, extra: Record<string, Handler> = {}): Record<string, Handler> {
  const files: Record<string, string> = {
    ".github/workflows/ci.yml": ci(OLD),
    "package.json": rootPkg({ package: CLI_COPY_SCRIPT }),
    "packages/cli/package.json": JSON.stringify({ name: "@demo/cli", private: true }),
  };
  const routes: Record<string, Handler> = {
    [`GET ${base}/${repo}/git/trees/HEAD`]: () => [200, { tree: Object.keys(files).map((path) => ({ path, type: "blob" })) }],
    [`GET ${base}/${repo}`]: () => [200, { default_branch: "main", allow_auto_merge: false }],
    [`GET ${base}/${repo}/pulls`]: () => [200, []],
    [`POST ${base}/${repo}/pulls`]: (b) => [201, { number: 5, html_url: `https://github.com/${OWNER}/${repo}/pull/5`, node_id: "PR_5", title: "", body: b?.["body"], state: "open", head: { sha: "s5", ref: SYNC_BRANCH }, base: { ref: "main" }, labels: [] }],
    [`POST ${base}/${repo}/labels`]: () => [201, {}],
    [`POST ${base}/${repo}/issues/5/labels`]: () => [200, []],
    [`POST /graphql`]: () => [200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } }],
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) routes[`GET ${base}/${repo}/contents/${path}`] = () => [200, { content: b64(text) }];
  return routes;
}

function onePlan(repo: string, isPrivate = false) {
  const snap: RepoSnapshot = { name: repo, private: isPrivate, defaultBranch: "main", manifests: [{ path: "", manifest: { name: "demo", private: true } }], lockKind: "pnpm", resolved: {}, warnings: [] };
  return plan(buildGraph({ owner: OWNER, repos: [snap], npm: {}, now: new Date("2026-01-01T00:00:00Z") }));
}

const noUpdates: Updater = { update: async () => { throw new Error("no update in this test"); } };
const runFacts = (): RunFacts => {
  const { owner: _o, repo: _r, releaseInFlight: _f, ...rest } = facts();
  return { owner: OWNER, ...rest };
};

function syncer(results: ((job: SyncJob) => Partial<SyncPush>)[]): SyncUpdater & { jobs: SyncJob[] } {
  const jobs: SyncJob[] = [];
  return {
    jobs,
    async sync(job) {
      const make = results[jobs.length] ?? (() => ({}));
      jobs.push(job);
      const result = await syncRepo(mem({ ".github/workflows/ci.yml": ci(OLD), "package.json": rootPkg({ package: CLI_COPY_SCRIPT }) }), job.facts, job.rules, job.workflows);
      return { status: "pushed", sha: "s9", result, tool: "pnpm 12.0.0", error: null, ...make(job) };
    },
  };
}

describe("apply with the template sync", () => {
  it("lists the sync in a dry run and changes nothing", async () => {
    const { gh, calls } = server(repoRoutes("demo-repo"));
    const up = syncer([]);
    const r = await apply({ owner: OWNER, plan: onePlan("demo-repo"), gh, updater: noUpdates, dryRun: true, sync: { updater: up, facts: runFacts(), workflows: "no" } });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(up.jobs).toEqual([]);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ kind: SYNC_KIND, state: "planned" });
    expect(r.results[0]?.detail).toContain("template-cli");
    expect(r.results[0]?.needs?.some((n) => n.includes(WORKFLOWS_WAIT))).toBe(true);
    expect(applySummary(r)).toContain("Template sync: 1 pull requests. Public: demo-repo.");
    expect(applySummary(r)).toContain("Needs a hand (template sync):");
  });

  it("pushes again without the workflow changes when GitHub refuses them, and opens one labeled pull request", async () => {
    const { gh, calls } = server(repoRoutes("demo-repo"));
    const up = syncer([() => ({ status: "workflows-denied", sha: null, error: "without `workflows` permission" })]);
    const lines: string[] = [];
    const r = await apply({ owner: OWNER, plan: onePlan("demo-repo"), gh, updater: noUpdates, dryRun: false, log: (l) => lines.push(l), sync: { updater: up, facts: runFacts(), workflows: "auto" } });
    expect(up.jobs.map((j) => j.workflows)).toEqual([true, false]);
    expect(r.results[0]).toMatchObject({ kind: SYNC_KIND, state: "opened", pr: { number: 5 } });
    const made = calls.find((c) => c.method === "POST" && c.path === `${base}/demo-repo/pulls`);
    expect(made?.body).toMatchObject({ head: SYNC_BRANCH, base: "main" });
    const body = String(made?.body?.["body"]);
    expect(body).toContain("### `template-cli`");
    expect(body).toContain(WORKFLOWS_WAIT);
    expect(bodyFingerprint(body)).toMatch(/^[0-9a-f]{12}$/);
    expect(calls.some((c) => c.path === `${base}/demo-repo/issues/5/labels` && JSON.stringify(c.body).includes(TRAIN_LABEL))).toBe(true);
    expect(lines.some((l) => l.includes("no Workflows permission"))).toBe(true);
  });

  it("does not clone or push when the open pull request has the same fingerprint, and merges it on green", async () => {
    const files = mem({ ".github/workflows/ci.yml": ci(OLD), "package.json": rootPkg({ package: CLI_COPY_SCRIPT }), "packages/cli/package.json": JSON.stringify({ name: "@demo/cli", private: true }) });
    const fp = (await syncRepo(files, facts(), undefined, false)).fingerprint;
    const pr = { number: 6, html_url: "u6", node_id: "PR_6", title: "t", body: `x <!-- release-train:fingerprint=${fp} -->`, state: "open", auto_merge: null, head: { sha: "s6", ref: SYNC_BRANCH }, base: { ref: "main" }, labels: [{ name: TRAIN_LABEL }] };
    const { gh, calls } = server(
      repoRoutes("demo-repo", {
        [`GET ${base}/demo-repo/pulls`]: (_b, u) => [200, u.searchParams.get("head")?.endsWith(SYNC_BRANCH) && u.searchParams.get("state") === "open" ? [pr] : []],
        [`GET ${base}/demo-repo/pulls/6`]: () => [200, { ...pr, mergeable: true }],
        [`GET ${base}/demo-repo/commits/s6/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: "success" }] }],
        [`GET ${base}/demo-repo/commits/s6/status`]: () => [200, { state: "pending", total_count: 0 }],
        [`POST /graphql`]: () => [200, { errors: [{ message: "Auto merge is not allowed for this repository" }] }],
        [`PATCH ${base}/demo-repo`]: () => [403, { message: "no" }],
        [`PUT ${base}/demo-repo/pulls/6/merge`]: () => [200, { merged: true }],
        [`DELETE ${base}/demo-repo/git/refs/heads/${SYNC_BRANCH}`]: () => [204, null],
      }),
    );
    const up = syncer([]);
    const r = await apply({ owner: OWNER, plan: onePlan("demo-repo"), gh, updater: noUpdates, dryRun: false, sync: { updater: up, facts: runFacts(), workflows: "no" } });
    expect(up.jobs).toEqual([]);
    expect(r.results[0]).toMatchObject({ state: "merged", ci: "green" });
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith(`/refs/heads/${SYNC_BRANCH}`))).toBe(true);
  });

  it("keeps the name and the problems of a private repository out of the public report", async () => {
    const { gh } = server(repoRoutes("hidden-repo"));
    const r = await apply({ owner: OWNER, plan: onePlan("hidden-repo", true), gh, updater: noUpdates, dryRun: true, sync: { updater: syncer([]), facts: runFacts(), workflows: "no" } });
    const pub = publicReport(r, "key");
    const text = `${applySummary(pub)}\n${JSON.stringify(pub)}`;
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("@demo/cli");
    expect(text).toContain("Count of private repositories: 1.");
  });
});

describe("syncFacts", () => {
  it("reads the template commit, its files, the CLI version, and compares a pin with the change once", async () => {
    const { gh, calls, f } = server({
      [`GET ${base}/template/commits/main`]: () => [200, { sha: NEW }],
      [`GET ${base}/template/git/trees/${NEW}`]: () => [200, { tree: [{ path: ".github/workflows/reusable-ci.yml" }] }],
      [`GET ${base}/template/compare/29ea70d75aee6c1a170c7324509c21eead9f52a1...${MID}`]: () => [200, { status: "ahead" }],
      [`GET ${base}/template/compare/29ea70d75aee6c1a170c7324509c21eead9f52a1...${OLD}`]: () => [200, { status: "behind" }],
      [`GET /@example-owner%2ftemplate-cli`]: () => [200, { "dist-tags": { latest: "0.4.1" } }],
    });
    const r = await syncFacts({ gh, owner: OWNER, fetch: f, registry: "https://registry.example" });
    expect(r).toMatchObject({ templateSha: NEW, cliVersion: "0.4.1" });
    expect(r?.templatePaths?.has(".github/workflows/reusable-ci.yml")).toBe(true);
    expect(await r?.contains(MID)).toBe(true);
    expect(await r?.contains(MID)).toBe(true);
    expect(await r?.contains(OLD)).toBe(false);
    expect(calls.filter((c) => c.path.includes("/compare/")).length).toBe(2);
  });

  it("pins the oldest first-parent commit of main with the surface of the head, so a docs commit moves no target", async () => {
    const wf = ["jobs:", "  ci:", "    steps:", "      - with:", "          repository: ${{ job.workflow_repository }}", "          sparse-checkout: scripts/release", ""].join("\n");
    const { gh, f } = server({
      [`GET ${base}/template/commits/main`]: () => [200, { sha: NEW }],
      [`GET ${base}/template/git/trees/${NEW}`]: () => [200, { tree: [{ path: ".github/workflows/reusable-ci.yml" }, { path: "docs/ROADMAP.md" }] }],
      [`GET ${base}/template/git/trees/${MID}`]: () => [200, { tree: [{ path: ".github/workflows/reusable-ci.yml" }] }],
      [`GET ${base}/template/contents/.github/workflows/reusable-ci.yml`]: () => [200, { content: b64(wf) }],
      [`GET ${base}/template/commits/${NEW}`]: () => [200, { parents: [{ sha: MID }] }],
      [`GET ${base}/template/commits/${MID}`]: () => [200, { parents: [{ sha: OLD }] }],
      [`GET ${base}/template/compare/${MID}...${NEW}`]: () => [200, { status: "ahead", files: [{ filename: "docs/ROADMAP.md" }] }],
      [`GET ${base}/template/compare/${OLD}...${NEW}`]: () => [200, { status: "ahead", files: [{ filename: "docs/ROADMAP.md" }, { filename: "scripts/release/pack.ts" }] }],
    });
    const r = await syncFacts({ gh, owner: OWNER, fetch: f, registry: "https://registry.example" });
    expect(r?.templateSha).toBe(MID);
    expect(r?.templatePaths?.has("docs/ROADMAP.md")).toBe(false);
  });

  it("gives the files that changed since a pin once, and null for a cut or a diverged compare", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }));
    const { gh, calls, f } = server({
      [`GET ${base}/template/commits/main`]: () => [200, { sha: NEW }],
      [`GET ${base}/template/git/trees/${NEW}`]: () => [200, { tree: [] }],
      [`GET ${base}/template/compare/${OLD}...${NEW}`]: () => [200, { status: "ahead", files: [{ filename: "docs/a.md" }, { filename: "b.ts", previous_filename: "c.ts" }] }],
      [`GET ${base}/template/compare/${MID}...${NEW}`]: () => [200, { status: "ahead", files: many }],
      [`GET ${base}/template/contents/.github/workflows/reusable-ci.yml`]: (_b, u) => [200, { content: b64(`ref ${u.searchParams.get("ref")}`) }],
    });
    const r = await syncFacts({ gh, owner: OWNER, fetch: f, registry: "https://registry.example" });
    expect(await r?.changedSince?.(OLD)).toEqual(["docs/a.md", "b.ts", "c.ts"]);
    expect(await r?.changedSince?.(OLD)).toEqual(["docs/a.md", "b.ts", "c.ts"]);
    expect(await r?.changedSince?.(MID)).toBeNull();
    expect(await r?.changedSince?.("4".repeat(40))).toBeNull();
    expect(await r?.readTemplate?.(".github/workflows/reusable-ci.yml")).toBe(`ref ${NEW}`);
    expect(calls.filter((c) => c.path.includes(`/compare/${OLD}...`)).length).toBe(1);
  });
});

describe("gitUpdater sync", () => {
  function clone(cwd: string): void {
    const put = (p: string, t: string) => {
      mkdirSync(join(cwd, p, ".."), { recursive: true });
      writeFileSync(join(cwd, p), t);
    };
    put(".github/workflows/ci.yml", ci(OLD));
    put("package.json", rootPkg({ package: CLI_COPY_SCRIPT }));
    put("packages/cli/package.json", JSON.stringify({ name: "@demo/cli", private: true }));
    put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  }
  const tracked = ".github/workflows/ci.yml\0package.json\0packages/cli/package.json\0pnpm-lock.yaml\0";

  it("applies the rules in the clone, updates the lockfile and pushes the sync branch", async () => {
    const cmds: string[] = [];
    const seen: { cli?: boolean; pkg?: string; ci?: string } = {};
    const run: RunFn = async (cmd, args, opts) => {
      cmds.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "clone") clone(opts.cwd);
      if (cmd === "git" && args[0] === "fetch") return { code: 128, stdout: "", stderr: "no branch" };
      if (cmd === "git" && args[0] === "ls-files") return { code: 0, stdout: tracked, stderr: "" };
      if (cmd === "git" && args[0] === "status") {
        Object.assign(seen, { cli: existsSync(join(opts.cwd, "packages/cli")), pkg: readFileSync(join(opts.cwd, "package.json"), "utf8"), ci: readFileSync(join(opts.cwd, ".github/workflows/ci.yml"), "utf8") });
        return { code: 0, stdout: " M package.json\n", stderr: "" };
      }
      return { code: 0, stdout: cmd === "pnpm" ? "12.0.0\n" : "sha1\n", stderr: "" };
    };
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run });
    const r = await up.sync({ repo: "demo-repo", facts: facts(), workflows: false }, { defaultBranch: "main", rebuild: false });
    expect(r.status).toBe("pushed");
    expect(seen).toMatchObject({ cli: false, ci: ci(OLD) });
    expect(seen.pkg).toContain('"package": "template package"');
    expect(cmds.filter((c) => c.startsWith("pnpm install"))).toEqual(["pnpm install --lockfile-only", "pnpm install --lockfile-only --frozen-lockfile"]);
    expect(cmds).toContain(`git push --quiet --force origin HEAD:refs/heads/${SYNC_BRANCH}`);
  });

  it("gives workflows-denied when GitHub refuses the push of a workflow change", async () => {
    const run: RunFn = async (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "clone") clone(opts.cwd);
      if (cmd === "git" && args[0] === "fetch") return { code: 128, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "ls-files") return { code: 0, stdout: tracked, stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M x\n", stderr: "" };
      if (cmd === "git" && args[0] === "push") return { code: 1, stdout: "", stderr: "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run });
    const r = await up.sync({ repo: "demo-repo", facts: facts(), workflows: true }, { defaultBranch: "main", rebuild: false });
    expect(r.status).toBe("workflows-denied");
  });
});
