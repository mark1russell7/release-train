// All repository and package names in these tests are made up.
import { describe, expect, it } from "vitest";
import {
  BLOCKED_LABEL,
  CLAUDE_LINE,
  TRAIN_BRANCH,
  TRAIN_LABEL,
  apply,
  applySummary,
  bodyFingerprint,
  ciState,
  prBody,
  publicReport,
  selectUpdates,
} from "./apply.ts";
import type { RepoUpdate, UpdateResult, Updater } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { gitHub } from "./github.ts";
import { buildGraph } from "./graph.ts";
import { plan } from "./plan.ts";
import type { Manifest, NpmInfo, RepoSnapshot, Resolved } from "./types.ts";
import { editManifest, lockChanges, replaceRange } from "./workspace.ts";

const OWNER = "example-owner";

function repo(name: string, manifests: Record<string, Manifest>, opts: { private?: boolean; resolved?: Resolved } = {}): RepoSnapshot {
  return {
    name,
    private: opts.private ?? false,
    defaultBranch: "main",
    manifests: Object.entries(manifests).map(([path, manifest]) => ({ path, manifest })),
    lockKind: "pnpm",
    resolved: opts.resolved ?? {},
    warnings: [],
  };
}
const npm = (latest: string): NpmInfo => ({ exists: true, latest });

/** A plan with a ready combined update (lib-repo), a ready private update, a waiting update and a repository without an update. */
function fixture() {
  const repos = [
    repo("core-repo", { "": { name: "@ex/core", version: "2.0.0" }, util: { name: "@ex/util", version: "1.4.0" } }),
    repo("next-repo", { "": { name: "@ex/next", version: "2.0.0" } }),
    repo("lib-repo", { "": { name: "@ex/lib", version: "1.0.0", devDependencies: { "@ex/util": "^1.2.0", "@ex/core": "^1.0.0" } } }, {
      resolved: { "": { "@ex/util": "1.3.0", "@ex/core": "1.0.0" } },
    }),
    repo("app-repo", { "": { name: "app", private: true, dependencies: { "@ex/next": "^2.0.0" } } }, { resolved: { "": {} } }),
    repo("secret-repo", { "": { name: "secret-app", private: true, dependencies: { "@ex/util": "^1.0.0" } } }, {
      private: true,
      resolved: { "": { "@ex/util": "1.0.0" } },
    }),
    repo("stale-repo", { "": { name: "stale", private: true, dependencies: { "@ex/util": "^1.0.0" } } }, { resolved: { "": { "@ex/util": "1.4.0" } } }),
  ];
  const registry = { "@ex/core": npm("2.0.0"), "@ex/util": npm("1.4.0"), "@ex/next": npm("1.0.0"), "@ex/lib": npm("1.0.0") };
  return plan(buildGraph({ owner: OWNER, repos, npm: registry, now: new Date("2026-01-01T00:00:00Z") }));
}

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
  return { gh: gitHub({ token: "t", fetch: f }), calls };
}

function pull(n: number, repo: string, extra: Record<string, unknown> = {}) {
  return {
    number: n,
    html_url: `https://github.com/${OWNER}/${repo}/pull/${n}`,
    node_id: `PR_${n}`,
    title: "chore(deps): release train update",
    body: "old body",
    state: "open",
    auto_merge: null,
    head: { sha: `sha${n}`, ref: TRAIN_BRANCH },
    base: { ref: "main" },
    labels: [{ name: TRAIN_LABEL }],
    ...extra,
  };
}

function updater(result: Partial<UpdateResult> = {}): Updater & { seen: RepoUpdate[] } {
  const seen: RepoUpdate[] = [];
  return {
    seen,
    async update(u) {
      seen.push(u);
      return { status: "pushed", sha: "newsha", changes: [], unresolved: [], tool: "pnpm 12.0.0", error: null, ...result };
    },
  };
}

const base = `/repos/${OWNER}`;
const meta: Handler = () => [200, { default_branch: "main", allow_auto_merge: false }];
const green: Record<string, Handler> = {
  [`GET ${base}/secret-repo/commits/sha7/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: "success" }] }],
  [`GET ${base}/secret-repo/commits/sha7/status`]: () => [200, { state: "pending", total_count: 0 }],
};

describe("selection", () => {
  it("combines the items of one repository and gates the later waves", () => {
    const s = selectUpdates(fixture());
    expect(s.ready.map((u) => u.repo).sort()).toEqual(["lib-repo", "secret-repo"]);
    const lib = s.ready.find((u) => u.repo === "lib-repo") as RepoUpdate;
    expect(lib.kind).toBe("adopt-breaking");
    expect(lib.items.map((i) => [i.dep, i.newRange])).toEqual([
      ["@ex/util", null],
      ["@ex/core", "^2.0.0"],
    ]);
    expect(s.waiting.map((w) => [w.repo, w.dependsOn])).toEqual([["app-repo", ["release:next-repo"]]]);
    expect(s.needed.has("stale-repo")).toBe(false);
  });

  it("limits the run to the repositories of --only", () => {
    const s = selectUpdates(fixture(), ["lib-repo"]);
    expect(s.ready.map((u) => u.repo)).toEqual(["lib-repo"]);
    expect(s.waiting).toEqual([]);
  });
});

describe("apply", () => {
  it("changes nothing in a dry run", async () => {
    const { gh, calls } = server({
      [`GET ${base}/stale-repo/pulls`]: () => [200, [pull(3, "stale-repo")]],
    });
    const up = updater();
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: up, dryRun: true });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(up.seen).toEqual([]);
    const states = Object.fromEntries(r.results.map((x) => [x.repo, x.state]));
    expect(states).toEqual({ "stale-repo": "closed", "app-repo": "waiting", "lib-repo": "planned", "secret-repo": "planned" });
  });

  it("opens one pull request, updates an existing one and closes a stale one", async () => {
    const { gh, calls } = server({
      [`GET ${base}/stale-repo/pulls`]: () => [200, [pull(3, "stale-repo")]],
      [`GET ${base}/secret-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo")] : []],
      [`GET ${base}/secret-repo/pulls/7`]: () => [200, { ...pull(7, "secret-repo"), mergeable: true }],
      [`PATCH ${base}/secret-repo/pulls/7`]: (b) => [200, { ...pull(7, "secret-repo"), ...b }],
      [`GET ${base}/lib-repo`]: meta,
      [`GET ${base}/secret-repo`]: meta,
      [`POST ${base}/lib-repo/pulls`]: (b) => [201, { ...pull(9, "lib-repo"), ...b, labels: [] }],
      [`POST ${base}/lib-repo/labels`]: () => [201, {}],
      [`POST ${base}/secret-repo/labels`]: () => [422, { message: "exists" }],
      [`POST ${base}/lib-repo/issues/9/labels`]: () => [200, []],
      [`PATCH ${base}/stale-repo/pulls/3`]: () => [200, {}],
      [`POST ${base}/stale-repo/issues/3/comments`]: () => [201, {}],
      [`DELETE ${base}/stale-repo/git/refs/heads/${TRAIN_BRANCH}`]: () => [204, null],
      [`POST /graphql`]: () => [200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } }],
    });
    const up = updater();
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: up, dryRun: false });
    const by = Object.fromEntries(r.results.map((x) => [x.repo, x]));
    expect(by["lib-repo"]).toMatchObject({ state: "opened", autoMerge: "native", pr: { number: 9 } });
    expect(by["secret-repo"]).toMatchObject({ state: "updated", autoMerge: "native", pr: { number: 7 } });
    expect(by["stale-repo"]?.state).toBe("closed");

    const opened = calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls"));
    expect(opened.map((c) => c.path)).toEqual([`${base}/lib-repo/pulls`]);
    expect(opened[0]?.body).toMatchObject({ head: TRAIN_BRANCH, base: "main" });
    const body = String(opened[0]?.body?.["body"]);
    expect(body).toContain("`^1.0.0` -> `^2.0.0`");
    expect(body).toContain("`update:lib-repo`");
    expect(body.endsWith(CLAUDE_LINE)).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.path === `${base}/stale-repo/pulls/3` && c.body?.["state"] === "closed")).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path === `${base}/lib-repo/issues/9/labels`)).toBe(true);
    // The PR of secret-repo already has the label of the train.
    expect(calls.some((c) => c.path === `${base}/secret-repo/issues/7/labels`)).toBe(false);
  });

  it("labels a pull request with a failed CI as blocked", async () => {
    const { gh, calls } = server({
      [`GET ${base}/secret-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo", { auto_merge: { merge_method: "merge" } })] : []],
      [`GET ${base}/secret-repo/pulls/7`]: () => [200, pull(7, "secret-repo")],
      [`PATCH ${base}/secret-repo/pulls/7`]: (b) => [200, { ...pull(7, "secret-repo", { auto_merge: { merge_method: "merge" } }), ...b }],
      [`GET ${base}/secret-repo`]: meta,
      [`POST ${base}/secret-repo/labels`]: () => [201, {}],
      [`GET ${base}/secret-repo/commits/sha7/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: "failure" }] }],
      [`GET ${base}/secret-repo/commits/sha7/status`]: () => [200, { state: "pending", total_count: 0 }],
      [`POST ${base}/secret-repo/issues/7/labels`]: () => [200, []],
    });
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: updater({ status: "same", sha: "sha7" }), dryRun: false, only: ["secret-repo"] });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ state: "blocked", ci: "failed", autoMerge: "native" });
    const label = calls.find((c) => c.path === `${base}/secret-repo/issues/7/labels`);
    expect(label?.body).toEqual({ labels: [BLOCKED_LABEL] });
  });

  it("merges a green pull request itself when GitHub auto-merge is not available", async () => {
    const { gh, calls } = server({
      ...green,
      [`GET ${base}/secret-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo")] : []],
      [`GET ${base}/secret-repo/pulls/7`]: () => [200, pull(7, "secret-repo")],
      [`PATCH ${base}/secret-repo/pulls/7`]: (b) => [200, { ...pull(7, "secret-repo"), ...b }],
      [`GET ${base}/secret-repo`]: meta,
      [`PATCH ${base}/secret-repo`]: () => [403, { message: "Resource not accessible by integration" }],
      [`POST ${base}/secret-repo/labels`]: () => [201, {}],
      [`POST /graphql`]: () => [200, { errors: [{ message: "Auto merge is not allowed for this repository" }] }],
      [`PUT ${base}/secret-repo/pulls/7/merge`]: () => [200, { merged: true }],
      [`DELETE ${base}/secret-repo/git/refs/heads/${TRAIN_BRANCH}`]: () => [204, null],
    });
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: updater({ status: "same", sha: "sha7" }), dryRun: false, only: ["secret-repo"] });
    expect(r.results[0]).toMatchObject({ state: "merged", ci: "green", autoMerge: "train" });
    expect(calls.some((c) => c.method === "PATCH" && c.path === `${base}/secret-repo` && c.body?.["allow_auto_merge"] === true)).toBe(true);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ merge_method: "merge", sha: "sha7" });
  });

  it("does not open a pull request again that a person closed", async () => {
    const fp = selectUpdates(fixture(), ["lib-repo"]).ready[0]?.fingerprint;
    const { gh, calls } = server({
      [`GET ${base}/lib-repo/pulls`]: (_b, u) =>
        [200, u.searchParams.get("state") === "open" ? [] : [pull(4, "lib-repo", { state: "closed", merged_at: null, body: `x <!-- release-train:fingerprint=${fp} -->` })]],
      [`GET ${base}/lib-repo`]: meta,
    });
    const up = updater();
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: up, dryRun: false, only: ["lib-repo"] });
    expect(r.results[0]?.state).toBe("declined");
    expect(up.seen).toEqual([]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("opens no pull request when the lockfile does not get the target versions", async () => {
    const { gh, calls } = server({ [`GET ${base}/lib-repo/pulls`]: () => [200, []], [`GET ${base}/lib-repo`]: meta });
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: updater({ status: "unresolved", unresolved: ["@ex/core"] }), dryRun: false, only: ["lib-repo"] });
    expect(r.results[0]?.state).toBe("skipped");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("keeps each private name out of the log, the public report and the summary", async () => {
    const { gh } = server({ [`GET ${base}/secret-repo/pulls`]: () => [200, [pull(7, "secret-repo")]] });
    const lines: string[] = [];
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: updater(), dryRun: true, log: (l) => lines.push(l) });
    const pub = publicReport(r, "key");
    const text = `${lines.join("\n")}\n${applySummary(pub)}\n${JSON.stringify(pub)}`;
    expect(text).not.toContain("secret");
    expect(text).toContain("lib-repo");
    expect(applySummary(pub)).toContain("Wave 0: 2 pull requests. Public: lib-repo. Count of private repositories: 1.");
  });
});

describe("helpers", () => {
  it("joins the check runs and the commit status", () => {
    expect(ciState([], null)).toBe("none");
    expect(ciState([{ status: "in_progress", conclusion: null }], null)).toBe("running");
    expect(ciState([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }], null)).toBe("green");
    expect(ciState([{ status: "completed", conclusion: "success" }], { state: "failure", total_count: 1 })).toBe("failed");
    expect(ciState([{ status: "completed", conclusion: "cancelled" }], null)).toBe("failed");
  });

  it("writes the fingerprint and the lockfile changes into the body", () => {
    const u = selectUpdates(fixture(), ["lib-repo"]).ready[0] as RepoUpdate;
    const body = prBody(u, {
      tool: "pnpm 12.0.0",
      unresolved: [],
      changes: [
        { path: "", dep: "@ex/core", from: "1.0.0", to: "2.0.0", intended: true },
        { path: "", dep: "other", from: "abc", to: "def", intended: false },
      ],
    });
    expect(bodyFingerprint(body)).toBe(u.fingerprint);
    expect(body).toContain("| `@ex/core` | `.` | devDependencies | `^1.0.0` -> `^2.0.0` | 1.0.0 -> 2.0.0 |");
    expect(body).toContain("- `other` in `.`: abc -> def");
  });

  it("changes a range and keeps the format of package.json", () => {
    expect(replaceRange("^1.0.0", "^1.0.0", "^2.0.0")).toBe("^2.0.0");
    expect(replaceRange("npm:@ex/core@^1.0.0", "^1.0.0", "^2.0.0")).toBe("npm:@ex/core@^2.0.0");
    expect(replaceRange("workspace:*", "^1.0.0", "^2.0.0")).toBeNull();
    const text = '{\n    "name": "x",\n    "dependencies": {\n        "@ex/core": "^1.0.0"\n    }\n}\n';
    const out = editManifest(text, [{ type: "dependencies", dep: "@ex/core", range: "^1.0.0", newRange: "^2.0.0" }]);
    expect(out.text).toBe(text.replace("^1.0.0", "^2.0.0"));
    expect(editManifest(text, [{ type: "devDependencies", dep: "@ex/core", range: "^1.0.0", newRange: "^2.0.0" }]).failed).toEqual(["@ex/core"]);
  });

  it("lists the lockfile changes and marks the intended ones", () => {
    const c = lockChanges({ "": { a: "1.0.0", b: "1.0.0" } }, { "": { a: "1.1.0", b: "1.0.0", c: "1.0.0" } }, new Set(["|a"]));
    expect(c).toEqual([
      { path: "", dep: "a", from: "1.0.0", to: "1.1.0", intended: true },
      { path: "", dep: "c", from: null, to: "1.0.0", intended: false },
    ]);
  });
});

describe("redaction", () => {
  it("replaces only whole names", async () => {
    const { redactName } = await import("./cli.ts");
    expect(redactName("Private: 1. Privat: x", "Privat", "H")).toBe("Private: 1. H: x");
    expect(redactName("repo secret-repo and @ex/secret-repo and github.com/o/secret-repo/pull/1.", "secret-repo", "H")).toBe("repo H and @ex/H and github.com/o/H/pull/1.");
    expect(redactName("my-secret-repo2", "secret-repo", "H")).toBe("my-secret-repo2");
  });
});

describe("merge method", () => {
  it("uses a merge commit when the repository permits it", async () => {
    const { mergeMethod } = await import("./apply.ts");
    expect(mergeMethod(null)).toBe("merge");
    expect(mergeMethod({ allow_merge_commit: true })).toBe("merge");
    expect(mergeMethod({ allow_merge_commit: false, allow_squash_merge: true })).toBe("squash");
    expect(mergeMethod({ allow_merge_commit: false, allow_squash_merge: false })).toBe("rebase");
  });
});

describe("author", () => {
  it("reads Name <email>", async () => {
    const { parseAuthor } = await import("./cli.ts");
    expect(parseAuthor("bot[bot] <1+bot[bot]@users.noreply.github.com>")).toEqual({ name: "bot[bot]", email: "1+bot[bot]@users.noreply.github.com" });
    expect(parseAuthor(null).name).toBe("release-train");
    expect(parseAuthor("no email").name).toBe("release-train");
  });
});
