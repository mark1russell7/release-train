// All repository and package names in these tests are made up.
import { describe, expect, it } from "vitest";
import { TRAIN_BRANCH, TRAIN_LABEL, apply, applySummary, fingerprint, prBody, publicReport, selectUpdates } from "./apply.ts";
import type { RepoUpdate, Updater } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { gitHub } from "./github.ts";
import { buildGraph } from "./graph.ts";
import { plan } from "./plan.ts";
import type { Manifest, NpmInfo, RepoSnapshot, Resolved } from "./types.ts";

const OWNER = "example-owner";
const npm = (latest: string): NpmInfo => ({ exists: true, latest });

function snap(name: string, manifests: Record<string, Manifest>, opts: { private?: boolean; resolved?: Resolved } = {}): RepoSnapshot {
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

const planOf = (repos: RepoSnapshot[], registry: Record<string, NpmInfo>) =>
  plan(buildGraph({ owner: OWNER, repos, npm: registry, now: new Date("2026-01-01T00:00:00Z") }));

const update = (s: ReturnType<typeof selectUpdates>, repo: string) => s.ready.find((u) => u.repo === repo) as RepoUpdate;
const depsOf = (u: RepoUpdate) => [...new Set(u.items.map((i) => i.dep))].sort();

/** One repository had 36 of 40 items ready: its other 4 items wait for a release of another repository. */
function mixed(opts: { released?: boolean; private?: boolean } = {}) {
  const ready = Array.from({ length: 36 }, (_, i) => `@ex/ready${i}`);
  const late = Array.from({ length: 4 }, (_, i) => `@ex/late${i}`);
  const all = [...ready, ...late];
  const repos = [
    snap("ready-repo", Object.fromEntries(ready.map((n) => [`packages/${n.slice(4)}`, { name: n, version: "1.1.0" }]))),
    snap("late-repo", Object.fromEntries(late.map((n) => [`packages/${n.slice(4)}`, { name: n, version: "2.0.0" }]))),
    snap(
      "big-repo",
      { "": { name: "big-app", private: true, dependencies: Object.fromEntries(all.map((n) => [n, "^1.0.0"])) } },
      { private: opts.private ?? true, resolved: { "": Object.fromEntries(all.map((n) => [n, "1.0.0"])) } },
    ),
  ];
  const registry = Object.fromEntries([...ready.map((n) => [n, npm("1.1.0")]), ...late.map((n) => [n, npm(opts.released ? "2.0.0" : "1.0.0")])]);
  return planOf(repos, registry as Record<string, NpmInfo>);
}

describe("a repository with ready items and items that wait for a release", () => {
  it("sends the ready items now and keeps the other items for a later run", () => {
    const p = mixed();
    expect(p.actions.find((a) => a.id === "update:big-repo")?.dependsOn).toEqual(["release:late-repo"]);
    const s = selectUpdates(p);
    const u = update(s, "big-repo");
    expect(u.items).toHaveLength(36);
    expect(u.items.every((i) => i.dep.startsWith("@ex/ready") && i.to === "1.1.0")).toBe(true);
    expect(u.held).toEqual({ items: 4, deps: ["@ex/late0", "@ex/late1", "@ex/late2", "@ex/late3"] });
    expect(s.waiting.filter((w) => w.repo === "big-repo")).toEqual([]);
  });

  it("describes only the items that go, so the fingerprint, the kind and the wave fit the partial update", () => {
    const u = update(selectUpdates(mixed()), "big-repo");
    expect(u.fingerprint).toBe(fingerprint(u.items));
    expect(u.kind).toBe("adopt-in-range");
    expect(u.wave).toBe(0);
    expect(u.why).toBe("Update the lockfile of big-repo for 36 packages, then merge when CI is green.");
  });

  it("gives a whole update when npm has each target", () => {
    const s = selectUpdates(mixed({ released: true }));
    const u = update(s, "big-repo");
    expect(u.items).toHaveLength(40);
    expect(u).not.toHaveProperty("held");
    expect(u.kind).toBe("adopt-breaking");
  });

  it("keeps the plan: the action stays one action with all its items and its wait", () => {
    const a = mixed().actions.find((x) => x.id === "update:big-repo");
    expect(a?.items).toHaveLength(40);
    expect(a?.wave).toBe(1);
    expect(mixed().actions.filter((x) => x.repo === "big-repo")).toHaveLength(1);
  });
});

/** An app that uses @ex/host, @ex/plug and @ex/free. @ex/plug and @ex/host are one peer set. */
function peers(lateName: "@ex/host" | "@ex/plug", extra: RepoSnapshot[] = []) {
  const repos = [
    snap("host-repo", { "": { name: "@ex/host", version: "1.2.0" } }),
    snap("plug-repo", { "": { name: "@ex/plug", version: "1.2.0", peerDependencies: { "@ex/host": "^1.0.0" } } }, { resolved: { "": { "@ex/host": "1.2.0" } } }),
    snap("free-repo", { "": { name: "@ex/free", version: "1.2.0" } }),
    snap("app-repo", { "": { name: "app", private: true, dependencies: { "@ex/host": "^1.0.0", "@ex/plug": "^1.0.0", "@ex/free": "^1.0.0" } } }, {
      private: true,
      resolved: { "": { "@ex/host": "1.0.0", "@ex/plug": "1.0.0", "@ex/free": "1.0.0" } },
    }),
    ...extra,
  ];
  const on = (n: string): NpmInfo => npm(n === lateName ? "1.1.0" : "1.2.0");
  return planOf(repos, { "@ex/host": on("@ex/host"), "@ex/plug": on("@ex/plug"), "@ex/free": on("@ex/free") });
}

describe("items that must move together", () => {
  it("keeps a ready item with the host of its peer set", () => {
    const u = update(selectUpdates(peers("@ex/host")), "app-repo");
    expect(depsOf(u)).toEqual(["@ex/free"]);
    expect(u.held).toEqual({ items: 2, deps: ["@ex/host", "@ex/plug"] });
  });

  it("keeps a ready host with the plugin of its peer set, in the other direction too", () => {
    const u = update(selectUpdates(peers("@ex/plug")), "app-repo");
    expect(depsOf(u)).toEqual(["@ex/free"]);
    expect(u.held?.deps).toEqual(["@ex/host", "@ex/plug"]);
  });

  it("does not join two packages through a peer range of a private app", () => {
    const shell = snap("shell-repo", { "": { name: "shell", private: true, peerDependencies: { "@ex/host": "^1.2.0", "@ex/free": "^1.2.0" } } }, {
      resolved: { "": { "@ex/host": "1.2.0", "@ex/free": "1.2.0" } },
    });
    expect(depsOf(update(selectUpdates(peers("@ex/host", [shell])), "app-repo"))).toEqual(["@ex/free"]);
  });

  /** @ex/left and @ex/right pin @ex/hub with `workspace:*`, so npm gets an exact version. */
  const family = (section: "dependencies" | "devDependencies", lateName = "@ex/hub", direct = ["@ex/hub", "@ex/left"]) => {
    const versions: Record<string, string> = { "@ex/hub": "1.2.0", "@ex/left": "1.2.0", "@ex/right": "1.2.0" };
    return planOf(
      [
        snap("fam-repo", {
          "packages/hub": { name: "@ex/hub", version: versions["@ex/hub"] as string },
          "packages/left": { name: "@ex/left", version: versions["@ex/left"] as string, [section]: { "@ex/hub": "workspace:*" } },
          "packages/right": { name: "@ex/right", version: versions["@ex/right"] as string, [section]: { "@ex/hub": "workspace:*" } },
        }),
        snap("app-repo", { "": { name: "app", private: true, dependencies: Object.fromEntries(direct.map((n) => [n, "^1.0.0"])) } }, {
          private: true,
          resolved: { "": Object.fromEntries(direct.map((n) => [n, "1.0.0"])) },
        }),
      ],
      Object.fromEntries(Object.keys(versions).map((n) => [n, npm(n === lateName ? "1.1.0" : "1.2.0")])),
    );
  };

  it("keeps a package with the package that it pins with a runtime workspace range", () => {
    const s = selectUpdates(family("dependencies"));
    expect(s.ready.filter((u) => u.repo === "app-repo")).toEqual([]);
    expect(s.waiting.find((w) => w.repo === "app-repo")?.dependsOn).toEqual(["release:fam-repo"]);
  });

  it("does not join two packages through a workspace range in devDependencies", () => {
    const u = update(selectUpdates(family("devDependencies")), "app-repo");
    expect(depsOf(u)).toEqual(["@ex/left"]);
  });

  it("joins two packages through a package that the repository does not use itself", () => {
    const s = selectUpdates(family("dependencies", "@ex/left", ["@ex/left", "@ex/right"]));
    expect(s.ready.filter((u) => u.repo === "app-repo")).toEqual([]);
  });
});

/** The repositories of the dependencies. @ex/late waits for its release. npm has the other versions. */
const depRepos = () => [
  snap("fresh-repo", { "": { name: "@ex/fresh", version: "2.0.0" } }),
  snap("late-repo", { "": { name: "@ex/late", version: "2.0.0" } }),
  snap("lock-repo", { "": { name: "@ex/lock", version: "1.1.0" } }),
  snap("tool-repo", { "": { name: "@ex/tool", version: "2.0.0" } }),
];
const depNpm = (late = "1.0.0"): Record<string, NpmInfo> => ({ "@ex/fresh": npm("2.0.0"), "@ex/late": npm(late), "@ex/lock": npm("1.1.0"), "@ex/tool": npm("2.0.0") });
const locked = { "@ex/fresh": "1.0.0", "@ex/late": "1.0.0", "@ex/lock": "1.0.0", "@ex/tool": "1.0.0" };

/** @ex/pub has two breaking runtime items, a lockfile item and a breaking dev item. */
const pubManifest = (over: Partial<Manifest> = {}): Manifest => ({
  name: "@ex/pub",
  version: "1.0.0",
  dependencies: { "@ex/fresh": "^1.0.0", "@ex/late": "^1.0.0", "@ex/lock": "^1.0.0" },
  devDependencies: { "@ex/tool": "^1.0.0" },
  ...over,
});

describe("a repository with a release of its own", () => {
  const pub = (late?: string) => planOf([...depRepos(), snap("pub-repo", { "": pubManifest() }, { resolved: { "": locked } })], { ...depNpm(late), "@ex/pub": npm("1.0.0") });

  it("holds each item that changes a published range when one of them waits, and sends the rest with no release", () => {
    const s = selectUpdates(pub());
    const u = update(s, "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/lock", "@ex/tool"]);
    expect(u.held).toEqual({ items: 2, deps: ["@ex/fresh", "@ex/late"] });
    expect(u).not.toHaveProperty("releases");
    expect(u.kind).toBe("adopt-breaking");
  });

  it("keeps the order of the plan: the release still waits for the adoption and the adoption for the other release", () => {
    const p = pub();
    expect(p.actions.find((a) => a.id === "update:pub-repo")?.dependsOn).toEqual(["release:late-repo"]);
    expect(p.actions.find((a) => a.id === "release:pub-repo")?.dependsOn).toEqual(["update:pub-repo"]);
  });

  it("carries the release in a later run, when npm has the last target", () => {
    const u = update(selectUpdates(pub("2.0.0")), "pub-repo");
    expect(u).not.toHaveProperty("held");
    expect(u.items).toHaveLength(4);
    expect(u.releases?.map((r) => [r.name, r.changes.map((c) => c.dep)])).toEqual([["@ex/pub", ["@ex/fresh", "@ex/late"]]]);
  });

  it("holds the same package in an app of the repository, so one package has one version in the lockfile", () => {
    const repos = [...depRepos(), snap("pub-repo", { "": pubManifest(), app: { name: "pub-app", private: true, dependencies: { "@ex/fresh": "^1.0.0" } } }, { resolved: { "": locked, app: locked } })];
    const u = update(selectUpdates(planOf(repos, { ...depNpm(), "@ex/pub": npm("1.0.0") })), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/lock", "@ex/tool"]);
    expect(u.held?.items).toBe(3);
  });

  it("treats the release of a repository as one: a second package with only ready items waits too", () => {
    const repos = [
      ...depRepos(),
      snap("pub-repo", {
        "packages/a": { name: "@ex/pub", version: "1.0.0", dependencies: { "@ex/late": "^1.0.0" } },
        "packages/b": { name: "@ex/pub2", version: "1.0.0", dependencies: { "@ex/fresh": "^1.0.0", "@ex/lock": "^1.0.0" } },
      }, { resolved: { "packages/a": locked, "packages/b": locked } }),
    ];
    const u = update(selectUpdates(planOf(repos, { ...depNpm(), "@ex/pub": npm("1.0.0"), "@ex/pub2": npm("1.0.0") })), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/lock"]);
    expect(u).not.toHaveProperty("releases");
  });

  it("carries the release when only a dev item waits, because a dev range is not published", () => {
    const m = pubManifest({ dependencies: { "@ex/fresh": "^1.0.0", "@ex/lock": "^1.0.0" }, devDependencies: { "@ex/late": "^1.0.0" } });
    const u = update(selectUpdates(planOf([...depRepos(), snap("pub-repo", { "": m }, { resolved: { "": locked } })], { ...depNpm(), "@ex/pub": npm("1.0.0") })), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/fresh", "@ex/lock"]);
    expect(u.held).toEqual({ items: 1, deps: ["@ex/late"] });
    expect(u.releases?.map((r) => r.name)).toEqual(["@ex/pub"]);
  });

  const ranges = { "@ex/fresh": "^1.0.0", "@ex/lock": "^1.0.0" };

  it("holds the published range when the release is blocked, and sends the lockfile item", () => {
    const m = pubManifest({ dependencies: { ...ranges, "@ex/git": "github:ex/git" }, devDependencies: {} });
    const u = update(selectUpdates(planOf([...depRepos(), snap("git-repo", { "": { name: "@ex/git", version: "1.0.0" } }), snap("pub-repo", { "": m }, { resolved: { "": locked } })], { ...depNpm(), "@ex/git": npm("1.0.0"), "@ex/pub": npm("1.0.0") })), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/lock"]);
    expect(u.held?.deps).toEqual(["@ex/fresh"]);
    expect(u).not.toHaveProperty("releases");
  });

  it("holds the published range when the cascade of the repository is off, and sends the lockfile item", () => {
    const m = pubManifest({ dependencies: ranges, devDependencies: {} });
    const p = planOf([...depRepos(), snap("pub-repo", { "": m }, { resolved: { "": locked } })], { ...depNpm(), "@ex/pub": npm("1.0.0") });
    const u = update(selectUpdates(p, null, ["other-repo"]), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/lock"]);
    expect(u).not.toHaveProperty("releases");
    expect(depsOf(update(selectUpdates(p, null, ["pub-repo"]), "pub-repo"))).toEqual(["@ex/fresh", "@ex/lock"]);
  });

  it("holds the published range when the release waits for another action, and sends the lockfile item", () => {
    const m = pubManifest({ dependencies: { ...ranges, "@ex/first": "workspace:*" }, devDependencies: {} });
    const repos = [...depRepos(), snap("pub-repo", { "": m, first: { name: "@ex/first", version: "1.0.0" } }, { resolved: { "": locked } })];
    const p = planOf(repos, { ...depNpm(), "@ex/pub": npm("1.0.0"), "@ex/first": { exists: false, latest: null } });
    expect(p.actions.find((a) => a.id === "release:pub-repo")?.dependsOn).toContain("new:@ex/first");
    const u = update(selectUpdates(p), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/lock"]);
    expect(u).not.toHaveProperty("releases");
  });

  it("holds a published range for a version on main that is not released yet", () => {
    const m = pubManifest({ version: "1.1.0" });
    const p = planOf([...depRepos(), snap("pub-repo", { "": m }, { resolved: { "": locked } })], { ...depNpm(), "@ex/pub": npm("1.0.0") });
    expect(p.actions.find((a) => a.id === "release:pub-repo")?.packages.map((x) => x.bump)).toEqual([null]);
    expect(depsOf(update(selectUpdates(p), "pub-repo"))).toEqual(["@ex/lock", "@ex/tool"]);
  });

  it("splits a private repository freely, because the train publishes none of its packages", () => {
    const p = planOf([...depRepos(), snap("pub-repo", { "": pubManifest() }, { private: true, resolved: { "": locked } })], { ...depNpm(), "@ex/pub": npm("1.0.0") });
    const u = update(selectUpdates(p), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/fresh", "@ex/lock", "@ex/tool"]);
    expect(u.held?.deps).toEqual(["@ex/late"]);
  });

  it("follows a held range into its set, so the two rules reach a fixed point", () => {
    const repos = [
      ...depRepos(),
      snap("mate-repo", { "": { name: "@ex/mate", version: "1.1.0", peerDependencies: { "@ex/fresh": "^2.0.0" } } }, { resolved: { "": { "@ex/fresh": "2.0.0" } } }),
      snap("pub-repo", { "": pubManifest({ dependencies: { "@ex/fresh": "^1.0.0", "@ex/late": "^1.0.0", "@ex/lock": "^1.0.0", "@ex/mate": "^1.0.0" } }) }, { resolved: { "": { ...locked, "@ex/mate": "1.0.0" } } }),
    ];
    const u = update(selectUpdates(planOf(repos, { ...depNpm(), "@ex/mate": npm("1.1.0"), "@ex/pub": npm("1.0.0") })), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/lock", "@ex/tool"]);
    expect(u.held?.deps).toEqual(["@ex/fresh", "@ex/late", "@ex/mate"]);
  });

  it("does not hold a range of a private app of the repository, because npm does not get it", () => {
    const m = pubManifest({ dependencies: { "@ex/late": "^1.0.0", "@ex/lock": "^1.0.0" }, devDependencies: {} });
    const repos = [...depRepos(), snap("pub-repo", { "": m, app: { name: "pub-app", private: true, dependencies: { "@ex/fresh": "^1.0.0" } } }, { resolved: { "": locked, app: locked } })];
    expect(depsOf(update(selectUpdates(planOf(repos, { ...depNpm(), "@ex/pub": npm("1.0.0") })), "pub-repo"))).toEqual(["@ex/fresh", "@ex/lock"]);
  });

  it("does not hold a published range for a blocked release with no cascade bump: the train carries no version there", () => {
    const m = pubManifest({ version: "1.1.0", dependencies: { ...ranges, "@ex/git": "github:ex/git" }, devDependencies: {} });
    const p = planOf([...depRepos(), snap("git-repo", { "": { name: "@ex/git", version: "1.0.0" } }), snap("pub-repo", { "": m }, { resolved: { "": locked } })], { ...depNpm(), "@ex/git": npm("1.0.0"), "@ex/pub": npm("1.0.0") });
    expect(p.actions.find((a) => a.id === "release:pub-repo")?.blocked).toBe(true);
    const u = update(selectUpdates(p), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/fresh", "@ex/lock"]);
    expect(u).not.toHaveProperty("held");
  });

  it("carries no version when the cascade is off and no item of the update changes a published range", () => {
    const m = pubManifest({ dependencies: { "@ex/held": "^1.0.0" }, devDependencies: { "@ex/tool": "^1.0.0" } });
    const repos = [...depRepos(), snap("held-repo", { "": { name: "@ex/held", version: "2.0.0" } }), snap("pub-repo", { "": m }, { resolved: { "": locked } })];
    const unproved: NpmInfo = { exists: true, latest: "2.0.0", provenance: null };
    const p = planOf(repos, { ...depNpm(), "@ex/held": unproved, "@ex/pub": npm("1.0.0") });
    const u = update(selectUpdates(p, null, ["other-repo"]), "pub-repo");
    expect(depsOf(u)).toEqual(["@ex/tool"]);
    expect(u).not.toHaveProperty("releases");
  });

  it("leaves a repository in the waiting list when no item can go", () => {
    const m = pubManifest({ dependencies: { "@ex/fresh": "^1.0.0", "@ex/late": "^1.0.0" }, devDependencies: {} });
    const s = selectUpdates(planOf([...depRepos(), snap("pub-repo", { "": m }, { resolved: { "": locked } })], { ...depNpm(), "@ex/pub": npm("1.0.0") }));
    expect(s.ready.filter((u) => u.repo === "pub-repo")).toEqual([]);
    expect(s.waiting.find((w) => w.repo === "pub-repo")?.dependsOn).toEqual(["release:late-repo"]);
  });
});

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** A GitHub with one repository that remembers its open pull request, so a run sees the pull request of an earlier run. */
function memory(repo: string) {
  const calls: Call[] = [];
  const at = `/repos/${OWNER}/${repo}`;
  let pr: Record<string, unknown> | null = null;
  const f: FetchFn = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path: `${u.pathname}${u.search}`, body });
    const key = `${method} ${u.pathname}`;
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (key === `GET ${at}`) return reply(200, { default_branch: "main" });
    if (key === `GET ${at}/pulls`) return reply(200, u.searchParams.get("state") === "open" && pr ? [pr] : []);
    if (key === `POST ${at}/pulls`) {
      pr = { ...body, number: 10, html_url: `https://github.com/${OWNER}/${repo}/pull/10`, node_id: "PR_10", state: "open", auto_merge: null, head: { sha: "sha10", ref: TRAIN_BRANCH }, base: { ref: "main" }, labels: [{ name: TRAIN_LABEL }] };
      return reply(201, pr);
    }
    if (key === `GET ${at}/pulls/10`) return reply(200, { ...pr, mergeable: true });
    if (key === `PATCH ${at}/pulls/10`) {
      pr = { ...pr, ...body };
      return reply(200, pr);
    }
    if (key === `GET ${at}/compare/main...sha10`) return reply(200, { behind_by: 0 });
    if (key === `GET ${at}/commits/sha10/check-runs`) return reply(200, { check_runs: [{ status: "in_progress", conclusion: null }] });
    if (key === `GET ${at}/commits/sha10/status`) return reply(200, { state: "pending", total_count: 0 });
    if (key === `POST ${at}/labels` || key === `POST ${at}/issues/10/labels`) return reply(201, {});
    return reply(404, { message: "Not Found" });
  };
  return { gh: gitHub({ token: "t", fetch: f }), calls };
}

/** An updater that pushes when its fingerprint is new. The branch then has the changes, as with the real updater. */
function branch(): Updater & { seen: number[] } {
  const seen: number[] = [];
  let last: string | null = null;
  return {
    seen,
    async update(u) {
      seen.push(u.items.length);
      const push = last !== u.fingerprint;
      last = u.fingerprint;
      return { status: push ? "pushed" : "same", sha: "sha10", changes: [], unresolved: [], young: [], tool: "pnpm 12.0.0", error: null };
    },
  };
}

describe("apply with a partial update", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const run = (p: ReturnType<typeof mixed>, gh: ReturnType<typeof memory>["gh"], updater: Updater, log?: (l: string) => void) =>
    apply({ owner: OWNER, plan: p, gh, updater, dryRun: false, only: ["big-repo"], now, ...(log ? { log } : {}) });

  it("opens one pull request, keeps it in the next run, and extends it when the release comes, with no close", async () => {
    const { gh, calls } = memory("big-repo");
    const up = branch();
    const first = await run(mixed(), gh, up);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({ repo: "big-repo", state: "opened", items: 36, held: 4 });
    const second = await run(mixed(), gh, up);
    expect(second.results).toHaveLength(1);
    expect(second.results[0]).toMatchObject({ state: "unchanged", items: 36, held: 4, pr: { number: 10 } });
    const third = await run(mixed({ released: true }), gh, up);
    expect(third.results).toHaveLength(1);
    expect(third.results[0]).toMatchObject({ state: "updated", items: 40, pr: { number: 10 } });
    expect(third.results[0]).not.toHaveProperty("held");
    expect(up.seen).toEqual([36, 36, 40]);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toHaveLength(1);
    expect(calls.filter((c) => c.body?.["state"] === "closed")).toEqual([]);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("gives one row and one clone for a repository, not a second row for the items that wait", async () => {
    const { gh } = memory("big-repo");
    const r = await run(mixed(), gh, branch());
    expect(r.results.map((x) => x.state)).toEqual(["opened"]);
    expect(applySummary(r)).not.toContain("Waiting for a release");
  });

  it("tells the items that wait in the body, and no version of a package that is not on npm", () => {
    const u = update(selectUpdates(mixed()), "big-repo");
    const body = prBody(u, { changes: [], unresolved: [], tool: null });
    expect(body).toContain("wait for a release, or move with a package that waits, so a later run adds them: `@ex/late0`, `@ex/late1`, `@ex/late2`, `@ex/late3`.");
    expect(body).not.toContain("2.0.0");
    const whole = prBody(update(selectUpdates(mixed({ released: true })), "big-repo"), { changes: [], unresolved: [], tool: null });
    expect(whole).not.toContain("a later run adds them");
  });

  it("gives a private repository only as a count, in the log, the report and the summary", async () => {
    const { gh } = memory("big-repo");
    const log: string[] = [];
    const r = publicReport(await run(mixed(), gh, branch(), (l) => log.push(l)), "key");
    const text = `${log.join("\n")}\n${JSON.stringify(r)}\n${applySummary(r)}`;
    expect(text).not.toContain("big-repo");
    expect(text).not.toContain("@ex/");
    expect(text).not.toContain("release:late-repo");
    expect(applySummary(r)).toContain("Items that wait for a release: 4 in 1 repositories. Public: none. Count of private repositories: 1.");
  });

  it("names a public repository in the summary line", async () => {
    const { gh } = memory("big-repo");
    const r = await run(mixed({ private: false }), gh, branch());
    expect(applySummary(r)).toContain("Items that wait for a release: 4 in 1 repositories. Public: big-repo. Count of private repositories: 0.");
  });
});
