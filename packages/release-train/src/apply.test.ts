// All repository and package names in these tests are made up.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { ageExcluded, editManifest, gitUpdater, lockChanges, releaseAgePolicy, replaceRange } from "./workspace.ts";
import type { RunFn } from "./workspace.ts";

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
      return { status: "pushed", sha: "newsha", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null, ...result };
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

  it("waits with a green merge while a workflow run of another branch is not done, but not longer than YIELD_MAX_HOURS", async () => {
    const routes = (created: string) => ({
      ...green,
      [`GET ${base}/secret-repo/pulls`]: (_b: unknown, u: URL) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo", { created_at: created })] : []],
      [`GET ${base}/secret-repo/pulls/7`]: () => [200, pull(7, "secret-repo", { created_at: created })],
      [`PATCH ${base}/secret-repo/pulls/7`]: (b: Record<string, unknown> | undefined) => [200, { ...pull(7, "secret-repo", { created_at: created }), ...b }],
      [`GET ${base}/secret-repo`]: meta,
      [`PATCH ${base}/secret-repo`]: () => [403, { message: "Resource not accessible by integration" }],
      [`POST ${base}/secret-repo/labels`]: () => [201, {}],
      [`POST /graphql`]: () => [200, { errors: [{ message: "Auto merge is not allowed for this repository" }] }],
      [`GET ${base}/secret-repo/actions/runs`]: (_b: unknown, u: URL) =>
        [200, { workflow_runs: u.searchParams.get("status") === "in_progress" ? [{ head_branch: "gate/x" }, { head_branch: "main" }, { head_branch: TRAIN_BRANCH }] : [] }],
      [`PUT ${base}/secret-repo/pulls/7/merge`]: () => [200, { merged: true }],
      [`DELETE ${base}/secret-repo/git/refs/heads/${TRAIN_BRANCH}`]: () => [204, null],
    }) as Record<string, Handler>;
    const now = new Date("2026-01-02T00:00:00Z");
    const run = (created: string) => {
      const s = server(routes(created));
      return apply({ owner: OWNER, plan: fixture(), gh: s.gh, updater: updater({ status: "same", sha: "sha7" }), dryRun: false, only: ["secret-repo"], now }).then((r) => ({ r, calls: s.calls }));
    };
    const young = await run("2026-01-01T12:00:00Z");
    expect(young.r.results[0]).toMatchObject({ state: "unchanged", ci: "green", autoMerge: "train" });
    expect(young.r.results[0]?.detail).toMatch(/1 workflow run\(s\) of other branches/);
    expect(young.calls.some((c) => c.method === "PUT")).toBe(false);
    const old = await run("2025-12-31T23:00:00Z");
    expect(old.r.results[0]).toMatchObject({ state: "merged", ci: "green", autoMerge: "train" });
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

  it("closes the pull request with a mark when its versions are younger than the minimumReleaseAge", async () => {
    const { gh, calls } = server({
      [`GET ${base}/lib-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [pull(4, "lib-repo")] : []],
      [`GET ${base}/lib-repo/pulls/4`]: () => [200, pull(4, "lib-repo")],
      [`GET ${base}/lib-repo`]: meta,
      [`POST ${base}/lib-repo/issues/4/comments`]: () => [201, {}],
      [`PATCH ${base}/lib-repo/pulls/4`]: (b) => [200, { ...pull(4, "lib-repo"), ...b }],
      [`DELETE ${base}/lib-repo/git/refs/heads/${TRAIN_BRANCH}`]: () => [204, null],
    });
    const young = [{ dep: "@ex/core", version: "2.0.0", readyAt: "2026-01-02T00:00:00.000Z" }];
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: updater({ status: "young", sha: null, young }), dryRun: false, only: ["lib-repo"] });
    expect(r.results[0]).toMatchObject({ state: "waiting" });
    expect(r.results[0]?.detail).toContain("@ex/core@2.0.0 at 2026-01-02T00:00:00.000Z");
    const patch = calls.find((c) => c.method === "PATCH" && c.path === `${base}/lib-repo/pulls/4`);
    expect(patch?.body?.["state"]).toBe("closed");
    expect(String(patch?.body?.["body"])).toContain("release-train:closed-by-train");
  });

  it("opens a pull request again that the train closed itself", async () => {
    const fp = selectUpdates(fixture(), ["lib-repo"]).ready[0]?.fingerprint;
    const body = `x <!-- release-train:fingerprint=${fp} -->\n<!-- release-train:closed-by-train -->`;
    const { gh } = server({
      [`GET ${base}/lib-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [] : [pull(4, "lib-repo", { state: "closed", merged_at: null, body })]],
      [`GET ${base}/lib-repo`]: meta,
    });
    const up = updater({ status: "unresolved", unresolved: ["@ex/core"] });
    await apply({ owner: OWNER, plan: fixture(), gh, updater: up, dryRun: false, only: ["lib-repo"] });
    expect(up.seen.length).toBe(1);
  });

  it("shows only the items that are old enough in a partial update", async () => {
    const u = selectUpdates(fixture(), ["lib-repo"]).ready[0] as RepoUpdate;
    const text = prBody(u, { changes: [], unresolved: [], tool: "pnpm 12.0.0", young: [{ dep: "@ex/core", version: "2.0.0", readyAt: "2026-01-02T00:00:00.000Z" }] });
    expect(text).toContain("younger than the minimumReleaseAge of pnpm, so a later run adds them: `@ex/core@2.0.0` (ready at 2026-01-02T00:00:00.000Z)");
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

describe("minimumReleaseAge", () => {
  it("reads the policy from pnpm-workspace.yaml and .npmrc, with the default of pnpm 11 and later", () => {
    expect(releaseAgePolicy("", "", "12.10.1")).toEqual({ minutes: 1440, exclude: [] });
    expect(releaseAgePolicy("", "", "10.4.0")).toEqual({ minutes: 0, exclude: [] });
    expect(releaseAgePolicy("packages:\n  - a\nminimumReleaseAge: 0\n", "", "12.0.0").minutes).toBe(0);
    expect(releaseAgePolicy("", "minimum-release-age=60\n", "12.0.0").minutes).toBe(60);
    const yaml = "minimumReleaseAge: 30\nminimumReleaseAgeExclude:\n  - '@ex/*'\n  - other@1.0.0\nonlyBuiltDependencies: []\n";
    expect(releaseAgePolicy(yaml, "", "12.0.0")).toEqual({ minutes: 30, exclude: ["@ex/*", "other@1.0.0"] });
    expect(releaseAgePolicy("minimumReleaseAgeExclude: [a, \"@b/c\"]\n", "", "12.0.0").exclude).toEqual(["a", "@b/c"]);
  });

  it("matches the exclude patterns by name and version", () => {
    expect(ageExcluded(["@ex/*"], "@ex/core", "2.0.0")).toBe(true);
    expect(ageExcluded(["@ex/*"], "@other/core", "2.0.0")).toBe(false);
    expect(ageExcluded(["@ex/core@1.0.0 || 2.0.0"], "@ex/core", "2.0.0")).toBe(true);
    expect(ageExcluded(["@ex/core@1.0.0"], "@ex/core", "2.0.0")).toBe(false);
  });

  it("gives young when each target version is too young, before it changes a file", async () => {
    const cmds: string[] = [];
    const run: RunFn = async (cmd, args) => {
      cmds.push(`${cmd} ${args[0] ?? ""}`);
      return { code: 0, stdout: cmd === "pnpm" ? "12.10.1\n" : "", stderr: "" };
    };
    const f: FetchFn = async () => new Response(JSON.stringify({ time: { "2.0.0": "2026-01-01T12:00:00.000Z" } }), { status: 200 });
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run, fetch: f, now: () => Date.parse("2026-01-02T00:00:00.000Z") });
    const u = selectUpdates(fixture(), ["lib-repo"]).ready[0] as RepoUpdate;
    const one = { ...u, lockKind: "pnpm" as const, items: u.items.filter((i) => i.dep === "@ex/core") };
    const r = await up.update(one, { defaultBranch: "main", rebuild: false });
    expect(r.status).toBe("young");
    expect(r.young).toEqual([{ dep: "@ex/core", version: "2.0.0", readyAt: "2026-01-02T12:00:00.000Z" }]);
    expect(cmds.some((c) => c.startsWith("pnpm update"))).toBe(false);
  });
});

describe("gitUpdater with pnpm", () => {
  it("pins each target version first, then restores the final range, and does not use pnpm update", async () => {
    const u = selectUpdates(fixture(), ["lib-repo"]).ready[0] as RepoUpdate;
    const pnpmU = { ...u, lockKind: "pnpm" as const };
    const cmds: string[] = [];
    const seen: Record<string, string>[] = [];
    const specs = (cwd: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const i of pnpmU.items) {
        const m = JSON.parse(readFileSync(join(cwd, i.path, "package.json"), "utf8")) as Record<string, Record<string, string>>;
        out[`${i.path}|${i.dep}`] = m[i.type]?.[i.dep] ?? "";
      }
      return out;
    };
    const run: RunFn = async (cmd, args, opts) => {
      cmds.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "clone") {
        for (const path of [...new Set(pnpmU.items.map((i) => i.path))]) {
          const m: Record<string, Record<string, string>> = {};
          for (const i of pnpmU.items.filter((x) => x.path === path)) m[i.type] = { ...m[i.type], [i.dep]: i.range };
          mkdirSync(join(opts.cwd, path), { recursive: true });
          writeFileSync(join(opts.cwd, path, "package.json"), `${JSON.stringify({ name: "x", ...m }, null, 2)}\n`);
        }
      }
      if (cmd === "pnpm" && args[0] === "install") seen.push(specs(opts.cwd));
      return { code: 0, stdout: cmd === "pnpm" && args[0] === "--version" ? "10.0.0\n" : "", stderr: "" };
    };
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run });
    await up.update(pnpmU, { defaultBranch: "main", rebuild: false });
    expect(cmds.some((c) => c.startsWith("pnpm update"))).toBe(false);
    expect(cmds.filter((c) => c.startsWith("pnpm install"))).toEqual([
      "pnpm install --lockfile-only",
      "pnpm install --lockfile-only",
      "pnpm install --lockfile-only --frozen-lockfile",
    ]);
    for (const i of pnpmU.items) {
      expect(seen[0]?.[`${i.path}|${i.dep}`]).toBe(i.to);
      expect(seen[1]?.[`${i.path}|${i.dep}`]).toBe(i.newRange ?? i.range);
    }
  });
});
