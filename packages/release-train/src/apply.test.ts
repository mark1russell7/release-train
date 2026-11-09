// All repository and package names in these tests are made up.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_LABEL,
  BUSY_LIMIT,
  CLAUDE_LINE,
  COMPARE_FILES_MAX,
  MERGE_LABEL,
  RENOVATE_REBASE_BOX,
  RUN_MS,
  TRAIN_BRANCH,
  TRAIN_LABEL,
  apply,
  applySummary,
  bodyFingerprint,
  ciState,
  latestRuns,
  longestWaitFirst,
  prBody,
  publicReport,
  rotate,
  selectUpdates,
} from "./apply.ts";
import type { RepoUpdate, UpdateResult, Updater } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { gitHub } from "./github.ts";
import { buildGraph } from "./graph.ts";
import type { LagHold } from "./holds.ts";
import { plan } from "./plan.ts";
import type { Manifest, NpmInfo, RepoSnapshot, Resolved } from "./types.ts";
import { API_REPORT_PACKAGE, CONVENTIONS, ageExcluded, apiReportUpdateArgs, editManifest, gitUpdater, lockChanges, releaseAgePolicy, replaceRange } from "./workspace.ts";
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
  [`GET ${base}/secret-repo/compare/main...sha7`]: () => [200, { behind_by: 0 }],
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

  describe("with a hold on one repository", () => {
    const hold = (dep: string, target: string): LagHold => ({ package: dep, repo: target, reason: "The owner keeps this version.", ruling: "https://example.test/r", until: "2026-11-07" });

    it("does not send the held package, and sends the other packages of that repository", () => {
      const s = selectUpdates(fixture(), null, "all", new Set(), [hold("@ex/core", "lib-repo")]);
      const lib = s.ready.find((u) => u.repo === "lib-repo") as RepoUpdate;
      expect(lib.items.map((i) => i.dep)).toEqual(["@ex/util"]);
      expect(lib.held).toEqual({ items: 1, deps: ["@ex/core"] });
    });

    it("gives another fingerprint, so a new push replaces an open pull request that holds the raise", () => {
      const before = selectUpdates(fixture()).ready.find((u) => u.repo === "lib-repo") as RepoUpdate;
      const after = selectUpdates(fixture(), null, "all", new Set(), [hold("@ex/core", "lib-repo")]).ready.find((u) => u.repo === "lib-repo") as RepoUpdate;
      expect(after.fingerprint).not.toBe(before.fingerprint);
    });

    it("makes the update wait when each package is held, and keeps an open pull request from a merge", () => {
      const s = selectUpdates(fixture(), null, "all", new Set(), [hold("@ex/core", "lib-repo"), hold("@ex/util", "lib-repo")]);
      expect(s.ready.map((u) => u.repo)).toEqual(["secret-repo"]);
      expect(s.waiting.find((w) => w.repo === "lib-repo")).toMatchObject({ holdsOpen: true, dependsOn: expect.arrayContaining(["hold:@ex/core", "hold:@ex/util"]) });
      expect(s.needed.has("lib-repo")).toBe(true);
    });

    it("does not stop that package in another repository", () => {
      const s = selectUpdates(fixture(), null, "all", new Set(), [hold("@ex/util", "lib-repo")]);
      expect(s.ready.find((u) => u.repo === "secret-repo")?.items.map((i) => i.dep)).toEqual(["@ex/util"]);
      expect(s.ready.find((u) => u.repo === "lib-repo")?.items.map((i) => i.dep)).toEqual(["@ex/core"]);
    });

    it("changes nothing when it names a repository with no such update", () => {
      expect(selectUpdates(fixture(), null, "all", new Set(), [hold("@ex/util", "app-repo")])).toEqual(selectUpdates(fixture()));
    });
  });
});

describe("a release in flight", () => {
  /** A repository with 1.1.0 on main and 1.0.0 on npm, and a dependency with a new major version. */
  const pending = () =>
    plan(
      buildGraph({
        owner: OWNER,
        repos: [
          repo("base-repo", { "": { name: "@ex/base", version: "2.0.0" } }),
          repo("pub-repo", { "": { name: "@ex/pub", version: "1.1.0", dependencies: { "@ex/base": "^1.0.0" } } }, { resolved: { "": { "@ex/base": "1.0.0" } } }),
        ],
        npm: { "@ex/base": npm("2.0.0"), "@ex/pub": npm("1.0.0") },
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    );
  const workflow = (text: string): Handler => () => [200, { content: Buffer.from(text).toString("base64") }];
  const routes = (text: string, last: { status: string; conclusion: string | null }): Record<string, Handler> => ({
    [`GET ${base}/pub-repo/pulls`]: () => [200, [pull(5, "pub-repo")]],
    [`GET ${base}/pub-repo`]: meta,
    [`GET ${base}/pub-repo/contents/.github/workflows/release.yml`]: workflow(text),
    [`GET ${base}/pub-repo/actions/workflows/release.yml/runs`]: () => [200, { workflow_runs: [last] }],
    [`GET ${base}/pub-repo/commits/sha5/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: "success" }] }],
    [`GET ${base}/pub-repo/commits/sha5/status`]: () => [200, { state: "pending", total_count: 0 }],
    [`GET ${base}/pub-repo/compare/main...sha5`]: () => [200, { behind_by: 0 }],
  });
  const ON_PUSH = "on:\n  push:\n    branches: [main]\n";
  const BY_HAND = "on:\n  workflow_dispatch:\n";

  it("holds a range of the package, and no other repository", () => {
    expect(selectUpdates(pending()).ready.map((u) => u.repo)).toEqual(["pub-repo"]);
    const s = selectUpdates(pending(), null, "all", new Set(["pub-repo"]));
    expect(s.ready).toEqual([]);
    expect(s.waiting).toEqual([expect.objectContaining({ repo: "pub-repo", holdsOpen: true, dependsOn: expect.arrayContaining(["release-in-flight:release:pub-repo"]) })]);
    expect(selectUpdates(pending(), null, "all", new Set(["other-repo"])).ready.map((u) => u.repo)).toEqual(["pub-repo"]);
  });

  it("does not merge an open green pull request while the release workflow runs", async () => {
    const { gh, calls } = server(routes(ON_PUSH, { status: "queued", conclusion: null }));
    const up = updater();
    const r = await apply({ owner: OWNER, plan: pending(), gh, updater: up, dryRun: false });
    expect(up.seen).toEqual([]);
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect(r.results.find((x) => x.repo === "pub-repo" && x.actionId === "update:pub-repo")).toMatchObject({ state: "waiting", pr: { number: 5 } });
  });

  it("does not hold a range when the last release failed or when the release starts by hand", async () => {
    for (const [text, last] of [
      [ON_PUSH, { status: "completed", conclusion: "failure" }],
      [BY_HAND, { status: "completed", conclusion: "success" }],
    ] as const) {
      const { gh } = server(routes(text, last));
      const r = await apply({ owner: OWNER, plan: pending(), gh, updater: updater(), dryRun: true });
      expect(r.results.find((x) => x.repo === "pub-repo" && x.actionId === "update:pub-repo"), text).toMatchObject({ state: "planned" });
    }
  });
});

describe("a hold in a run of apply", () => {
  const pendingOne = () =>
    plan(
      buildGraph({
        owner: OWNER,
        repos: [
          repo("base-repo", { "": { name: "@ex/base", version: "2.0.0" } }),
          repo("dep-repo", { "": { name: "@ex/dep", version: "1.0.0", dependencies: { "@ex/base": "^1.0.0" } } }, { resolved: { "": { "@ex/base": "1.0.0" } } }),
        ],
        npm: { "@ex/base": npm("2.0.0"), "@ex/dep": npm("1.0.0") },
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    );
  const routes: Record<string, Handler> = {
    [`GET ${base}/dep-repo/pulls`]: () => [200, [pull(5, "dep-repo")]],
    [`GET ${base}/dep-repo`]: meta,
    [`GET ${base}/dep-repo/contents/.github/workflows/release.yml`]: () => [404, {}],
    [`GET ${base}/dep-repo/commits/sha5/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: "success" }] }],
    [`GET ${base}/dep-repo/commits/sha5/status`]: () => [200, { state: "pending", total_count: 0 }],
    [`GET ${base}/dep-repo/compare/main...sha5`]: () => [200, { behind_by: 0 }],
  };
  const holds: LagHold[] = [{ package: "@ex/base", repo: "dep-repo", reason: "The owner keeps this version.", ruling: "https://example.test/r", until: "2026-11-07" }];

  it("sends no update, and does not merge the open pull request", async () => {
    const { gh, calls } = server(routes);
    const up = updater();
    const r = await apply({ owner: OWNER, plan: pendingOne(), gh, updater: up, dryRun: false, holds });
    expect(up.seen).toEqual([]);
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect(r.results.find((x) => x.repo === "dep-repo" && x.actionId === "update:dep-repo")).toMatchObject({ state: "waiting", pr: { number: 5 } });
  });

  it("works on the update with no hold", async () => {
    const { gh } = server(routes);
    const r = await apply({ owner: OWNER, plan: pendingOne(), gh, updater: updater(), dryRun: true });
    expect(r.results.find((x) => x.repo === "dep-repo" && x.actionId === "update:dep-repo")).toMatchObject({ state: "planned" });
  });
});

describe("apply", () => {
  it("changes nothing in a dry run", async () => {
    const { gh, calls } = server({
      [`GET ${base}/stale-repo/pulls`]: () => [200, [pull(3, "stale-repo")]],
      [`GET ${base}/lib-repo`]: meta,
      [`GET ${base}/secret-repo`]: meta,
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
    expect(by["lib-repo"]).toMatchObject({ state: "opened", autoMerge: "train", pr: { number: 9 } });
    expect(by["secret-repo"]).toMatchObject({ state: "updated", autoMerge: "train", pr: { number: 7 } });
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
      [`POST /graphql`]: () => [200, { data: { disablePullRequestAutoMerge: { clientMutationId: null } } }],
    });
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: updater({ status: "same", sha: "sha7" }), dryRun: false, only: ["secret-repo"] });
    expect(r.results).toHaveLength(1);
    // The native auto-merge of GitHub goes off, so only the train merges.
    expect(calls.some((c) => c.path === "/graphql" && String(c.body?.["query"]).includes("disablePullRequestAutoMerge"))).toBe(true);
    expect(r.results[0]).toMatchObject({ state: "blocked", ci: "failed", autoMerge: "train" });
    const label = calls.find((c) => c.path === `${base}/secret-repo/issues/7/labels`);
    expect(label?.body).toEqual({ labels: [BLOCKED_LABEL] });
  });

  it("merges a green pull request itself on the current default branch, and turns on no native auto-merge", async () => {
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
    expect(calls.some((c) => c.path === "/graphql" || (c.method === "PATCH" && c.path === `${base}/secret-repo`))).toBe(false);
    expect(calls.some((c) => c.path === `${base}/secret-repo/compare/main...sha7`)).toBe(true);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ merge_method: "merge", sha: "sha7" });
  });

  it("builds a green branch again from main, with a new install, when its base is behind main, and does not merge it", async () => {
    const routes = (behind: number) => ({
      ...green,
      [`GET ${base}/secret-repo/compare/main...sha7`]: () => [200, { behind_by: behind }],
      [`GET ${base}/secret-repo/pulls`]: (_b: unknown, u: URL) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo")] : []],
      [`GET ${base}/secret-repo/pulls/7`]: () => [200, { ...pull(7, "secret-repo"), mergeable: true }],
      [`PATCH ${base}/secret-repo/pulls/7`]: (b: Record<string, unknown> | undefined) => [200, { ...pull(7, "secret-repo"), ...b }],
      [`GET ${base}/secret-repo`]: meta,
      [`POST ${base}/secret-repo/labels`]: () => [201, {}],
      [`PUT ${base}/secret-repo/pulls/7/merge`]: () => [200, { merged: true }],
      [`DELETE ${base}/secret-repo/git/refs/heads/${TRAIN_BRANCH}`]: () => [204, null],
    }) as Record<string, Handler>;
    // Behind: the updater gets rebuild, the branch gets a new head, and CI runs again before a merge.
    const behind = server(routes(2));
    const seen: boolean[] = [];
    const up: Updater = { async update(_u, ctx) { seen.push(ctx.rebuild); return { status: "pushed", sha: "newsha", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null }; } };
    const r = await apply({ owner: OWNER, plan: fixture(), gh: behind.gh, updater: up, dryRun: false, only: ["secret-repo"] });
    expect(seen).toEqual([true]);
    expect(r.results[0]).toMatchObject({ state: "updated", ci: "none", autoMerge: "train" });
    expect(behind.calls.some((c) => c.method === "PUT")).toBe(false);
    // Up to date: no rebuild, and the green pull request merges.
    const current = server(routes(0));
    const seen2: boolean[] = [];
    const same: Updater = { async update(_u, ctx) { seen2.push(ctx.rebuild); return { status: "same", sha: "sha7", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null }; } };
    const r2 = await apply({ owner: OWNER, plan: fixture(), gh: current.gh, updater: same, dryRun: false, only: ["secret-repo"] });
    expect(seen2).toEqual([false]);
    expect(r2.results[0]).toMatchObject({ state: "merged", ci: "green" });
  });

  it("does not merge a green branch that fell behind main during the run, and does not merge when GitHub does not compare", async () => {
    const run = async (compare: Handler) => {
      const s = server({
        ...green,
        [`GET ${base}/secret-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo")] : []],
        [`GET ${base}/secret-repo/pulls/7`]: () => [200, { ...pull(7, "secret-repo"), mergeable: true }],
        [`PATCH ${base}/secret-repo/pulls/7`]: (b) => [200, { ...pull(7, "secret-repo"), ...b }],
        [`GET ${base}/secret-repo`]: meta,
        [`POST ${base}/secret-repo/labels`]: () => [201, {}],
        [`GET ${base}/secret-repo/compare/main...sha7`]: compare,
        [`PUT ${base}/secret-repo/pulls/7/merge`]: () => [200, { merged: true }],
      });
      const r = await apply({ owner: OWNER, plan: fixture(), gh: s.gh, updater: updater({ status: "same", sha: "sha7" }), dryRun: false, only: ["secret-repo"] });
      return { r, calls: s.calls };
    };
    // The first compare (before the update) gives 0, the second (before the merge) gives 1: main moved in between.
    let n = 0;
    const moved = await run(() => [200, { behind_by: n++ === 0 ? 0 : 1 }]);
    expect(moved.r.results[0]).toMatchObject({ state: "unchanged", ci: "green" });
    expect(moved.r.results[0]?.detail).toContain("1 commit(s) behind main");
    expect(moved.calls.some((c) => c.method === "PUT" && c.path.endsWith("/merge"))).toBe(false);
    // The train merges main into its own branch that fell behind, so CI runs again on the current base.
    expect(moved.calls.some((c) => c.method === "PUT" && c.path.endsWith("/pulls/7/update-branch"))).toBe(true);
    const unknown = await run(() => [404, { message: "Not Found" }]);
    expect(unknown.r.results[0]?.detail).toMatch(/did not compare the branch with main/);
    expect(unknown.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("waits with a green merge that changes workflow files while a release run of main is not done, so GitHub does not refuse the tag", async () => {
    const run = async (files: { filename: string }[], releaseRuns: Handler | null) => {
      const s = server({
        ...green,
        [`GET ${base}/secret-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo")] : []],
        [`GET ${base}/secret-repo/pulls/7`]: () => [200, { ...pull(7, "secret-repo"), mergeable: true }],
        [`PATCH ${base}/secret-repo/pulls/7`]: (b) => [200, { ...pull(7, "secret-repo"), ...b }],
        [`GET ${base}/secret-repo`]: meta,
        [`POST ${base}/secret-repo/labels`]: () => [201, {}],
        [`GET ${base}/secret-repo/compare/main...sha7`]: () => [200, { behind_by: 0, files }],
        ...(releaseRuns ? { [`GET ${base}/secret-repo/actions/workflows/release.yml/runs`]: releaseRuns } : {}),
        [`PUT ${base}/secret-repo/pulls/7/merge`]: () => [200, { merged: true }],
        [`DELETE ${base}/secret-repo/git/refs/heads/${TRAIN_BRANCH}`]: () => [204, null],
      });
      const r = await apply({ owner: OWNER, plan: fixture(), gh: s.gh, updater: updater({ status: "same", sha: "sha7" }), dryRun: false, only: ["secret-repo"] });
      return { r, calls: s.calls };
    };
    const wf = [{ filename: ".github/workflows/ci.yml" }];
    const runs = (...status: string[]): Handler => (_b, u) => [200, { workflow_runs: u.searchParams.get("branch") === "main" ? status.map((x) => ({ status: x })) : [] }];
    // A queued release run holds the merge.
    const queued = await run(wf, runs("queued", "completed"));
    expect(queued.r.results[0]).toMatchObject({ state: "unchanged", ci: "green" });
    expect(queued.r.results[0]?.detail).toMatch(/1 release run\(s\) of main are not done/);
    expect(queued.calls.some((c) => c.method === "PUT")).toBe(false);
    // A run that waits for an approval holds it too.
    expect((await run(wf, runs("waiting"))).calls.some((c) => c.method === "PUT")).toBe(false);
    // An error of the read holds it for this run.
    const unread = await run(wf, () => [500, { message: "Server Error" }]);
    expect(unread.r.results[0]?.detail).toMatch(/did not list the release runs/);
    expect(unread.calls.some((c) => c.method === "PUT")).toBe(false);
    // Each run done, or no release workflow: the merge goes.
    expect((await run(wf, runs("completed"))).r.results[0]).toMatchObject({ state: "merged" });
    expect((await run(wf, null)).r.results[0]).toMatchObject({ state: "merged" });
    // A full file list of the compare API can hide a workflow file, so it holds too.
    const many = Array.from({ length: COMPARE_FILES_MAX }, (_, i) => ({ filename: `src/f${i}.ts` }));
    expect((await run(many, runs("in_progress"))).calls.some((c) => c.method === "PUT")).toBe(false);
    // No workflow file: the release runs are not read, and the merge goes.
    const plain = await run([{ filename: "package.json" }, { filename: "pnpm-lock.yaml" }], runs("queued"));
    expect(plain.r.results[0]).toMatchObject({ state: "merged" });
    expect(plain.calls.some((c) => c.path.endsWith("/actions/workflows/release.yml/runs"))).toBe(false);
  });

  describe("the label train-merge", () => {
    const R = "stale-repo";
    const pin = (extra: Record<string, unknown> = {}) =>
      pull(9, R, {
        title: "chore(deps): pin actions/checkout",
        body: `Renovate body

${RENOVATE_REBASE_BOX} If you want to rebase/retry this PR, check this box`,
        head: { sha: "sha9", ref: "renovate/actions", repo: { full_name: `${OWNER}/${R}` } },
        labels: [{ name: MERGE_LABEL }],
        ...extra,
      });
    const run = async (o: { pr?: Record<string, unknown>; behind?: number; files?: { filename: string }[]; release?: string[] | null; ci?: string; dryRun?: boolean; search?: Handler; update?: Handler }) => {
      const s = server({
        "GET /search/issues": o.search ?? ((_b, u) => [200, { items: u.searchParams.get("q")?.includes(`label:${MERGE_LABEL}`) ? [{ number: 9, repository_url: `https://api.github.com/repos/${OWNER}/${R}` }, { number: 3, repository_url: `https://api.github.com/repos/${OWNER}/not-in-plan` }] : [] }]),
        [`GET ${base}/${R}`]: meta,
        [`GET ${base}/${R}/pulls/9`]: () => [200, pin(o.pr)],
        [`PATCH ${base}/${R}/pulls/9`]: (b) => [200, { ...pin(o.pr), ...b }],
        [`GET ${base}/${R}/commits/sha9/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: o.ci ?? "success" }] }],
        [`GET ${base}/${R}/commits/sha9/status`]: () => [200, { state: "pending", total_count: 0 }],
        [`POST ${base}/${R}/issues/9/labels`]: () => [200, []],
        [`GET ${base}/${R}/compare/main...sha9`]: () => [200, { behind_by: o.behind ?? 0, files: o.files ?? [{ filename: ".github/workflows/ci.yml" }] }],
        ...(o.release === null ? {} : { [`GET ${base}/${R}/actions/workflows/release.yml/runs`]: () => [200, { workflow_runs: (o.release ?? ["completed"]).map((status) => ({ status })) }] }),
        [`PUT ${base}/${R}/pulls/9/merge`]: () => [200, { merged: true }],
        ...(o.update ? { [`PUT ${base}/${R}/pulls/9/update-branch`]: o.update } : {}),
      });
      const r = await apply({ owner: OWNER, plan: fixture(), gh: s.gh, updater: updater(), dryRun: o.dryRun ?? false, only: [R] });
      const mine = r.results.filter((x) => x.kind === "train-merge");
      return { r, mine, calls: s.calls };
    };

    it("merges a green pull request with the label, keeps its branch, and skips a repository that is not in the plan", async () => {
      const { r, mine, calls } = await run({});
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ repo: R, state: "merged", ci: "green", autoMerge: "train", pr: { number: 9 } });
      expect(calls.some((c) => c.method === "PUT" && c.path.includes("/pulls/9/merge"))).toBe(true);
      expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ sha: "sha9" });
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
      expect(calls.some((c) => c.path.includes("not-in-plan"))).toBe(false);
      expect(applySummary(r)).toContain(`Label ${MERGE_LABEL}: 1 pull requests, 1 merged.`);
      expect(applySummary(r)).toContain(`- ${R} [${MERGE_LABEL}]: merged`);
    });

    it("holds a workflow change while a release run of main is not done, so GitHub does not refuse the tag", async () => {
      for (const status of ["queued", "in_progress", "waiting", "pending"]) {
        const { mine, calls } = await run({ release: [status, "completed"] });
        expect(mine[0]).toMatchObject({ state: "unchanged", ci: "green" });
        expect(mine[0]?.detail).toContain("1 release run(s) of main are not done");
        expect(calls.some((c) => c.method === "PUT")).toBe(false);
      }
      // No release workflow: the merge goes.
      expect((await run({ release: null })).mine[0]).toMatchObject({ state: "merged" });
    });

    it("ticks the Renovate rebase box of a branch that is behind, and does not merge it", async () => {
      const { mine, calls } = await run({ behind: 2 });
      expect(mine[0]).toMatchObject({ state: "unchanged", ci: "green" });
      expect(mine[0]?.detail).toContain("2 commit(s) behind main");
      expect(mine[0]?.detail).toContain("ticked the rebase box");
      const patch = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/pulls/9"));
      expect(patch?.body?.["body"]).toContain("- [x] <!-- rebase-check -->");
      expect(patch?.body?.["body"]).not.toContain(RENOVATE_REBASE_BOX);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("merges main into a branch with no rebase box that is behind, so CI runs again, and names a conflict", async () => {
      const update = (status: number): Handler => () => [status, status === 202 ? { message: "Updating pull request branch.", url: "u" } : { message: "merge conflict" }];
      const plain = await run({ behind: 1, pr: { body: "a person's pull request" }, update: update(202) });
      expect(plain.mine[0]).toMatchObject({ state: "unchanged", ci: "green" });
      expect(plain.mine[0]?.detail).toContain("The train merged main into the branch, so CI runs again.");
      const put = plain.calls.find((c) => c.method === "PUT" && c.path.endsWith("/pulls/9/update-branch"));
      expect(put?.body).toEqual({ expected_head_sha: "sha9" });
      expect(plain.calls.some((c) => c.method === "PATCH" || c.path.endsWith("/pulls/9/merge"))).toBe(false);
      // A conflict that GitHub finds at the update (HTTP 422) gives the one detail line for the author.
      const refused = await run({ behind: 1, pr: { body: "a person's pull request" }, update: update(422) });
      expect(refused.mine[0]?.detail).toContain("a conflict with main: its author must merge main into it");
      // A branch that GitHub marks as dirty gets no update call.
      const dirty = await run({ behind: 1, pr: { body: "a person's pull request", mergeable: false, mergeable_state: "dirty" }, update: update(202) });
      expect(dirty.mine[0]?.detail).toContain("a conflict with main");
      expect(dirty.calls.some((c) => c.path.endsWith("/update-branch"))).toBe(false);
      // A branch of a fork gets no update call.
      const fork = await run({ behind: 1, pr: { body: "x", head: { sha: "sha9", ref: "main", repo: { full_name: "someone/fork" } } }, update: update(202) });
      expect(fork.calls.some((c) => c.path.endsWith("/update-branch"))).toBe(false);
    });

    it("labels a failed one as blocked, plans only in a dry run, and skips a fork, another base and a draft", async () => {
      const red = await run({ ci: "failure" });
      expect(red.mine[0]).toMatchObject({ state: "blocked", ci: "failed" });
      expect(red.calls.some((c) => c.method === "PUT")).toBe(false);
      const dry = await run({ dryRun: true });
      expect(dry.mine[0]).toMatchObject({ state: "planned" });
      expect(dry.calls.some((c) => c.method !== "GET")).toBe(false);
      for (const pr of [
        { head: { sha: "sha9", ref: "renovate/actions", repo: { full_name: "someone/stale-repo" } } },
        { base: { ref: "next" } },
        { draft: true },
      ]) {
        const x = await run({ pr });
        expect(x.mine[0]).toMatchObject({ state: "skipped" });
        expect(x.calls.some((c) => c.method !== "GET")).toBe(false);
      }
    });

    it("goes on when the search fails", async () => {
      const { mine, r } = await run({ search: () => [422, { message: "Validation Failed" }] });
      expect(mine).toEqual([]);
      expect(r.results.every((x) => x.state !== "error")).toBe(true);
    });
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

  it("skips a workspace with git submodules, because its clone cannot install", async () => {
    const p = fixture();
    p.repos = p.repos.map((r) => (r.name === "lib-repo" ? { ...r, submodules: ["libs/linked"] } : r));
    const { gh, calls } = server({ [`GET ${base}/lib-repo/pulls`]: () => [200, []], [`GET ${base}/lib-repo`]: meta });
    const up = updater();
    for (const dryRun of [true, false]) {
      const r = await apply({ owner: OWNER, plan: p, gh, updater: up, dryRun, only: ["lib-repo"] });
      expect(r.results[0]?.state).toBe("skipped");
      expect(r.results[0]?.detail).toMatch(/git submodules \(libs\/linked\)/);
    }
    expect(up.seen).toEqual([]);
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
    const { gh } = server({ [`GET ${base}/secret-repo/pulls`]: () => [200, [pull(7, "secret-repo")]], [`GET ${base}/lib-repo`]: meta, [`GET ${base}/secret-repo`]: meta });
    const lines: string[] = [];
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: updater(), dryRun: true, log: (l) => lines.push(l) });
    const pub = publicReport(r, "key");
    const text = `${lines.join("\n")}\n${applySummary(pub)}\n${JSON.stringify(pub)}`;
    expect(text).not.toContain("secret");
    expect(text).toContain("lib-repo");
    expect(applySummary(pub)).toContain("Wave 0: 2 pull requests. Public: lib-repo. Count of private repositories: 1.");
  });
});

/** A plan where each repository of `names` has one lockfile update of the same dev dependency. */
function fan(names: readonly string[], priv: readonly string[] = []) {
  const repos = [
    repo("tool-repo", { "": { name: "@ex/tool", version: "1.1.0" } }),
    ...names.map((n) => repo(n, { "": { name: n, private: true, devDependencies: { "@ex/tool": "^1.0.0" } } }, { private: priv.includes(n), resolved: { "": { "@ex/tool": "1.0.0" } } })),
  ];
  return plan(buildGraph({ owner: OWNER, repos, npm: { "@ex/tool": npm("1.1.0") }, now: new Date("2026-01-01T00:00:00Z") }));
}

/** The start of a run in the slot `n`. Slot 0 is even, so the update pushes go first. */
const slot = (n: number): Date => new Date(n * RUN_MS);

/** A GitHub that remembers the open pull requests of the train, so one run sees the pull requests of an earlier run. */
function memory(names: readonly string[]) {
  const prs = new Map<string, ReturnType<typeof pull>>();
  /** The committer date of the head commit of each pull request. A repository with no date gives HTTP 404. */
  const pushed = new Map<string, string>();
  const routes: Record<string, Handler> = {};
  names.forEach((name, i) => {
    const n = 10 + i;
    routes[`GET ${base}/${name}`] = meta;
    routes[`GET ${base}/${name}/pulls`] = (_b, u) => {
      const pr = prs.get(name);
      return [200, u.searchParams.get("state") === "open" && pr ? [pr] : []];
    };
    routes[`GET ${base}/${name}/pulls/${n}`] = () => [200, { ...prs.get(name), mergeable: true }];
    routes[`POST ${base}/${name}/pulls`] = (b) => {
      const pr = pull(n, name, { ...b, labels: [] });
      prs.set(name, pr);
      return [201, pr];
    };
    routes[`PATCH ${base}/${name}/pulls/${n}`] = () => [200, prs.get(name)];
    routes[`POST ${base}/${name}/labels`] = () => [201, {}];
    routes[`POST ${base}/${name}/issues/${n}/labels`] = () => [200, []];
    routes[`GET ${base}/${name}/compare/main...sha${n}`] = () => [200, { behind_by: 0 }];
    routes[`GET ${base}/${name}/commits/sha${n}/check-runs`] = () => [200, { check_runs: [{ status: "in_progress", conclusion: null }] }];
    routes[`GET ${base}/${name}/commits/sha${n}/status`] = () => [200, { state: "pending", total_count: 0 }];
    routes[`GET ${base}/${name}/commits/sha${n}`] = () => {
      const date = pushed.get(name);
      return date ? [200, { commit: { committer: { date } } }] : [404, { message: "Not Found" }];
    };
  });
  return { ...server(routes), prs, pushed, routes };
}

/** An updater that pushes a branch one time. After it, the branch has the changes, as with the real updater. */
function once(): Updater & { pushed: string[]; cloned: string[] } {
  const pushed: string[] = [];
  const cloned: string[] = [];
  return {
    pushed,
    cloned,
    async update(u) {
      cloned.push(u.repo);
      const first = !pushed.includes(u.repo);
      if (first) pushed.push(u.repo);
      return { status: first ? "pushed" : "same", sha: "newsha", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null };
    },
  };
}

const stateOf = (r: { results: { repo: string; state: string }[] }) => Object.fromEntries(r.results.map((x) => [x.repo, x.state]));

describe("the pace of the update pushes", () => {
  const names = ["a-repo", "b-repo", "c-repo", "d-repo", "e-repo"];

  it("stops the update pushes at the limit, with no clone and no write for the repositories that wait", async () => {
    const { gh, calls } = memory(names);
    const up = once();
    const r = await apply({ owner: OWNER, plan: fan(names), gh, updater: up, dryRun: false, maxPushes: 2, now: slot(0) });
    expect(up.cloned).toEqual(["a-repo", "b-repo"]);
    expect(stateOf(r)).toEqual({ "a-repo": "opened", "b-repo": "opened", "c-repo": "waiting", "d-repo": "waiting", "e-repo": "waiting" });
    expect(calls.filter((c) => c.method !== "GET" && /(c|d|e)-repo/.test(c.path))).toEqual([]);
    const waiting = r.results.find((x) => x.repo === "c-repo");
    expect(waiting).toMatchObject({ paced: true, pr: null, ci: null, autoMerge: null });
    expect(waiting?.detail).toContain("This run pushed 2 branches, the most of one run");
    expect(applySummary(r)).toContain("Waiting for a later run: 3. Public: c-repo, d-repo, e-repo. Count of private repositories: 0.");
    expect(applySummary(r)).not.toContain("Waiting for a release");
  });

  it("does not stop an update push while the runners are busy, and does not read the count of the runners", async () => {
    const { gh } = memory(names);
    const up = once();
    let counts = 0;
    const runnersBusy = async () => {
      counts += 1;
      return BUSY_LIMIT + 10;
    };
    const r = await apply({ owner: OWNER, plan: fan(names), gh, updater: up, dryRun: false, maxPushes: 2, runnersBusy, now: slot(0) });
    expect(up.pushed).toEqual(["a-repo", "b-repo"]);
    expect(counts).toBe(0);
    expect(r.results.find((x) => x.repo === "c-repo")?.detail).not.toContain("jobs run on the runners");
  });

  it("takes a repository that waits in a later run, pushes each repository one time, and clones no waiting repository", async () => {
    const { gh } = memory(names);
    const p = fan(names);
    const up = once();
    const pushedBy: number[] = [];
    let last = stateOf({ results: [] });
    for (let n = 0; n < 3; n++) {
      const before = up.pushed.length;
      last = stateOf(await apply({ owner: OWNER, plan: p, gh, updater: up, dryRun: false, maxPushes: 2, now: slot(2 * n) }));
      pushedBy.push(up.pushed.length - before);
    }
    expect(pushedBy).toEqual([2, 2, 1]);
    expect([...up.pushed].sort()).toEqual(names);
    expect(Object.values(last).includes("waiting")).toBe(false);
  });

  describe("a labeled pull request that is behind", () => {
    const L = "tool-repo";
    /** This function adds a green labeled pull request of another author in `tool-repo`, 1 commit behind, with its last push at `date`. */
    const labeled = (m: ReturnType<typeof memory>, date: string) => {
      m.routes["GET /search/issues"] = (_b, u) => [200, { items: u.searchParams.get("q")?.includes(`label:${MERGE_LABEL}`) ? [{ number: 9, repository_url: `https://api.github.com/repos/${OWNER}/${L}` }] : [] }];
      m.routes[`GET ${base}/${L}`] = meta;
      m.routes[`GET ${base}/${L}/pulls/9`] = () => [200, pull(9, L, { body: "a person's pull request", head: { sha: "sha9", ref: "feature", repo: { full_name: `${OWNER}/${L}` } }, labels: [{ name: MERGE_LABEL }], mergeable: true })];
      m.routes[`GET ${base}/${L}/commits/sha9/check-runs`] = () => [200, { check_runs: [{ status: "completed", conclusion: "success" }] }];
      m.routes[`GET ${base}/${L}/commits/sha9/status`] = () => [200, { state: "pending", total_count: 0 }];
      m.routes[`GET ${base}/${L}/commits/sha9`] = () => [200, { commit: { committer: { date } } }];
      m.routes[`GET ${base}/${L}/compare/main...sha9`] = () => [200, { behind_by: 1, files: [] }];
      m.routes[`PUT ${base}/${L}/pulls/9/update-branch`] = () => [202, { message: "Updating pull request branch." }];
    };
    const updates = (m: ReturnType<typeof memory>) => m.calls.filter((c) => c.method === "PUT" && c.path.endsWith(`/${L}/pulls/9/update-branch`)).length;

    it("gets its update within 2 runs at the limit, in the same longest-wait order as the pushes", async () => {
      // 5 updates and a limit of 2: each run is at the limit. The labeled branch waited longer than each update, so a push yields its turn.
      const m = memory(names);
      labeled(m, "1969-12-31T00:00:00Z");
      const up = once();
      const first = await apply({ owner: OWNER, plan: fan(names), gh: m.gh, updater: up, dryRun: false, maxPushes: 2, now: slot(0) });
      expect(up.pushed).toEqual(["a-repo"]);
      expect(updates(m)).toBe(1);
      expect(first.results.find((x) => x.kind === "train-merge")?.detail).toContain("The train merged main into the branch, so CI runs again.");
      const b = first.results.find((x) => x.repo === "b-repo");
      expect(b).toMatchObject({ state: "waiting", paced: true });
      expect(b?.detail).toContain("keeps 1 turn(s) for an older merge of the default branch");
    });

    it("waits behind pushes that waited longer, and gets its turn when they are done", async () => {
      const m = memory(names);
      labeled(m, "1970-01-01T02:30:00Z");
      const up = once();
      const first = await apply({ owner: OWNER, plan: fan(names), gh: m.gh, updater: up, dryRun: false, maxPushes: 2, now: slot(0) });
      expect(up.pushed).toEqual(["a-repo", "b-repo"]);
      expect(updates(m)).toBe(0);
      expect(first.results.find((x) => x.kind === "train-merge")?.detail).toContain("The merge of main into the branch waits: This run pushed 2 branches");
      // In slot 6 the updates with no pull request wait from 03:00, so the labeled branch is older and goes first.
      await apply({ owner: OWNER, plan: fan(names), gh: m.gh, updater: up, dryRun: false, maxPushes: 2, now: slot(6) });
      expect(up.pushed).toEqual(["a-repo", "b-repo", "c-repo"]);
      expect(updates(m)).toBe(1);
    });
  });

  it("pushes the newest versions when a repository that waited gets its turn", async () => {
    const { gh } = memory(["a-repo", "b-repo"]);
    const up = once();
    await apply({ owner: OWNER, plan: fan(["a-repo", "b-repo"]), gh, updater: up, dryRun: false, maxPushes: 1, now: slot(0) });
    const newer = plan(buildGraph({
      owner: OWNER,
      repos: [
        repo("tool-repo", { "": { name: "@ex/tool", version: "1.2.0" } }),
        ...["a-repo", "b-repo"].map((n) => repo(n, { "": { name: n, private: true, devDependencies: { "@ex/tool": "^1.0.0" } } }, { resolved: { "": { "@ex/tool": "1.0.0" } } })),
      ],
      npm: { "@ex/tool": npm("1.2.0") },
      now: new Date("2026-01-01T00:00:00Z"),
    }));
    const seen: string[] = [];
    const record: Updater = { async update(u) { seen.push(`${u.repo} ${u.items[0]?.to ?? ""}`); return { status: "same", sha: "newsha", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null }; } };
    await apply({ owner: OWNER, plan: newer, gh, updater: record, dryRun: false, maxPushes: 5, now: slot(2) });
    expect(seen).toContain("b-repo 1.2.0");
  });

  it("merges a green open pull request at the limit, with no clone", async () => {
    const fp = selectUpdates(fixture(), ["secret-repo"]).ready[0]?.fingerprint;
    const body = `x <!-- release-train:fingerprint=${fp} -->`;
    const { gh, calls } = server({
      ...green,
      [`GET ${base}/secret-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo", { body })] : []],
      [`GET ${base}/secret-repo/pulls/7`]: () => [200, pull(7, "secret-repo", { body })],
      [`GET ${base}/secret-repo`]: meta,
      [`PUT ${base}/secret-repo/pulls/7/merge`]: () => [200, { merged: true }],
      [`DELETE ${base}/secret-repo/git/refs/heads/${TRAIN_BRANCH}`]: () => [204, null],
    });
    const up = updater();
    const r = await apply({ owner: OWNER, plan: fixture(), gh, updater: up, dryRun: false, only: ["secret-repo"], maxPushes: 0, now: slot(0) });
    expect(up.seen).toEqual([]);
    expect(r.results[0]).toMatchObject({ state: "merged", ci: "green", autoMerge: "train" });
    expect(r.results[0]).not.toHaveProperty("paced");
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
  });

  it("settles an open pull request whose push waits: green merges, red blocks, and a branch that is behind waits", async () => {
    const run = async (checks: { status: string; conclusion: string | null }[], behind: number) => {
      const s = server({
        ...green,
        [`GET ${base}/secret-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [pull(7, "secret-repo")] : []],
        [`GET ${base}/secret-repo/pulls/7`]: () => [200, { ...pull(7, "secret-repo"), mergeable: true }],
        [`GET ${base}/secret-repo`]: meta,
        [`GET ${base}/secret-repo/commits/sha7/check-runs`]: () => [200, { check_runs: checks }],
        [`GET ${base}/secret-repo/compare/main...sha7`]: () => [200, { behind_by: behind }],
        [`PUT ${base}/secret-repo/pulls/7/merge`]: () => [200, { merged: true }],
        [`DELETE ${base}/secret-repo/git/refs/heads/${TRAIN_BRANCH}`]: () => [204, null],
        [`POST ${base}/secret-repo/issues/7/labels`]: () => [200, []],
      });
      const up = updater();
      const r = await apply({ owner: OWNER, plan: fixture(), gh: s.gh, updater: up, dryRun: false, only: ["secret-repo"], maxPushes: 0, now: slot(0) });
      expect(up.seen).toEqual([]);
      return { x: r.results[0], calls: s.calls };
    };
    const ok = { status: "completed", conclusion: "success" };
    expect((await run([ok], 0)).x).toMatchObject({ state: "merged", ci: "green" });
    const red = await run([{ status: "completed", conclusion: "failure" }], 0);
    expect(red.x).toMatchObject({ state: "blocked", ci: "failed" });
    expect(red.calls.find((c) => c.path === `${base}/secret-repo/issues/7/labels`)?.body).toEqual({ labels: [BLOCKED_LABEL] });
    const behind = await run([ok], 2);
    expect(behind.x).toMatchObject({ state: "waiting", ci: "green", paced: true, pr: { number: 7 } });
    expect(behind.x?.detail).toContain("2 commit(s) behind main");
    expect(behind.x?.detail).toContain("the most of one run");
    expect(behind.calls.some((c) => c.method === "PUT" && c.path.endsWith("/merge"))).toBe(false);
    // The merge of main starts CI as a push does, so it also waits for the limit of pushes.
    expect(behind.calls.some((c) => c.method === "PUT" && c.path.endsWith("/pulls/7/update-branch"))).toBe(false);
    expect(behind.x?.detail).toContain("The merge of main into the branch waits");
  });

  it("counts only a real push: a clone that pushes nothing leaves the limit free, and a branch that has its changes can still push", async () => {
    const quiet = updater({ status: "young", sha: null, young: [{ dep: "@ex/tool", version: "1.1.0", readyAt: "2026-01-02T00:00:00.000Z" }] });
    await apply({ owner: OWNER, plan: fan(names), gh: memory(names).gh, updater: quiet, dryRun: false, maxPushes: 1, now: slot(0) });
    expect(quiet.seen).toHaveLength(names.length);

    const two = ["a-repo", "b-repo"];
    const m = memory(two);
    const fp = selectUpdates(fan(two), ["a-repo"]).ready[0]?.fingerprint;
    m.prs.set("a-repo", pull(10, "a-repo", { body: `x <!-- release-train:fingerprint=${fp} -->` }));
    const up = updater();
    const r = await apply({ owner: OWNER, plan: fan(two), gh: m.gh, updater: up, dryRun: false, maxPushes: 1, now: slot(0) });
    expect(up.seen.map((u) => u.repo)).toEqual(["a-repo"]);
    expect(stateOf(r)).toEqual({ "a-repo": "updated", "b-repo": "waiting" });
  });

  it("gives each repository a turn when the first repositories need a push in each run", async () => {
    const m = memory(names);
    const p = fan(names);
    const up = updater();
    for (let n = 0; n < names.length; n++) {
      m.prs.clear();
      await apply({ owner: OWNER, plan: p, gh: m.gh, updater: up, dryRun: false, maxPushes: 1, now: slot(n) });
    }
    expect(up.seen.map((u) => u.repo).sort()).toEqual(names);
    expect(rotate(["a", "b", "c"], 4)).toEqual(["b", "c", "a"]);
    expect(rotate([], 4)).toEqual([]);
  });

  it("pushes first the open pull requests that waited longest, not only the start of the rotation", async () => {
    const m = memory(names);
    // a-repo has the newest push and e-repo the oldest. The rotation of slot 0 starts at a-repo.
    names.forEach((name, i) => {
      m.prs.set(name, pull(10 + i, name));
      m.pushed.set(name, `2026-01-0${9 - i}T00:00:00Z`);
    });
    const up = updater();
    await apply({ owner: OWNER, plan: fan(names), gh: m.gh, updater: up, dryRun: false, maxPushes: 2, now: slot(0) });
    expect(up.seen.map((u) => u.repo)).toEqual(["e-repo", "d-repo"]);
    const times: Record<string, string> = { x: "2026-01-02T00:00:00Z", z: "2026-01-01T00:00:00Z", w: "not a time" };
    // An item with no pull request, or with no time that parses, goes first in the order of the list.
    expect(longestWaitFirst(["x", "y", "z", "w"], (k) => times[k])).toEqual(["y", "w", "z", "x"]);
    expect(longestWaitFirst([], () => undefined)).toEqual([]);
    // With since, an item with no pull request waits from that time: after z and before x.
    expect(longestWaitFirst(["x", "y", "z"], (k) => times[k], "2026-01-01T12:00:00Z")).toEqual(["z", "y", "x"]);
  });

  it("keeps the place of a pull request that gets a label or an edit with no push", async () => {
    const m = memory(names);
    // e-repo has the oldest push. An edit with no push (a label, the auto-merge switch) gave it the newest updated_at.
    names.forEach((name, i) => {
      m.prs.set(name, pull(10 + i, name, { updated_at: name === "e-repo" ? "2026-02-01T00:00:00Z" : "2026-01-20T00:00:00Z" }));
      m.pushed.set(name, name === "e-repo" ? "2026-01-01T00:00:00Z" : "2026-01-05T00:00:00Z");
    });
    const up = updater();
    await apply({ owner: OWNER, plan: fan(names), gh: m.gh, updater: up, dryRun: false, maxPushes: 1, now: slot(0) });
    expect(up.seen.map((u) => u.repo)).toEqual(["e-repo"]);
    // With no readable commit, the time is updated_at. Then e-repo is the last.
    m.pushed.clear();
    up.seen.length = 0;
    await apply({ owner: OWNER, plan: fan(names), gh: m.gh, updater: up, dryRun: false, maxPushes: 1, now: slot(0) });
    expect(up.seen.map((u) => u.repo)).toEqual(["a-repo"]);
  });

  describe("and the waves", () => {
    /** mid-repo adopts @ex/base and then releases. top-repo waits for that release. The other repositories only adopt. */
    const waves = () => {
      const repos = [
        repo("base-repo", { "": { name: "@ex/base", version: "2.0.0" } }),
        repo("mid-repo", { "": { name: "@ex/mid", version: "1.0.0", dependencies: { "@ex/base": "^1.0.0" } } }, { resolved: { "": { "@ex/base": "1.0.0" } } }),
        repo("top-repo", { "": { name: "top", private: true, dependencies: { "@ex/mid": "^1.0.0" } } }, { resolved: { "": { "@ex/mid": "1.0.0" } } }),
        ...["a-repo", "b-repo", "z-repo"].map((n) => repo(n, { "": { name: n, private: true, devDependencies: { "@ex/base": "^1.0.0" } } }, { resolved: { "": { "@ex/base": "1.0.0" } } })),
      ];
      return plan(buildGraph({ owner: OWNER, repos, npm: { "@ex/base": npm("2.0.0"), "@ex/mid": npm("1.0.0") }, now: new Date("2026-01-01T00:00:00Z") }));
    };
    const all = ["mid-repo", "top-repo", "a-repo", "b-repo", "z-repo"];

    it("keeps a later wave behind the earlier wave, and pushes first the update that a later wave waits for", async () => {
      const p = waves();
      const later = selectUpdates(p).waiting.find((w) => w.repo === "top-repo");
      expect(later?.dependsOn).toContain("release:mid-repo");
      expect(selectUpdates(p).ready.every((u) => u.wave === 0)).toBe(true);
      for (let n = 0; n < 8; n++) {
        const up = once();
        const r = await apply({ owner: OWNER, plan: p, gh: memory(all).gh, updater: up, dryRun: false, maxPushes: 1, now: slot(n) });
        expect(up.pushed).toEqual(["mid-repo"]);
        const top = r.results.find((x) => x.repo === "top-repo");
        expect(top).toMatchObject({ state: "waiting" });
        expect(top).not.toHaveProperty("paced");
      }
    });

    it("does not deadlock: the limit stops no wave for good, and the later wave stays out of the count", async () => {
      const m = memory(all);
      const p = waves();
      const up = once();
      for (let n = 0; n < 4; n++) await apply({ owner: OWNER, plan: p, gh: m.gh, updater: up, dryRun: false, maxPushes: 1, now: slot(2 * n) });
      expect([...up.pushed].sort()).toEqual(["a-repo", "b-repo", "mid-repo", "z-repo"]);
    });
  });

  it("reports the same plan in a dry run, and pushes nothing", async () => {
    const two = ["a-repo", "b-repo"];
    const fp = selectUpdates(fan(names), ["a-repo"]).ready[0]?.fingerprint;
    const seed = (m: ReturnType<typeof memory>) => m.prs.set("a-repo", pull(10, "a-repo", { body: `x <!-- release-train:fingerprint=${fp} -->` }));
    const options = { owner: OWNER, plan: fan(names), maxPushes: 2, now: slot(0) };
    const dry = memory(names);
    seed(dry);
    const dryUp = once();
    const planned = await apply({ ...options, gh: dry.gh, updater: dryUp, dryRun: true });
    expect(dry.calls.every((c) => c.method === "GET")).toBe(true);
    expect(dryUp.cloned).toEqual([]);
    expect(planned.results.find((x) => x.repo === "a-repo")?.detail).toContain("keeps PR #10");
    const real = memory(names);
    seed(real);
    // The branch of a-repo has its changes, so its update pushes nothing.
    const realUp = once();
    realUp.pushed.push("a-repo");
    const done = await apply({ ...options, gh: real.gh, updater: realUp, dryRun: false });
    const asPlanned = (s: string): string => (s === "waiting" ? "waiting" : "planned");
    expect(Object.fromEntries(planned.results.map((x) => [x.repo, x.state]))).toEqual(Object.fromEntries(done.results.map((x) => [x.repo, asPlanned(x.state)])));
    expect(planned.results.filter((x) => x.state === "waiting").map((x) => x.repo)).toEqual(names.filter((n) => !two.includes(n) && n !== "c-repo"));
  });

  it("keeps each private name out of the report of a repository that waits", async () => {
    const lines: string[] = [];
    const list = ["a-repo", "secret-repo"];
    const r = await apply({ owner: OWNER, plan: fan(list, ["secret-repo"]), gh: memory(list).gh, updater: once(), dryRun: false, maxPushes: 0, now: slot(0), log: (l) => lines.push(l) });
    const pub = publicReport(r, "key");
    const text = `${lines.join("\n")}\n${applySummary(pub)}\n${JSON.stringify(pub)}`;
    expect(text).not.toContain("secret");
    expect(applySummary(pub)).toContain("Waiting for a later run: 2. Public: a-repo. Count of private repositories: 1.");
  });
});

describe("an urgent update", () => {
  /** y-repo and z-repo adopt the fix of @ex/fix. They are the last of the plan. a-repo and b-repo adopt another package. */
  const mixed = (priv: readonly string[] = []) => {
    const dev = (n: string, dep: string) => repo(n, { "": { name: n, private: true, devDependencies: { [dep]: "^1.0.0" } } }, { private: priv.includes(n), resolved: { "": { [dep]: "1.0.0" } } });
    const repos = [
      repo("fix-repo", { "": { name: "@ex/fix", version: "1.0.1" } }),
      repo("other-repo", { "": { name: "@ex/other", version: "1.1.0" } }),
      dev("a-repo", "@ex/other"),
      dev("b-repo", "@ex/other"),
      dev("y-repo", "@ex/fix"),
      dev("z-repo", "@ex/fix"),
    ];
    return plan(buildGraph({ owner: OWNER, repos, npm: { "@ex/fix": npm("1.0.1"), "@ex/other": npm("1.1.0") }, now: new Date("2026-01-01T00:00:00Z") }));
  };
  const all = ["a-repo", "b-repo", "y-repo", "z-repo"];
  const urgent = ["@ex/fix"];

  it("passes the limit of pushes, and does not use the count", async () => {
    const up = once();
    const r = await apply({ owner: OWNER, plan: mixed(), gh: memory(all).gh, updater: up, dryRun: false, maxPushes: 1, urgent, now: slot(0) });
    expect(up.pushed).toEqual(["y-repo", "z-repo", "a-repo"]);
    expect(stateOf(r)).toEqual({ "y-repo": "opened", "z-repo": "opened", "a-repo": "opened", "b-repo": "waiting" });
  });

  it("lets an update of another package wait, even with no room in the limit", async () => {
    const up = once();
    const r = await apply({ owner: OWNER, plan: mixed(), gh: memory(all).gh, updater: up, dryRun: false, maxPushes: 0, urgent, now: slot(0) });
    expect(up.pushed).toEqual(["y-repo", "z-repo"]);
    expect(r.results.find((x) => x.repo === "a-repo")).toMatchObject({ state: "waiting", paced: true });
    expect(r.results.find((x) => x.repo === "a-repo")).not.toHaveProperty("urgent");
    expect(r.results.find((x) => x.repo === "y-repo")).toMatchObject({ urgent: true });
    expect(r.results.find((x) => x.repo === "y-repo")).not.toHaveProperty("paced");
    expect(applySummary(r)).toContain("Urgent: 2 (opened 2). Public: y-repo, z-repo. Count of private repositories: 0.");
    expect(applySummary(r)).toContain("Waiting for a later run: 2. Public: a-repo, b-repo.");
  });

  it("goes first in each slot of the rotation", async () => {
    for (let n = 0; n < 8; n++) {
      const up = once();
      await apply({ owner: OWNER, plan: mixed(), gh: memory(all).gh, updater: up, dryRun: false, maxPushes: 0, urgent, now: slot(n) });
      expect([...up.cloned].sort()).toEqual(["y-repo", "z-repo"]);
      const order = once();
      await apply({ owner: OWNER, plan: mixed(), gh: memory(all).gh, updater: order, dryRun: false, maxPushes: 9, urgent, now: slot(n) });
      expect([...order.cloned.slice(0, 2)].sort()).toEqual(["y-repo", "z-repo"]);
    }
  });

  it("keeps the age rule: a young version waits, and the run reports it", async () => {
    const up = updater({ status: "young", sha: null, young: [{ dep: "@ex/fix", version: "1.0.1", readyAt: "2026-01-02T00:00:00.000Z" }] });
    const r = await apply({ owner: OWNER, plan: mixed(), gh: memory(all).gh, updater: up, dryRun: false, maxPushes: 0, urgent, now: slot(0) });
    const y = r.results.find((x) => x.repo === "y-repo");
    expect(y).toMatchObject({ state: "waiting", urgent: true });
    expect(y?.detail).toContain("minimumReleaseAge");
    expect(y?.detail).toContain("2026-01-02T00:00:00.000Z");
    expect(applySummary(r)).toContain("Urgent: 2 (waiting 2).");
  });

  it("names only the urgent packages to the updater", async () => {
    const seen: (string[] | undefined)[] = [];
    const up: Updater = { async update(u) { seen.push(u.urgentDeps); return { status: "pushed", sha: "newsha", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null }; } };
    await apply({ owner: OWNER, plan: mixed(), gh: memory(all).gh, updater: up, dryRun: false, maxPushes: 9, urgent, now: slot(0) });
    expect(seen.filter(Boolean)).toEqual([["@ex/fix"], ["@ex/fix"]]);
    expect(seen.filter((names) => names === undefined).length).toBeGreaterThan(0);
  });

  it("tells a reader the exact versions that pass the age rule", () => {
    const u = selectUpdates(mixed(), ["y-repo"]).ready[0];
    if (!u) throw new Error("no update");
    expect(prBody(u, { changes: [], unresolved: [], tool: "pnpm 12.0.0", young: [], urgentAge: ["fix@1.0.1"] })).toContain("gets each exact version: `fix@1.0.1`.");
  });

  it("keeps the closed pull request of a person", async () => {
    const fp = selectUpdates(mixed(), ["y-repo"]).ready[0]?.fingerprint;
    const body = `x <!-- release-train:fingerprint=${fp} -->`;
    const { gh } = server({
      [`GET ${base}/y-repo`]: meta,
      [`GET ${base}/y-repo/pulls`]: (_b, u) => [200, u.searchParams.get("state") === "open" ? [] : [pull(4, "y-repo", { state: "closed", merged_at: null, body })]],
    });
    const up = once();
    const r = await apply({ owner: OWNER, plan: mixed(), gh, updater: up, dryRun: false, only: ["y-repo"], urgent, maxPushes: 0, now: slot(0) });
    expect(r.results[0]).toMatchObject({ state: "declined", urgent: true });
    expect(up.cloned).toEqual([]);
  });

  it("keeps the wave order: an update that waits for a release stays out, and the run counts the name", async () => {
    const repos = [
      repo("base-repo", { "": { name: "@ex/base", version: "2.0.0" } }),
      repo("mid-repo", { "": { name: "@ex/mid", version: "1.0.0", dependencies: { "@ex/base": "^1.0.0" } } }, { resolved: { "": { "@ex/base": "1.0.0" } } }),
      repo("top-repo", { "": { name: "top", private: true, dependencies: { "@ex/mid": "^1.0.0" } } }, { resolved: { "": { "@ex/mid": "1.0.0" } } }),
    ];
    const p = plan(buildGraph({ owner: OWNER, repos, npm: { "@ex/base": npm("2.0.0"), "@ex/mid": npm("1.0.0") }, now: new Date("2026-01-01T00:00:00Z") }));
    const up = once();
    const r = await apply({ owner: OWNER, plan: p, gh: memory(["mid-repo", "top-repo"]).gh, updater: up, dryRun: false, maxPushes: 0, urgent: ["@ex/mid"], now: slot(0) });
    expect(up.cloned).toEqual([]);
    expect(r.results.find((x) => x.repo === "top-repo")).toMatchObject({ state: "waiting" });
    expect(r.urgentUnused).toBe(1);
    expect(applySummary(r)).toContain("Urgent names with no ready update: 1.");
  });

  it("pushes nothing in a dry run, and reports the same plan", async () => {
    const m = memory(all);
    const up = once();
    const r = await apply({ owner: OWNER, plan: mixed(), gh: m.gh, updater: up, dryRun: true, maxPushes: 1, urgent, now: slot(0) });
    expect(m.calls.every((c) => c.method === "GET")).toBe(true);
    expect(up.cloned).toEqual([]);
    expect(stateOf(r)).toEqual({ "y-repo": "planned", "z-repo": "planned", "a-repo": "planned", "b-repo": "waiting" });
    expect(r.results.find((x) => x.repo === "y-repo")).toMatchObject({ urgent: true });
  });

  it("gives a private repository only as a count", async () => {
    const lines: string[] = [];
    const list = ["a-repo", "b-repo", "secret-repo", "z-repo"];
    const repos = mixed(["y-repo"]);
    const text = JSON.stringify(repos).replaceAll("y-repo", "secret-repo");
    const r = await apply({ owner: OWNER, plan: JSON.parse(text) as typeof repos, gh: memory(list).gh, updater: once(), dryRun: false, maxPushes: 0, urgent, now: slot(0), log: (l) => lines.push(l) });
    const pub = publicReport(r, "key");
    const out = `${lines.join("\n")}\n${applySummary(pub)}\n${JSON.stringify(pub)}`;
    expect(out).not.toContain("secret");
    expect(applySummary(pub)).toContain("Urgent: 2 (opened 2). Public: z-repo. Count of private repositories: 1.");
  });

  it("ignores the name of a private package, and the report has only a count", async () => {
    const repos = [
      repo("hidden-repo", { "": { name: "@ex/hidden", version: "1.1.0" } }, { private: true }),
      repo("a-repo", { "": { name: "a-repo", private: true, devDependencies: { "@ex/hidden": "^1.0.0" } } }, { resolved: { "": { "@ex/hidden": "1.0.0" } } }),
    ];
    const p = plan(buildGraph({ owner: OWNER, repos, npm: { "@ex/hidden": npm("1.1.0") }, now: new Date("2026-01-01T00:00:00Z") }));
    const up = once();
    const r = await apply({ owner: OWNER, plan: p, gh: memory(["a-repo"]).gh, updater: up, dryRun: false, maxPushes: 0, urgent: ["@ex/hidden"], now: slot(0) });
    expect(up.cloned).toEqual([]);
    expect(r.results.find((x) => x.repo === "a-repo")).toMatchObject({ state: "waiting", paced: true });
    expect(r.urgentUnused).toBe(1);
    expect(`${applySummary(publicReport(r, "key"))}\n${JSON.stringify(publicReport(r, "key"))}`).not.toContain("hidden");
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

  it("counts only the newest run of each workflow, so a cancelled older run of the same commit does not fail it", () => {
    const runs = [
      { status: "completed", conclusion: "cancelled", check_suite: { id: 1 } },
      { status: "completed", conclusion: "success", check_suite: { id: 2 } },
      { status: "completed", conclusion: "success", check_suite: { id: 3 } },
      { status: "completed", conclusion: "success", check_suite: null },
    ];
    const workflows = [
      { workflow_id: 10, check_suite_id: 1, created_at: "2026-11-02T00:33:00Z" },
      { workflow_id: 10, check_suite_id: 2, created_at: "2026-11-02T00:34:00Z" },
      { workflow_id: 11, check_suite_id: 3, created_at: "2026-11-02T00:33:00Z" },
    ];
    expect(latestRuns(runs, workflows).map((r) => r.check_suite?.id ?? null)).toEqual([2, 3, null]);
    expect(ciState(latestRuns(runs, workflows), null)).toBe("green");
    // A newest run that failed still fails
    const later = [...workflows, { workflow_id: 11, check_suite_id: 4, created_at: "2026-11-02T00:35:00Z" }];
    expect(ciState(latestRuns([...runs, { status: "completed", conclusion: "failure", check_suite: { id: 4 } }], later), null)).toBe("failed");
    // Without the workflow runs, each check counts
    expect(ciState(latestRuns(runs, []), null)).toBe("failed");
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

  it("edits only own keys, so a name such as __proto__ does not change Object.prototype", () => {
    // JSON.parse makes "__proto__" an own key, so the guard of the names is necessary as well as the own-key check.
    const text = '{\n  "dependencies": {\n    "__proto__": "^1.0.0",\n    "@ex/core": "^1.0.0"\n  }\n}\n';
    const edits = [
      { type: "dependencies", dep: "__proto__", range: "^1.0.0", newRange: "^2.0.0" },
      { type: "__proto__", dep: "toString", range: "^1.0.0", newRange: "^2.0.0" },
      { type: "dependencies", dep: "constructor", range: "^1.0.0", newRange: "^2.0.0" },
    ];
    const out = editManifest(text, edits);
    expect(out.failed).toEqual(["__proto__", "toString", "constructor"]);
    expect(out.text).toBe(text);
    expect(({} as Record<string, unknown>)["^2.0.0"]).toBeUndefined();
    expect(typeof Object.prototype.toString).toBe("function");
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

describe("gitUpdater and conventions fix", () => {
  /** The update of lib-repo, with conventions at the version `to` in place of @ex/util. */
  const update = (to: string): RepoUpdate => {
    const u = selectUpdates(fixture(), ["lib-repo"]).ready[0] as RepoUpdate;
    return { ...u, lockKind: "pnpm" as const, items: u.items.filter((i) => i.dep === "@ex/util").map((i) => ({ ...i, dep: CONVENTIONS, to })) };
  };
  /**
   * `typecheck` gives the exit code of the typecheck script from the text of tsconfig.test.json. Without it, the
   * repository has no typecheck script. The fix writes "fixed" into tsconfig.test.json, and the clone has "old".
   */
  const start = async (u: RepoUpdate, typecheck?: (config: string) => number, prettier = false) => {
    const cmds: string[] = [];
    const trees: string[] = [];
    const fixEnv: NodeJS.ProcessEnv[] = [];
    let message = "";
    const run: RunFn = async (cmd, args, opts) => {
      cmds.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "clone") {
        const scripts = typecheck === undefined ? {} : { scripts: { typecheck: "tsc -p tsconfig.test.json" } };
        const devDependencies = { [CONVENTIONS]: "^0.8.0", ...(prettier ? { prettier: "^3.0.0" } : {}) };
        writeFileSync(join(opts.cwd, "package.json"), `${JSON.stringify({ name: "x", ...scripts, devDependencies }, null, 2)}\n`);
        writeFileSync(join(opts.cwd, "tsconfig.test.json"), "old");
      }
      if (cmd === "git" && args[0] === "write-tree") {
        trees.push(readFileSync(join(opts.cwd, "tsconfig.test.json"), "utf8"));
        return { code: 0, stdout: `tree${String(trees.length)}\n`, stderr: "" };
      }
      if (cmd === "git" && args[0] === "show") {
        const [tree, file] = (args[1] ?? "").split(":");
        const text = trees[Number((tree ?? "").slice(4)) - 1];
        return file === "tsconfig.test.json" && text !== undefined ? { code: 0, stdout: text, stderr: "" } : { code: 128, stdout: "", stderr: "no such path" };
      }
      if (cmd === "pnpm" && args[0] === "run" && args[1] === "typecheck") {
        const code = typecheck?.(readFileSync(join(opts.cwd, "tsconfig.test.json"), "utf8")) ?? 0;
        const stdout = code === 0 ? "" : "vitest.config.ts(4,16): error TS9037: Default exports can't be inferred with --isolatedDeclarations.\n";
        return { code, stdout, stderr: "" };
      }
      // gone.ts is a file that the fix removed
      if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only" && args.length === 2) return { code: 0, stdout: "package.json\npnpm-lock.yaml\nvitest.config.ts\ngone.ts\n", stderr: "" };
      if (cmd === "git" && args.includes("commit")) message = args[args.indexOf("-m") + 1] ?? "";
      // The branch of the train does not exist yet
      if (cmd === "git" && args[0] === "fetch") return { code: 128, stdout: "", stderr: "no such ref" };
      if (cmd === "pnpm" && args[0] === "install") {
        const to = u.items[0]?.to ?? "";
        writeFileSync(join(opts.cwd, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      '${CONVENTIONS}':\n        specifier: ^0.8.0\n        version: ${to}\n`);
      }
      if (cmd === "pnpm" && args[0] === "dlx") {
        fixEnv.push(opts.env ?? {});
        if (typecheck !== undefined) {
          writeFileSync(join(opts.cwd, "tsconfig.test.json"), "fixed");
          writeFileSync(join(opts.cwd, "vitest.config.ts"), "export default {};\n");
          return { code: 0, stdout: JSON.stringify({ changed: ["tsconfig.test.json", "vitest.config.ts"], passes: 2, failed: false }), stderr: "" };
        }
        return { code: 1, stdout: JSON.stringify({ changed: [".github/workflows/ci.yml", "vitest.config.ts"], passes: 2, failed: true }), stderr: "" };
      }
      const stdout = cmd === "pnpm" && args[0] === "--version" ? "12.10.1\n" : cmd === "git" && args[0] === "status" ? " M package.json\n" : "";
      return { code: 0, stdout, stderr: "" };
    };
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run, fetch: async () => new Response("{}", { status: 200 }) });
    const result = await up.update(u, { defaultBranch: "main", rebuild: false });
    return { cmds, fixEnv, message, result };
  };

  it("starts the fix of the target version with the repository of the clone, and keeps its files in the commit", async () => {
    const { cmds, fixEnv, message, result } = await start(update("0.8.2"));
    // typed-files needs the typescript of the repository: an install with no scripts, just before the fix
    const fix = cmds.indexOf(`pnpm dlx ${CONVENTIONS}@0.8.2 fix --json`);
    expect(fix).toBeGreaterThan(0);
    expect(cmds.slice(0, fix).filter((c) => c.startsWith("pnpm")).at(-1)).toBe("pnpm install --frozen-lockfile --ignore-scripts");
    expect(fixEnv[0]?.["GITHUB_REPOSITORY"]).toBe(`${OWNER}/lib-repo`);
    expect(fixEnv[0]).not.toHaveProperty("GITHUB_STEP_SUMMARY");
    expect(Object.keys(fixEnv[0] ?? {}).filter((key) => key.startsWith("GIT_CONFIG_"))).toEqual([]);
    expect(result).toMatchObject({ status: "pushed", fixed: [".github/workflows/ci.yml", "vitest.config.ts"] });
    expect(message).toContain("- conventions fix: .github/workflows/ci.yml, vitest.config.ts");
    // A new file of the fix is not tracked, so `git add -u` does not stage it: the train stages each file of the fix by name
    const commit = cmds.findIndex((c) => c.includes(" commit "));
    expect(cmds.slice(0, commit)).toContain("git add -A -- .github/workflows/ci.yml vitest.config.ts");
    expect(prBody(update("0.8.2"), result)).toContain("## Conventions fix");
  });

  it("removes a fix when the typecheck fails with it and passes without it", async () => {
    const { cmds, message, result } = await start(update("0.8.2"), (config) => (config === "fixed" ? 2 : 0));
    expect(cmds.filter((c) => c === "pnpm run typecheck")).toHaveLength(2);
    expect(result).not.toHaveProperty("fixed");
    expect(result).toMatchObject({ status: "pushed", reverted: ["tsconfig.test.json", "vitest.config.ts"] });
    expect(result.fixError).toContain("TS9037");
    expect(message).toContain("- conventions fix removed, it broke typecheck: tsconfig.test.json, vitest.config.ts");
    const body = prBody(update("0.8.2"), result);
    expect(body).toContain("## Conventions fix removed");
    expect(body).toContain("error TS9037");
  });

  it("keeps a fix when the typecheck passes with it, or fails also without it", async () => {
    const passes = await start(update("0.8.2"), () => 0);
    expect(passes.cmds.filter((c) => c === "pnpm run typecheck")).toHaveLength(1);
    expect(passes.result).toMatchObject({ fixed: ["tsconfig.test.json", "vitest.config.ts"] });
    const fails = await start(update("0.8.2"), () => 2);
    expect(fails.cmds.filter((c) => c === "pnpm run typecheck")).toHaveLength(2);
    expect(fails.result).toMatchObject({ fixed: ["tsconfig.test.json", "vitest.config.ts"] });
    expect(fails.result).not.toHaveProperty("reverted");
    // The fix is back: the second snapshot restored it
    expect(fails.cmds.filter((c) => c.startsWith("git show tree2:"))).toHaveLength(2);
  });

  it("gives the changed files the format of a repository with Prettier, but not the lockfile", async () => {
    const { cmds } = await start(update("0.8.2"), () => 0, true);
    const format = cmds.filter((c) => c.startsWith("pnpm exec prettier"));
    expect(format).toEqual(["pnpm exec prettier --write --ignore-unknown -- package.json vitest.config.ts"]);
    expect(cmds.indexOf(format[0] ?? "")).toBeGreaterThan(cmds.indexOf(`pnpm dlx ${CONVENTIONS}@0.8.2 fix --json`));
    const without = await start(update("0.8.2"), () => 0);
    expect(without.cmds.some((c) => c.includes("prettier"))).toBe(false);
  });

  it("does not start the fix for a version before the command", async () => {
    const { cmds, result } = await start(update("0.8.1"));
    expect(cmds.some((c) => c.startsWith("pnpm dlx"))).toBe(false);
    expect(result).not.toHaveProperty("fixed");
    expect(prBody(update("0.8.1"), result)).not.toContain("## Conventions fix");
  });
});

describe("gitUpdater and the first API report", () => {
  const update = (dep: string = CONVENTIONS): RepoUpdate => {
    const u = selectUpdates(fixture(), ["lib-repo"]).ready[0] as RepoUpdate;
    return { ...u, lockKind: "pnpm" as const, items: u.items.filter((i) => i.dep === "@ex/util").map((i) => ({ ...i, dep, to: "0.29.0" })) };
  };
  const REPORT = "packages/a/test/api/public-api.txt";

  /** The clone has the script `start`. The fix adds `check:api` and writes LICENSE. The step `broken` fails. */
  const start = async (options: { had?: boolean; script?: string; broken?: string; config?: string; noBuild?: boolean; noReport?: string; tool?: boolean } = {}) => {
    const dep = options.tool === true ? API_REPORT_PACKAGE : CONVENTIONS;
    const cmds: string[] = [];
    const trees: { manifest: string; lock: string }[] = [];
    let message = "";
    let manifest = "";
    let reportStayed = false;
    const run: RunFn = async (cmd, args, opts) => {
      const line = `${cmd} ${args.join(" ")}`;
      cmds.push(line);
      const file = join(opts.cwd, "package.json");
      if (cmd === "git" && args[0] === "clone") {
        const apiReport = options.config === undefined ? {} : { apiReport: { report: options.config } };
        const scripts = { ...(options.noBuild === true ? {} : { build: "tsc" }), ...(options.had === true ? { "check:api": options.script ?? "api-report check" } : {}) };
        writeFileSync(file, `${JSON.stringify({ name: "x", scripts, ...apiReport, devDependencies: { [dep]: "^0.8.0" } }, null, 2)}\n`);
      }
      if (cmd === "git" && args[0] === "write-tree") {
        trees.push({ manifest: readFileSync(file, "utf8"), lock: readFileSync(join(opts.cwd, "pnpm-lock.yaml"), "utf8") });
        return { code: 0, stdout: `tree${String(trees.length)}\n`, stderr: "" };
      }
      if (cmd === "git" && args[0] === "show") {
        const [tree, name] = (args[1] ?? "").split(":");
        const saved = trees[Number((tree ?? "").slice(4)) - 1];
        const text = name === "package.json" ? saved?.manifest : name === "pnpm-lock.yaml" ? saved?.lock : undefined;
        return text !== undefined ? { code: 0, stdout: text, stderr: "" } : { code: 128, stdout: "", stderr: "no such path" };
      }
      if (cmd === "git" && args[0] === "ls-files") {
        const made = [REPORT, "packages/a/api.md", "LICENSE"].filter((name) => existsSync(join(opts.cwd, name)));
        return { code: 0, stdout: made.map((name) => `${name}\n`).join(""), stderr: "" };
      }
      if (cmd === "git" && args[0] === "fetch") return { code: 128, stdout: "", stderr: "no such ref" };
      if (cmd === "git" && args.includes("commit")) {
        message = args[args.indexOf("-m") + 1] ?? "";
        manifest = readFileSync(file, "utf8");
        reportStayed = existsSync(join(opts.cwd, REPORT));
      }
      if (cmd === "pnpm" && args[0] === "dlx") {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { scripts: Record<string, string> };
        parsed.scripts["check:api"] = "api-report check";
        writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
        writeFileSync(join(opts.cwd, "LICENSE"), "MIT\n");
        return { code: 0, stdout: JSON.stringify({ changed: ["package.json", "LICENSE"], passes: 2, failed: false }), stderr: "" };
      }
      if (options.broken !== undefined && line.startsWith(options.broken)) return { code: 1, stdout: "", stderr: "src/a.ts(1,1): error TS2307: Cannot find module.\n" };
      if (options.noReport !== undefined && line === "pnpm exec api-report update") return { code: 1, stdout: `Errors:\n  packages/a: ${options.noReport}\n\nNext line.\n`, stderr: "" };
      if (cmd === "pnpm" && args[0] === "exec" && args[1] === "api-report") {
        mkdirSync(join(opts.cwd, "packages/a/test/api"), { recursive: true });
        writeFileSync(join(opts.cwd, REPORT), "report\n");
        writeFileSync(join(opts.cwd, "packages/a/api.md"), "report\n");
      }
      if (cmd === "pnpm" && args[0] === "install") {
        const to = update().items[0]?.to ?? "";
        writeFileSync(join(opts.cwd, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      '${dep}':\n        specifier: ^0.8.0\n        version: ${to}\n`);
      }
      const stdout = cmd === "pnpm" && args[0] === "--version" ? "12.10.1\n" : cmd === "git" && args[0] === "status" ? " M package.json\n" : "";
      return { code: 0, stdout, stderr: "" };
    };
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run, fetch: async () => new Response("{}", { status: 200 }) });
    const result = await up.update(update(dep), { defaultBranch: "main", rebuild: false });
    return { cmds, message, result, manifest, reportStayed };
  };

  it("builds and writes the report in the commit of the fix that adds the script", async () => {
    const { cmds, message, result, manifest } = await start();
    const fix = cmds.indexOf(`pnpm dlx ${CONVENTIONS}@0.29.0 fix --json`);
    const after = cmds.slice(fix + 1);
    const order = ["pnpm install --lockfile-only", "pnpm install --frozen-lockfile --ignore-scripts", "pnpm run build", "pnpm exec api-report update"].map((c) => after.indexOf(c));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(result).toMatchObject({ status: "pushed", fixed: ["package.json", "LICENSE", REPORT] });
    expect(message).toContain(`- conventions fix: package.json, LICENSE, ${REPORT}`);
    expect(cmds.slice(0, cmds.findIndex((c) => c.includes(" commit ")))).toContain(`git add -A -- package.json LICENSE ${REPORT}`);
    expect(manifest).toContain("check:api");
  });

  it("builds each package when the root has no script build, as CI does", async () => {
    const { cmds, result } = await start({ noBuild: true });
    const built = cmds.indexOf("pnpm -r --if-present run build");
    expect(built).toBeGreaterThan(-1);
    expect(cmds).not.toContain("pnpm run build");
    expect(built).toBeLessThan(cmds.indexOf("pnpm exec api-report update"));
    expect(result).toMatchObject({ status: "pushed", fixed: ["package.json", "LICENSE", REPORT] });
  });

  it("gives the reason of the report in the indented lines below the heading", async () => {
    const { result } = await start({ noReport: ".: build/index.d.ts is missing. Build the package first." });
    expect(result.fixError).toBe("Errors:\n  packages/a: .: build/index.d.ts is missing. Build the package first.");
    expect(prBody(update(), result)).toContain("is missing. Build the package first.");
  });

  it("uses the report file that the repository names", async () => {
    const { result } = await start({ config: "./api.md" });
    expect(result).toMatchObject({ fixed: ["package.json", "LICENSE", "packages/a/api.md"] });
  });

  it("writes the reports in the commit of an update that moves api-report", async () => {
    const { cmds, message, result } = await start({ had: true, tool: true });
    const order = ["pnpm install --lockfile-only", "pnpm install --frozen-lockfile --ignore-scripts", "pnpm run build", "pnpm exec api-report update"].map((c) => cmds.lastIndexOf(c));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(result).toMatchObject({ status: "pushed", apiReports: [REPORT] });
    expect(result.fixed).toBeUndefined();
    expect(message).toContain("- api-report update: 1 report");
    expect(cmds.slice(0, cmds.findIndex((c) => c.includes(" commit ")))).toContain(`git add -A -- ${REPORT}`);
    expect(prBody(update(API_REPORT_PACKAGE), result)).toContain("## API reports\n");
  });

  it("writes the reports of the folders that the script check:api names", async () => {
    // Logger 2026-11-06: the workspace names only site, and the script is `api-report check .`
    const { cmds, result } = await start({ had: true, tool: true, script: "api-report check ." });
    expect(cmds).toContain("pnpm exec api-report update .");
    expect(cmds).not.toContain("pnpm exec api-report update");
    expect(result).toMatchObject({ status: "pushed", apiReports: [REPORT] });
  });

  it("keeps the update and tells the step when a step of the reports fails", async () => {
    for (const broken of ["pnpm run build", "pnpm exec api-report update"]) {
      const { message, result, manifest } = await start({ had: true, tool: true, broken });
      expect(result).toMatchObject({ status: "pushed", apiReportStep: broken });
      expect(result.apiReportError).toContain("TS2307");
      expect(result.apiReports).toBeUndefined();
      expect(message).toContain(`- api-report update did not finish, it failed at ${broken}`);
      expect(manifest).toContain(API_REPORT_PACKAGE);
      expect(prBody(update(API_REPORT_PACKAGE), result)).toContain("## API reports not updated");
    }
  });

  it("does not start api-report update when the repository has no script", async () => {
    const { cmds, result } = await start({ tool: true });
    expect(cmds).not.toContain("pnpm exec api-report update");
    expect(result.apiReports).toBeUndefined();
  });

  it("writes no report for a repository that already has the script", async () => {
    const { cmds, result } = await start({ had: true });
    expect(cmds).not.toContain("pnpm exec api-report update");
    expect(cmds).not.toContain("pnpm run build");
    expect(result).toMatchObject({ fixed: ["package.json", "LICENSE"] });
  });

  it("removes the script and keeps the other fixes when a step of the report fails", async () => {
    for (const broken of ["pnpm run build", "pnpm exec api-report update"]) {
      const { cmds, message, result, manifest, reportStayed } = await start({ broken });
      expect(cmds).toContain(broken);
      expect(result).toMatchObject({ status: "pushed", fixed: ["LICENSE"], reverted: ["package.json"] });
      expect(result.fixStep).toContain(broken);
      expect(result.fixError).toContain("TS2307");
      expect(message).toContain(`- conventions fix removed, it broke the first API report (${broken}): package.json`);
      expect(manifest).not.toContain("check:api");
      expect(reportStayed).toBe(false);
      const body = prBody(update(), result);
      expect(body).toContain("## Conventions fix removed");
      expect(body).toContain("until a person adds the script");
    }
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

describe("apiReportUpdateArgs", () => {
  it("gives update with the folders and options of the check", () => {
    expect(apiReportUpdateArgs("api-report check")).toEqual(["update"]);
    expect(apiReportUpdateArgs("api-report check .")).toEqual(["update", "."]);
    expect(apiReportUpdateArgs("  api-report check packages/a packages/b  ")).toEqual(["update", "packages/a", "packages/b"]);
    expect(apiReportUpdateArgs("api-report check --packages=packages/* !packages/site")).toEqual(["update", "--packages=packages/*", "!packages/site"]);
  });

  it("gives update alone for each other form of the script", () => {
    for (const script of [undefined, "", "pnpm -r run check:api", "api-report check . && tsc", "api-report check \"a b\"", "api-report update .", "node scripts/api.ts check"]) {
      expect(apiReportUpdateArgs(script)).toEqual(["update"]);
    }
  });
});
