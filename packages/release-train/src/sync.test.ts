// All repository and package names in these tests are made up.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSY_LIMIT, RUN_MS, TRAIN_LABEL, apply, applySummary, bodyFingerprint, busyRunners, publicReport, syncPrBody } from "./apply.ts";
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
  renovateDays,
  renovateInput,
  syncFacts,
  syncRepo,
  workflowsRefused,
} from "./sync.ts";
import type { RepoFiles, RunFacts, SyncFacts, SyncJob, SyncPush, SyncUpdater } from "./sync.ts";
import type { RepoSnapshot } from "./types.ts";
import { CREDENTIAL_NAME, gitUpdater, needsGitAuth } from "./workspace.ts";
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

describe("coverage", () => {
  const lock = { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "pnpm-workspace.yaml": "packages:\n  - packages/*\n" };
  const pkg = (test: string, dev: Record<string, string> = {}) => JSON.stringify({ name: "@demo/a", scripts: { test }, devDependencies: dev });
  const devOf = (r: Awaited<ReturnType<typeof syncRepo>>) =>
    (JSON.parse(r.writes["package.json"] ?? "{}") as { devDependencies: Record<string, string> }).devDependencies;

  it("adds the provider to the root at the range of the root Vitest, in sorted order, and asks for a lockfile update", async () => {
    const files = mem({ ...lock, "package.json": rootPkg({}, { "a-tool": "^1.0.0", vitest: "^3.2.4" }), "packages/a/package.json": pkg("vitest run") });
    const r = await syncRepo(files, facts());
    expect(outcome(r, "coverage")?.state).toBe("applied");
    expect(r.install).toBe(true);
    expect(Object.entries(devOf(r))).toEqual([
      ["@vitest/coverage-v8", "^3.2.4"],
      ["a-tool", "^1.0.0"],
      ["vitest", "^3.2.4"],
    ]);
  });

  it("takes the range of the packages when the root has no Vitest and the packages agree", async () => {
    const files = mem({
      ...lock,
      "package.json": rootPkg({}),
      "packages/a/package.json": pkg("vitest run", { vitest: "^3.2.4" }),
      "packages/b/package.json": pkg("vitest run --passWithNoTests", { vitest: "^3.2.4" }),
    });
    expect(devOf(await syncRepo(files, facts()))["@vitest/coverage-v8"]).toBe("^3.2.4");
  });

  it("reports and changes nothing when the packages name different ranges, or a catalog range", async () => {
    const two = mem({
      ...lock,
      "package.json": rootPkg({}),
      "packages/a/package.json": pkg("vitest run", { vitest: "^3.2.4" }),
      "packages/b/package.json": pkg("vitest run", { vitest: "^2.1.0" }),
    });
    const r = await syncRepo(two, facts());
    expect(outcome(r, "coverage")).toMatchObject({ state: "report", changes: [] });
    expect(outcome(r, "coverage")?.needs[0]).toContain("2 ranges");
    expect(r.writes["package.json"]).toBeUndefined();
    const catalog = mem({ ...lock, "package.json": rootPkg({}, { vitest: "catalog:" }), "packages/a/package.json": pkg("vitest run") });
    expect(outcome(await syncRepo(catalog, facts()), "coverage")?.needs[0]).toContain("`catalog:`");
  });

  it("does nothing when the provider is there, when no test uses Vitest, without a pnpm lockfile, and outside the workspace", async () => {
    const has = mem({ ...lock, "package.json": rootPkg({}, { "@vitest/coverage-v8": "^3.2.4", vitest: "^3.2.4" }), "packages/a/package.json": pkg("vitest run") });
    const inPkg = mem({ ...lock, "package.json": rootPkg({}), "packages/a/package.json": pkg("vitest run", { "@vitest/coverage-v8": "^3.2.4", vitest: "^3.2.4" }) });
    const other = mem({ ...lock, "package.json": rootPkg({}, { vitest: "^3.2.4" }), "packages/a/package.json": pkg("node --test") });
    const npm = mem({ "package.json": rootPkg({}, { vitest: "^3.2.4" }), "packages/a/package.json": pkg("vitest run") });
    const data = mem({ ...lock, "package.json": rootPkg({}, { vitest: "^3.2.4" }), "examples/x/package.json": pkg("vitest run") });
    for (const files of [has, inPkg, other, npm, data]) expect(outcome(await syncRepo(files, facts()), "coverage")).toBeUndefined();
  });

  it("counts the root when its own test script starts Vitest", async () => {
    const files = mem({ ...lock, "package.json": rootPkg({ test: "vitest run" }, { vitest: "^3.2.4" }) });
    const r = await syncRepo(files, facts());
    expect(outcome(r, "coverage")?.changes[0]).toContain("1 package with Vitest tests");
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

describe("renovate-day", () => {
  const PRESET = `github>${OWNER}/template//renovate/default`;
  const renovate = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ $schema: "s", extends: [PRESET], ...extra }, null, 2)}\n`;

  it("writes the day of the run into renovate.json, after extends", async () => {
    const files = mem({ "renovate.json": renovate({ labels: ["deps"] }) });
    const r = await syncRepo(files, facts({ renovateDay: () => "thursday" }));
    expect(outcome(r, "renovate-day")?.state).toBe("applied");
    const text = r.writes["renovate.json"] ?? "";
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["$schema", "extends", "schedule", "labels"]);
    expect(JSON.parse(text)).toMatchObject({ schedule: ["before 6am on thursday"] });
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("changes nothing when the day is already there, with no day, or for a schedule of another form", async () => {
    const day = facts({ renovateDay: () => "monday" });
    expect(outcome(await syncRepo(mem({ "renovate.json": renovate({ schedule: ["before 6am on monday"] }) }), day), "renovate-day")).toBeUndefined();
    expect(outcome(await syncRepo(mem({ "renovate.json": renovate() }), facts()), "renovate-day")).toBeUndefined();
    expect(outcome(await syncRepo(mem({ "renovate.json": renovate({ schedule: ["every weekend"] }) }), day), "renovate-day")).toBeUndefined();
    expect(outcome(await syncRepo(mem({ "renovate.json": `{"extends": ["config:recommended"]}\n` }), day), "renovate-day")).toBeUndefined();
    expect(outcome(await syncRepo(mem({ "renovate.json": renovate() }), facts({ repo: "template", renovateDay: () => "friday" })), "renovate-day")).toBeUndefined();
  });

  it("weighs a repository by the jobs of one pull request, with the shared workflows of the template", async () => {
    const shared = "on: workflow_call\njobs:\n  checks:\n    strategy:\n      matrix:\n        os: [a, b]\n  changesets: {}\n";
    const f = facts({ readTemplate: async (p) => (p === ".github/workflows/reusable-ci.yml" ? shared : null) });
    const files = mem({ "renovate.json": renovate(), ".github/workflows/ci.yml": `on: pull_request\n${ci(NEW)}` });
    expect(await renovateInput("demo-repo", files, f)).toEqual({ repo: "demo-repo", weight: 3, current: null });
    expect(await renovateInput("template", files, f)).toEqual({ repo: "template", weight: 3, current: "monday", fixed: true });
    expect(await renovateInput("demo-repo", mem({ ".github/workflows/ci.yml": ci(NEW) }), f)).toBeNull();
  });

  it("spreads the repositories of a run over the days", async () => {
    const repos = Array.from({ length: 14 }, (_, i) => ({
      repo: `repo-${i}`,
      files: mem({ "renovate.json": renovate(), ".github/workflows/ci.yml": "on: pull_request\njobs:\n  a: {}\n" }),
    }));
    const dayOf = await renovateDays([...repos, { repo: "empty-repo", files: null }], facts());
    const days = repos.map((r) => dayOf(r.repo));
    expect(new Set(days).size).toBe(7);
    expect(dayOf("empty-repo")).toBeNull();
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
        [`GET ${base}/demo-repo/compare/main...s6`]: () => [200, { behind_by: 0 }],
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

  it("waits for the next run after maxPushes pushes, and while the runners are busy", async () => {
    const run = async (pace: { maxPushes?: number; runnersBusy?: () => Promise<number | null> }) => {
      const { gh } = server(repoRoutes("demo-repo"));
      const up = syncer([]);
      const r = await apply({ owner: OWNER, plan: onePlan("demo-repo"), gh, updater: noUpdates, dryRun: false, sync: { updater: up, facts: runFacts(), workflows: "no" }, ...pace });
      return { up, r };
    };
    const capped = await run({ maxPushes: 0 });
    expect(capped.up.jobs).toEqual([]);
    expect(capped.r.results[0]).toMatchObject({ kind: SYNC_KIND, state: "waiting", paced: true });
    expect(capped.r.results[0]?.detail).toContain("the most of one run");
    const busy = await run({ runnersBusy: async () => BUSY_LIMIT });
    expect(busy.up.jobs).toEqual([]);
    expect(busy.r.results[0]?.detail).toContain(`${String(BUSY_LIMIT)} jobs run`);
    for (const count of [BUSY_LIMIT - 1, null]) {
      const free = await run({ maxPushes: 1, runnersBusy: async () => count });
      expect(free.up.jobs).toHaveLength(1);
      expect(free.r.results[0]).toMatchObject({ state: "opened" });
    }
  });

  it("shares one limit with the update pushes, and each kind goes first in turn", async () => {
    const snap: RepoSnapshot = { name: "demo-repo", private: false, defaultBranch: "main", manifests: [{ path: "", manifest: { name: "demo", private: true, devDependencies: { "@ex/tool": "^1.0.0" } } }], lockKind: "pnpm", resolved: { "": { "@ex/tool": "1.0.0" } }, warnings: [] };
    const tool: RepoSnapshot = { name: "tool-repo", private: false, defaultBranch: "main", manifests: [{ path: "", manifest: { name: "@ex/tool", version: "1.1.0" } }], lockKind: "pnpm", resolved: {}, warnings: [] };
    const p = plan(buildGraph({ owner: OWNER, repos: [snap, tool], npm: { "@ex/tool": { exists: true, latest: "1.1.0" } }, now: new Date("2026-01-01T00:00:00Z") }));
    const run = async (slot: number, maxPushes: number) => {
      const { gh } = server(repoRoutes("demo-repo"));
      const up = syncer([]);
      const seen: string[] = [];
      const updater: Updater = { async update(u) { seen.push(u.repo); return { status: "pushed", sha: "s8", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null }; } };
      const r = await apply({ owner: OWNER, plan: p, gh, updater, dryRun: false, sync: { updater: up, facts: runFacts(), workflows: "no" }, maxPushes, now: new Date(slot * RUN_MS) });
      return { updates: seen.length, syncs: up.jobs.length, states: r.results.map((x) => `${x.kind === SYNC_KIND ? "sync" : "update"} ${x.state}`).sort() };
    };
    expect(await run(0, 1)).toEqual({ updates: 1, syncs: 0, states: ["sync waiting", "update opened"] });
    expect(await run(1, 1)).toEqual({ updates: 0, syncs: 1, states: ["sync opened", "update waiting"] });
    expect(await run(1, 2)).toEqual({ updates: 1, syncs: 1, states: ["sync opened", "update opened"] });
  });

  describe("on a busy account", () => {
    const pkg = (name: string, dep: boolean): RepoSnapshot => ({ name, private: false, defaultBranch: "main", manifests: [{ path: "", manifest: dep ? { name: "demo", private: true, devDependencies: { "@ex/tool": "^1.0.0" } } : { name: "@ex/tool", version: "1.1.0" } }], lockKind: "pnpm", resolved: dep ? { "": { "@ex/tool": "1.0.0" } } : {}, warnings: [] });
    const p = () => plan(buildGraph({ owner: OWNER, repos: [pkg("demo-repo", true), pkg("tool-repo", false)], npm: { "@ex/tool": { exists: true, latest: "1.1.0" } }, now: new Date("2026-01-01T00:00:00Z") }));
    const run = async (o: { slot: number; busy: number; urgent?: string[] }) => {
      const { gh } = server(repoRoutes("demo-repo"));
      const order: string[] = [];
      const inner = syncer([]);
      const up: SyncUpdater = { sync: async (job, ctx) => { order.push("sync"); return inner.sync(job, ctx); } };
      const updater: Updater = { async update() { order.push("update"); return { status: "pushed", sha: "s8", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null }; } };
      const r = await apply({ owner: OWNER, plan: p(), gh, updater, dryRun: false, sync: { updater: up, facts: runFacts(), workflows: "no" }, maxPushes: 5, runnersBusy: async () => o.busy, urgent: o.urgent ?? null, now: new Date(o.slot * RUN_MS) });
      return { order, sync: r.results.find((x) => x.kind === SYNC_KIND) };
    };

    it("stops a sync push and not an update push", async () => {
      for (const slot of [0, 1]) {
        const busy = await run({ slot, busy: BUSY_LIMIT });
        expect(busy.order).toEqual(["update"]);
        expect(busy.sync).toMatchObject({ state: "waiting", paced: true });
        expect(busy.sync?.detail).toContain("a sync push waits at 30 or more");
      }
    });

    it("gives the sync its turn when the account is not busy", async () => {
      expect((await run({ slot: 1, busy: BUSY_LIMIT - 1 })).order).toEqual(["sync", "update"]);
      expect((await run({ slot: 0, busy: BUSY_LIMIT - 1 })).order).toEqual(["update", "sync"]);
    });

    it("puts an urgent update before the sync, also in the turn of the sync", async () => {
      expect((await run({ slot: 1, busy: 0, urgent: ["@ex/tool"] })).order).toEqual(["update", "sync"]);
    });
  });

  it("gives the same waiting state in a dry run, and pushes nothing", async () => {
    const { gh, calls } = server(repoRoutes("demo-repo"));
    const up = syncer([]);
    const r = await apply({ owner: OWNER, plan: onePlan("demo-repo"), gh, updater: noUpdates, dryRun: true, sync: { updater: up, facts: runFacts(), workflows: "no" }, maxPushes: 0 });
    expect(r.results[0]).toMatchObject({ kind: SYNC_KIND, state: "waiting", paced: true });
    expect(up.jobs).toEqual([]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("counts the jobs in progress of the runs in progress, and keeps the count for the time to live", async () => {
    let now = 0;
    const { gh, calls } = server({
      [`GET ${base}/a/actions/runs`]: (_b, u) => [200, { workflow_runs: u.searchParams.get("status") === "in_progress" ? [{ id: 1 }, { id: 2 }] : [] }],
      [`GET ${base}/a/actions/runs/1/jobs`]: () => [200, { jobs: [{ status: "in_progress" }, { status: "completed" }, { status: "queued" }] }],
      [`GET ${base}/a/actions/runs/2/jobs`]: () => [200, { jobs: [{ status: "in_progress" }] }],
      [`GET ${base}/b/actions/runs`]: () => [200, { workflow_runs: [] }],
    });
    const busy = busyRunners(gh, OWNER, ["a", "b"], 1000, () => now);
    expect(await busy()).toBe(2);
    const made = calls.length;
    now = 999;
    expect(await busy()).toBe(2);
    expect(calls.length).toBe(made);
    const { gh: broken } = server({});
    expect(await busyRunners(broken, OWNER, ["a"])()).toBeNull();
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives the token only to git clone, fetch and push of a sync, and no secret to any command", async () => {
    vi.stubEnv("GH_TOKEN", "ghs_parent");
    vi.stubEnv("RELEASE_TRAIN_HASH_KEY", "label-key");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    const calls: { line: string; cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: RunFn = async (cmd, args, opts) => {
      calls.push({ line: `${cmd} ${args.join(" ")}`, cmd, args, env: opts.env ?? {} });
      if (cmd === "git" && args[0] === "clone") clone(opts.cwd);
      if (cmd === "git" && args[0] === "fetch") return { code: 128, stdout: "", stderr: "no branch" };
      if (cmd === "git" && args[0] === "ls-files") return { code: 0, stdout: tracked, stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M package.json\n", stderr: "" };
      return { code: 0, stdout: cmd === "pnpm" ? "12.0.0\n" : "sha1\n", stderr: "" };
    };
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run });
    const r = await up.sync({ repo: "demo-repo", facts: facts(), workflows: false }, { defaultBranch: "main", rebuild: false });
    expect(r.status).toBe("pushed");
    expect(calls.map((c) => c.line)).toContain("pnpm install --lockfile-only");
    for (const c of calls) {
      expect(Object.keys(c.env).some((key) => key.startsWith("GIT_CONFIG_")), c.line).toBe(needsGitAuth(c.cmd, c.args));
      expect(Object.keys(c.env).filter((key) => CREDENTIAL_NAME.test(key)), c.line).toEqual([]);
      expect(Object.values(c.env).join("\n"), c.line).not.toContain("ghs_parent");
    }
    expect(calls.filter((c) => needsGitAuth(c.cmd, c.args)).map((c) => c.args[0]).sort()).toEqual(["clone", "fetch", "push"]);
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
