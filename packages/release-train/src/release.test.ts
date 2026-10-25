// All repository and package names in these tests are made up.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { apply, dispatchOnly, prBody, selectUpdates } from "./apply.ts";
import type { RepoUpdate, Updater } from "./apply.ts";
import { gitHub } from "./github.ts";
import type { FetchFn } from "./collect.ts";
import { buildGraph } from "./graph.ts";
import { plan } from "./plan.ts";
import { awaitRelease, changesetText, decideBump, namesModule, setManifestVersion, typedFiles } from "./release.ts";
import type { Manifest, NpmInfo, RepoSnapshot } from "./types.ts";
import { gitUpdater } from "./workspace.ts";
import type { RunFn } from "./workspace.ts";

/** This function makes a gzip tar file with the given files. */
function tgz(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text, "utf8");
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    h.write("0", 156, "ascii");
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

describe("typed files of a tarball", () => {
  it("reads the declaration and source files and skips the others", () => {
    const files = typedFiles(tgz({ "package/dist/index.d.ts": 'export * from "@ex/core";', "package/dist/index.js": "x", "package/src/a.test.ts": "t", "package/src/b.ts": "b" }));
    expect([...files.keys()].sort()).toEqual(["package/dist/index.d.ts", "package/src/b.ts"]);
    expect(namesModule(files.get("package/dist/index.d.ts") ?? "", "@ex/core")).toBe(true);
  });

  it("matches a module specifier only, with quotes", () => {
    expect(namesModule("import type { A } from '@ex/core/sub';", "@ex/core")).toBe(true);
    expect(namesModule('import { A } from "@ex/core-extra";', "@ex/core")).toBe(false);
  });
});

describe("decideBump", () => {
  const files = (t: string) => new Map([["package/index.d.ts", t]]);
  const changes = [{ dep: "@ex/core", type: "dependencies" }];
  it("gives a patch when the public types do not name the dependency", () => {
    expect(decideBump({ from: "1.2.3", files: files("export declare const x: number;"), changes })).toMatchObject({ type: "patch", to: "1.2.4" });
  });
  it("gives a breaking change when the types name it: MINOR before 1.0.0, MAJOR after", () => {
    const t = files('import type { C } from "@ex/core"; export declare const c: C;');
    expect(decideBump({ from: "0.4.1", files: t, changes })).toMatchObject({ type: "minor", to: "0.5.0" });
    expect(decideBump({ from: "2.0.0", files: t, changes })).toMatchObject({ type: "major", to: "3.0.0" });
  });
  it("treats an unclear case and a peer range as breaking", () => {
    expect(decideBump({ from: "0.1.0", files: null, changes })).toMatchObject({ type: "minor", to: "0.2.0" });
    expect(decideBump({ from: "1.0.0", files: files(""), changes: [{ dep: "@ex/core", type: "peerDependencies" }] })).toMatchObject({ type: "major" });
  });
});

describe("version files", () => {
  it("sets the version and keeps the other text", () => {
    const text = '{\n  "name": "@ex/a",\n  "version" : "1.0.0",\n  "dependencies": { "x": "1.0.0" }\n}\n';
    expect(setManifestVersion(text, "1.0.1")).toBe(text.replace('"1.0.0",', '"1.0.1",'));
    expect(setManifestVersion('{"name":"a"}', "1.0.0")).toBeNull();
  });
  it("writes a changeset", () => {
    expect(changesetText([{ name: "@ex/a", type: "minor" }], "Why.")).toBe('---\n"@ex/a": minor\n---\n\nWhy.\n');
  });
});

const OWNER = "ex";
const npm = (latest: string): NpmInfo => ({ exists: true, latest });
function snap(name: string, manifests: Record<string, Manifest>, extra: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    name,
    private: false,
    defaultBranch: "main",
    manifests: Object.entries(manifests).map(([path, manifest]) => ({ path, manifest })),
    lockKind: "pnpm",
    resolved: {},
    warnings: [],
    ...extra,
  };
}
function cascadePlan(blockedSpec = false) {
  const repos = [
    snap("core-repo", { "": { name: "@ex/core", version: "2.0.0" } }),
    snap("git-repo", { "": { name: "@ex/git", version: "1.0.0" } }),
    snap("pub-repo", {
      "": { name: "@ex/pub", version: "0.3.0", dependencies: { "@ex/core": "^1.0.0", ...(blockedSpec ? { "@ex/git": "github:ex/git" } : {}) } },
    }, { resolved: { "": { "@ex/core": "1.0.0" } } }),
  ];
  return plan(buildGraph({ owner: OWNER, repos, npm: { "@ex/core": npm("2.0.0"), "@ex/pub": npm("0.3.0"), "@ex/git": npm("1.0.0") }, now: new Date("2026-01-01T00:00:00Z") }));
}

describe("cascade selection", () => {
  it("adds the release of the dependent to its breaking adoption", () => {
    const s = selectUpdates(cascadePlan());
    const u = s.ready.find((x) => x.repo === "pub-repo") as RepoUpdate;
    expect(u.releases).toEqual([{ name: "@ex/pub", path: "", from: "0.3.0", changes: [{ dep: "@ex/core", type: "dependencies" }] }]);
  });

  it("holds the adoption when the release is blocked", () => {
    const s = selectUpdates(cascadePlan(true));
    expect(s.ready.some((x) => x.repo === "pub-repo")).toBe(false);
    expect(s.waiting.find((w) => w.repo === "pub-repo")?.dependsOn).toEqual(["blocked:release:pub-repo"]);
  });
});

describe("gitUpdater with a cascade release", () => {
  const types = tgz({ "package/dist/index.d.ts": 'import type { C } from "@ex/core";' });
  const fetchFn: FetchFn = async (url) => {
    if (url.endsWith(".tgz")) return new Response(types, { status: 200 });
    return new Response(JSON.stringify({ versions: { "0.3.0": { dist: { tarball: "https://registry.example/pub-0.3.0.tgz" } } } }), { status: 200 });
  };
  const runWith = (changeset: boolean, cmds: string[], seen: { manifest?: string; changeset?: string }, version = "0.3.0"): RunFn => async (cmd, args, opts) => {
    cmds.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args[0] === "clone") {
      writeFileSync(join(opts.cwd, "package.json"), `{\n  "name": "@ex/pub",\n  "version": "${version}",\n  "dependencies": { "@ex/core": "^1.0.0" }\n}\n`);
      if (changeset) {
        mkdirSync(join(opts.cwd, ".changeset"));
        writeFileSync(join(opts.cwd, ".changeset", "config.json"), "{}");
      }
    }
    if (cmd === "git" && args.includes("commit")) {
      seen.manifest = readFileSync(join(opts.cwd, "package.json"), "utf8");
      if (changeset) seen.changeset = readFileSync(join(opts.cwd, ".changeset", "release-train-cascade.md"), "utf8");
    }
    const out = cmd === "pnpm" && args[0] === "--version" ? "10.0.0\n" : cmd === "git" && args[0] === "status" ? " M package.json\n" : "";
    return { code: cmd === "git" && args[0] === "fetch" ? 1 : 0, stdout: out, stderr: "" };
  };

  it("sets the new version in package.json from the public types", async () => {
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "none" as const };
    const cmds: string[] = [];
    const seen: { manifest?: string } = {};
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run: runWith(false, cmds, seen), fetch: fetchFn });
    const r = await up.update(u, { defaultBranch: "main", rebuild: false });
    expect(r.status).toBe("pushed");
    expect(r.releases).toEqual([expect.objectContaining({ name: "@ex/pub", from: "0.3.0", to: "0.4.0", type: "minor", via: "version" })]);
    expect(seen.manifest).toContain('"version": "0.4.0"');
    expect(seen.manifest).toContain('"@ex/core": "^2.0.0"');
    expect(prBody(u, r)).toContain("| `@ex/pub` | 0.3.0 -> 0.4.0 | minor |");
  });

  it("keeps a version on main that is already high enough", async () => {
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "none" as const };
    const seen: { manifest?: string } = {};
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run: runWith(false, [], seen, "0.5.0"), fetch: fetchFn });
    const r = await up.update(u, { defaultBranch: "main", rebuild: false });
    expect(r.releases?.[0]?.to).toBe("0.5.0");
    expect(seen.manifest).toContain('"version": "0.5.0"');
  });

  it("writes a changeset in a repository with changesets and keeps the version", async () => {
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "none" as const };
    const cmds: string[] = [];
    const seen: { manifest?: string; changeset?: string } = {};
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run: runWith(true, cmds, seen), fetch: fetchFn });
    const r = await up.update(u, { defaultBranch: "main", rebuild: false });
    expect(r.releases?.[0]?.via).toBe("changeset");
    expect(seen.manifest).toContain('"version": "0.3.0"');
    expect(seen.changeset).toContain('"@ex/pub": minor');
    expect(cmds).toContain("git add -- .changeset/release-train-cascade.md");
  });
});

describe("dispatchOnly", () => {
  it("is true only for a workflow with workflow_dispatch and no push", () => {
    expect(dispatchOnly("on:\n  workflow_dispatch:\njobs: {}\n")).toBe(true);
    expect(dispatchOnly("on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n")).toBe(false);
    expect(dispatchOnly("on: [push, workflow_dispatch]\n")).toBe(false);
    expect(dispatchOnly("on:\n  pull_request:\n")).toBe(false);
  });
});

describe("awaitRelease", () => {
  const inFlight = [{ name: "@ex/a", version: "1.1.0" }, { name: "@ex/b", version: "0.2.0" }];
  it("gives the first version that npm has", async () => {
    let checks = 0;
    const slept: number[] = [];
    const r = await awaitRelease({
      inFlight,
      published: async (name) => ++checks > 3 && name === "@ex/b",
      sleep: async (ms) => void slept.push(ms),
      maxMs: 60_000,
      intervalMs: 30_000,
    });
    expect(r).toEqual({ name: "@ex/b", version: "0.2.0" });
    expect(slept).toEqual([30_000]);
  });
  it("stops at the end of the time and gives null", async () => {
    const slept: number[] = [];
    const r = await awaitRelease({ inFlight, published: async () => false, sleep: async (ms) => void slept.push(ms), maxMs: 60_000, intervalMs: 30_000 });
    expect(r).toBeNull();
    expect(slept.length).toBe(2);
    expect(await awaitRelease({ inFlight: [], published: async () => true, sleep: async () => {}, maxMs: 1, intervalMs: 1 })).toBeNull();
  });
});

describe("release dispatch", () => {
  type Handler = (body: unknown, url: URL) => [number, unknown];
  function server(routes: Record<string, Handler>) {
    const calls: string[] = [];
    const f: FetchFn = async (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${u.pathname}`);
      const h = routes[`${method} ${u.pathname}`];
      const [status, data] = h ? h(init?.body, u) : [404, { message: "Not Found" }];
      return new Response(status === 204 ? null : JSON.stringify(data), { status });
    };
    return { gh: gitHub({ token: "t", fetch: f }), calls };
  }
  const relPlan = () =>
    plan(buildGraph({ owner: OWNER, repos: [snap("rel-repo", { "": { name: "@ex/rel", version: "1.1.0" } })], npm: { "@ex/rel": npm("1.0.0") }, now: new Date("2026-01-01T00:00:00Z") }));
  const b = `/repos/${OWNER}/rel-repo`;
  const wf = (text: string): Handler => () => [200, { content: Buffer.from(text).toString("base64") }];
  const routes = (dispatch: [number, unknown], workflow = "on:\n  workflow_dispatch:\n", last = "success"): Record<string, Handler> => ({
    [`GET ${b}/contents/.github/workflows/release.yml`]: wf(workflow),
    [`GET ${b}`]: () => [200, { default_branch: "main", allow_auto_merge: false }],
    [`GET ${b}/pulls`]: () => [200, []],
    [`GET ${b}/actions/workflows/release.yml/runs`]: () => [200, { workflow_runs: [{ status: "completed", conclusion: last }] }],
    [`GET ${b}/commits/main`]: () => [200, { sha: "m1" }],
    [`GET ${b}/commits/m1/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: "success" }] }],
    [`GET ${b}/commits/m1/status`]: () => [200, { state: "pending", total_count: 0 }],
    [`POST ${b}/actions/workflows/release.yml/dispatches`]: () => dispatch,
  });
  const noUpdate: Updater = { update: async () => { throw new Error("no update expected"); } };

  it("lists the version in flight and starts a release workflow that starts only by hand", async () => {
    const { gh, calls } = server(routes([204, null]));
    const r = await apply({ owner: OWNER, plan: relPlan(), gh, updater: noUpdate, dryRun: false, releaseDispatch: true });
    expect(r.inFlight).toEqual([{ name: "@ex/rel", version: "1.1.0" }]);
    expect(calls).toContain(`POST ${b}/actions/workflows/release.yml/dispatches`);
    expect(r.results.find((x) => x.actionId === "release:rel-repo")?.state).toBe("opened");
  });

  it("tells the missing permission when the dispatch is refused", async () => {
    const { gh } = server(routes([403, { message: "Resource not accessible by integration" }]));
    const r = await apply({ owner: OWNER, plan: relPlan(), gh, updater: noUpdate, dryRun: false, releaseDispatch: true });
    const x = r.results.find((y) => y.actionId === "release:rel-repo");
    expect([x?.state, x?.detail]).toEqual(["error", expect.stringContaining("Actions: write")]);
  });

  it("does not start a workflow that starts on a push, and does nothing without the option", async () => {
    const one = server(routes([204, null], "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"));
    const r = await apply({ owner: OWNER, plan: relPlan(), gh: one.gh, updater: noUpdate, dryRun: false, releaseDispatch: true });
    expect(one.calls.some((c) => c.startsWith("POST"))).toBe(false);
    expect(r.inFlight).toHaveLength(1);
    const two = server(routes([204, null]));
    const r2 = await apply({ owner: OWNER, plan: relPlan(), gh: two.gh, updater: noUpdate, dryRun: false });
    expect(two.calls.some((c) => c.includes("dispatches"))).toBe(false);
    expect(r2.inFlight).toEqual([]);
  });

  it("does not wait for a version whose last release run failed", async () => {
    const { gh } = server(routes([204, null], "on:\n  push:\n", "failure"));
    const r = await apply({ owner: OWNER, plan: relPlan(), gh, updater: noUpdate, dryRun: false });
    expect(r.inFlight).toEqual([]);
  });
});

describe("cascade switch", () => {
  it("holds the adoption of a repository whose cascade is off", () => {
    const s = selectUpdates(cascadePlan(), null, ["other-repo"]);
    expect(s.ready.some((x) => x.repo === "pub-repo")).toBe(false);
    expect(s.waiting.find((w) => w.repo === "pub-repo")?.dependsOn).toEqual(["cascade-off:release:pub-repo"]);
    expect(selectUpdates(cascadePlan(), null, ["pub-repo"]).ready.some((x) => x.repo === "pub-repo")).toBe(true);
  });
});
