// All names in these tests are made up. No test uses the network.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summary } from "./cli.ts";
import { retryAfterDelay, type Clock } from "@mark1russell7/service";
import { collect, HttpError, manifestFolder, patchVersion, runtimeRanges } from "./collect.ts";
import type { FetchFn } from "./collect.ts";
import { docId, writeDb } from "./db.ts";
import { buildGraph, publicView } from "./graph.ts";
import { matchWorkspaces, parseNpmLock, parsePnpmLock, parseSpec } from "./parse.ts";
import { plan } from "./plan.ts";
import { addProgress, checkState } from "./progress.ts";

const API = "https://api.github.com";
const REG = "https://registry.npmjs.org";

interface FakeRepo {
  name: string;
  private?: boolean;
  archived?: boolean;
  fork?: boolean;
  files: Record<string, string>;
  /** The paths of the git submodules: entries of type "commit" in the tree. */
  links?: string[];
}

type PullFiles = Record<string, { filename: string; patch?: string }[] | null>;

function fakeFetch(repos: FakeRepo[], npm: Record<string, string | null>, calls: string[] = [], built: Record<string, { repository: string; path: string } | null> = {}, pullFiles: PullFiles = {}): FetchFn {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.origin === new URL(REG).origin) {
      // The provenance of a version: release.yml of the repository that has the package, unless the test names it in `built`
      const att = /^\/-\/npm\/v1\/attestations\/(.+)@[^@]+$/.exec(decodeURIComponent(u.pathname));
      if (att) {
        const name = att[1] ?? "";
        const repo = repos.find((r) => Object.entries(r.files).some(([file, text]) => file.endsWith("package.json") && (() => { try { return (JSON.parse(text) as { name?: unknown }).name === name; } catch { return false; } })()));
        const workflow = built[name] ?? (repo ? { repository: `https://github.com/example-owner/${repo.name}`, path: ".github/workflows/release.yml" } : null);
        if (workflow === null) return new Response("", { status: 404 });
        const statement = { predicate: { buildDefinition: { externalParameters: { workflow } } } };
        return json({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] });
      }
      const ver = /^\/(.+)\/(\d[^/]*)$/.exec(decodeURIComponent(u.pathname));
      if (ver) {
        const foreign = ver[1] === "vendored-lib";
        return json({
          repository: { url: foreign ? "git+https://github.com/someone-else/vendored-lib.git" : "git+https://github.com/example-owner/x.git" },
          maintainers: [{ name: foreign ? "someone-else" : "example-owner" }],
        });
      }
      const name = decodeURIComponent(u.pathname.slice(1));
      const v = npm[name];
      return v === undefined ? new Response("", { status: 404 }) : json({ "dist-tags": { latest: v } });
    }
    const p = u.pathname;
    if (p === "/user") return json({ message: "no" }, 403);
    if (p === "/users/example-owner/repos") {
      const list = repos.map((r) => ({
        name: r.name,
        private: r.private ?? false,
        archived: r.archived ?? false,
        fork: r.fork ?? false,
        default_branch: "main",
        owner: { login: "example-owner" },
      }));
      // Two pages, to test the link header.
      if (u.searchParams.get("page") === "2") return json(list.slice(2));
      return json(list.slice(0, 2), 200, { link: `<${API}${p}?page=2>; rel="next"` });
    }
    const tree = /^\/repos\/example-owner\/([^/]+)\/git\/trees\/main$/.exec(p);
    if (tree) {
      const r = repos.find((x) => x.name === tree[1]);
      if (!r) return json({}, 404);
      if (Object.keys(r.files).length === 0) return json({ message: "Git Repository is empty." }, 409);
      return json({ tree: [...Object.keys(r.files).map((path) => ({ path, type: "blob" })), ...(r.links ?? []).map((path) => ({ path, type: "commit" }))], truncated: false });
    }
    const content = /^\/repos\/example-owner\/([^/]+)\/contents\/(.+)$/.exec(p);
    if (content) {
      const r = repos.find((x) => x.name === content[1]);
      const text = r?.files[decodeURIComponent(content[2] as string)];
      return text === undefined ? new Response("", { status: 404 }) : new Response(text);
    }
    // The files of a pull request: "repo#number" in pullFiles, null for a failed read
    const prFiles = /^\/repos\/example-owner\/([^/]+)\/pulls\/(\d+)\/files$/.exec(p);
    if (prFiles) {
      const list = pullFiles[`${prFiles[1]}#${prFiles[2]}`];
      return list === null ? json({ message: "Not Found" }, 404) : json(list ?? []);
    }
    if (/\/pulls$/.test(p)) {
      return json([{ number: 7, title: "chore(deps): update @ex/core to v1.4.0", html_url: "https://example.test/pr/7", head: { sha: "abc", ref: "renovate/ex-core" } }]);
    }
    if (/\/check-runs$/.test(p)) return json({ check_runs: [{ status: "in_progress", conclusion: null }] });
    if (/\/runs$/.test(p)) return json({ workflow_runs: [] });
    return json({ message: `unknown ${url}` }, 500);
  };
}

const REPOS: FakeRepo[] = [
  {
    name: "core-repo",
    files: {
      "package.json": JSON.stringify({ name: "core-monorepo", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!packages/skip'\n",
      "packages/core/package.json": JSON.stringify({ name: "@ex/core", version: "1.4.0" }),
      "packages/fresh/package.json": JSON.stringify({ name: "@ex/fresh", version: "0.1.0", dependencies: { "@ex/core": "workspace:*" } }),
      "packages/skip/package.json": JSON.stringify({ name: "@ex/skip", version: "1.0.0" }),
      "packages/core/node_modules/x/package.json": JSON.stringify({ name: "x" }),
      ".gitmodules": '[submodule "packages/linked"]\n\tpath = packages/linked\n',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/fresh:\n    dependencies:\n      '@ex/core':\n        specifier: workspace:*\n        version: link:../core\n",
    },
    links: ["packages/linked", "tools/outside"],
  },
  {
    name: "app-repo",
    files: {
      "package.json": JSON.stringify({ name: "app", private: true, dependencies: { "@ex/core": "^1.0.0" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@ex/core':\n        specifier: ^1.0.0\n        version: 1.2.0\n",
    },
  },
  { name: "hidden-repo", private: true, files: { "package.json": JSON.stringify({ name: "@ex/hidden", version: "1.0.0" }) } },
  { name: "old-repo", archived: true, files: { "package.json": JSON.stringify({ name: "@ex/old", version: "1.0.0" }) } },
  { name: "empty-repo", files: {} },
  { name: "npm-repo", files: { "package.json": JSON.stringify({ name: "npm-app", private: true, devDependencies: { "@ex/core": "~1.2.0" } }), "package-lock.json": JSON.stringify({ packages: { "node_modules/@ex/core": { version: "1.2.3" } } }) } },
  { name: "docs-repo", files: { "README.md": "no package" } },
  { name: "vendor-repo", files: { "package.json": JSON.stringify({ name: "vendored-lib", version: "1.0.0" }) } },
];

describe("parse", () => {
  it("finds the kind of each specifier", () => {
    expect(parseSpec("a", "^1.0.0")).toEqual({ target: "a", kind: "registry", range: "^1.0.0" });
    expect(parseSpec("a", "workspace:*")).toMatchObject({ kind: "workspace", range: "*" });
    expect(parseSpec("a", "github:o/r#sha")).toMatchObject({ kind: "github" });
    expect(parseSpec("a", "o/r")).toMatchObject({ kind: "github" });
    expect(parseSpec("a", "git+https://x/y.git")).toMatchObject({ kind: "git" });
    expect(parseSpec("a", "file:../a")).toMatchObject({ kind: "file" });
    expect(parseSpec("a", "link:../a")).toMatchObject({ kind: "link" });
    expect(parseSpec("a", "latest")).toMatchObject({ kind: "tag", range: "latest" });
    expect(parseSpec("alias", "npm:@ex/real@^2.1.0")).toEqual({ target: "@ex/real", kind: "registry", range: "^2.1.0" });
  });

  it("matches workspace globs", () => {
    const matches = (glob: string, path: string): boolean => matchWorkspaces([glob], [path]).length === 1;
    expect(matches("packages/*", "packages/a")).toBe(true);
    expect(matches("packages/*", "packages/a/b")).toBe(false);
    expect(matches("apps/**", "apps/a/b")).toBe(true);
    expect(matches("./packages/*/", "packages/a")).toBe(true);
    expect(matchWorkspaces(["packages/*", "!packages/skip"], ["", "packages/a", "packages/skip", "packages/a/node_modules/x"])).toEqual(["packages/a"]);
  });

  it("reads pnpm and npm lockfiles", () => {
    const v9 = "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      a:\n        specifier: ^1.0.0\n        version: 1.2.0(b@2.0.0)\n";
    expect(parsePnpmLock(v9)).toEqual({ "": { a: "1.2.0" } });
    const old = "lockfileVersion: 5.4\nspecifiers:\n  a: ^1.0.0\ndependencies:\n  a: 1.1.0\n";
    expect(parsePnpmLock(old)).toEqual({ "": { a: "1.1.0" } });
    const twoDocs = "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies: {}\n---\nlockfileVersion: '9.0'\nimporters:\n  packages/x:\n    dependencies:\n      a:\n        specifier: ^1.0.0\n        version: 1.3.0\n";
    expect(parsePnpmLock(twoDocs)).toEqual({ "": {}, "packages/x": { a: "1.3.0" } });
    const npmLock = JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" }, "packages/x/node_modules/a": { version: "2.0.0" } } });
    expect(parseNpmLock(npmLock, ["", "packages/x"], ["a"])).toEqual({ "": { a: "1.0.0" }, "packages/x": { a: "2.0.0" } });
  });
});

/** The copy of release-train 0.2.9, word for word: the reference of the move to `globToRegExp` of conventions. */
function copyGlobToRegExp(glob: string): RegExp {
  const start = glob.startsWith("./") ? 2 : 0;
  let end = glob.length;
  while (end > start && glob.charAt(end - 1) === "/") end -= 1;
  const g = glob.slice(start, end);
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        out += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

describe("the workspace globs of conventions and the copy of release-train 0.2.9", () => {
  const globs = [
    "packages/*", "packages/**", "apps/*", "./packages/*", "packages/*/", "./packages/**/", "**", "**/*",
    "packages/*/*", "tools/?x", "packages/a.b", "packages/(x)", "packages/{a,b}", "docs", "packages/**/test", "**/test/**",
  ];
  const paths = [
    "packages", "packages/a", "packages/a/b", "packages/a/b/c", "apps/web", "apps", "tools/ax", "tools/abx", "packages/a.b",
    "packages/aXb", "packages/(x)", "packages/b", "packages/{a,b}", "docs", "docs/x", "packages/a/test",
    "packages/test", "x/test/y", "test", "test/a",
  ];

  it("agree on each pair of a glob and a path, except the three forms where conventions reads the glob as pnpm does", () => {
    const differ: string[] = [];
    let same = 0;
    for (const glob of globs) {
      for (const path of paths) {
        const home = matchWorkspaces([glob], [path]).length === 1;
        if (home === copyGlobToRegExp(glob).test(path)) same++;
        else differ.push(`${glob} ${path} ${home}`);
      }
    }
    expect(differ).toEqual([
      // `a/**` also names the folder `a`
      "packages/** packages true",
      "./packages/**/ packages true",
      // `{a,b}` is one of its parts, not the text "{a,b}"
      "packages/{a,b} packages/a true",
      "packages/{a,b} packages/b true",
      "packages/{a,b} packages/{a,b} false",
      // `**/` matches zero segments, and `**/test/**` names the folder `test` at each depth
      "**/test/** packages/a/test true",
      "**/test/** packages/test true",
      "**/test/** test true",
    ]);
    expect(same).toBe(globs.length * paths.length - 8);
  });
});

describe("collect with a mocked fetch", () => {
  it("reads the repositories and plans from real-shaped responses", async () => {
    const calls: string[] = [];
    const f = fakeFetch(REPOS, { "@ex/core": "1.4.0", "@ex/skip": "1.0.0", "@ex/hidden": "1.0.0", "vendored-lib": "9.0.0" }, calls);
    const data = await collect({ owner: "example-owner", token: "t", fetch: f, publicOnly: true, concurrency: 2 });
    expect(data.repos.map((r) => r.name)).toEqual(["app-repo", "core-repo", "npm-repo", "vendor-repo"]);
    expect(data.npm["vendored-lib"]?.foreign).toBe(true);
    expect(data.npm["@ex/core"]?.foreign).toBe(false);
    expect(calls.some((c) => c.includes("hidden-repo"))).toBe(false);
    const core = data.repos.find((r) => r.name === "core-repo");
    expect(core?.manifests.map((m) => m.path)).toEqual(["", "packages/core", "packages/fresh"]);
    // Only a submodule in a folder of the workspace counts
    expect(core?.submodules).toEqual(["packages/linked"]);
    expect(data.repos.find((r) => r.name === "app-repo")?.submodules).toBeUndefined();
    expect(data.npm["@ex/fresh"]).toEqual({ exists: false, latest: null });

    const p = plan(buildGraph({ owner: "example-owner", repos: data.repos, npm: data.npm }));
    expect(p.actions.map((a) => [a.id, a.kind])).toEqual([
      ["new:@ex/fresh", "new-package"],
      ["update:npm-repo", "adopt-breaking"],
      ["update:app-repo", "adopt-in-range"],
    ]);
    expect(p.reposWithoutPnpmLock).toEqual(["npm-repo", "vendor-repo"]);
    expect(p.nodes.some((n) => n.name === "vendored-lib")).toBe(false);
    expect(p.repos.find((r) => r.name === "vendor-repo")?.warnings.join(" ")).toContain("another person");
    expect(summary(p)).toContain("1 new-package");

    const progress = await addProgress(p, { owner: "example-owner", token: "t", fetch: f });
    expect(progress["update:app-repo"]).toMatchObject({ state: "ci-running", url: "https://example.test/pr/7" });
  });

  it("skips the lockfile of a repository with no dependency on the owner", async () => {
    const calls: string[] = [];
    const f = fakeFetch([REPOS[0] as FakeRepo, { name: "solo", files: { "package.json": "{}", "pnpm-lock.yaml": "x" } }], {}, calls);
    await collect({ owner: "example-owner", token: null, fetch: f });
    expect(calls.some((c) => c.includes("solo/contents/pnpm-lock.yaml"))).toBe(false);
  });

  it("sums check runs", () => {
    expect(checkState([])).toBe("in-flight");
    expect(checkState([{ status: "completed", conclusion: "success" }])).toBe("ci-green");
    expect(checkState([{ status: "completed", conclusion: "failure" }])).toBe("ci-failed");
  });
});

describe("writeDb", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("reads the versions that the open pull requests set in the package.json files of the workspace", async () => {
    const f = fakeFetch(REPOS, { "@ex/core": "1.4.0" }, [], {}, {
      "core-repo#7": [
        { filename: "packages/core/package.json", patch: '@@ -1,3 +1,3 @@\n   "name": "@ex/core",\n-  "version": "1.4.0",\n+  "version": "1.5.0",' },
        { filename: "README.md", patch: '+  "version": "7.0.0",' },
        { filename: "packages/skip/package.json", patch: '+  "version": "9.0.0",' },
      ],
      "vendor-repo#7": null,
    });
    const data = await collect({ owner: "example-owner", token: null, fetch: f });
    expect(data.repos.find((r) => r.name === "core-repo")?.pulls).toEqual([{ number: 7, path: "packages/core", version: "1.5.0" }]);
    const app = data.repos.find((r) => r.name === "vendor-repo");
    expect(app?.pulls).toBeUndefined();
    expect(app?.warnings.some((w) => w.startsWith("The open pull requests could not be read: HTTP 404"))).toBe(true);
  });

  it("reads the version line of a diff and the folder of a package.json", () => {
    expect(patchVersion('+  "version": "1.2.3",')).toBe("1.2.3");
    expect(patchVersion('+\t"version": "2.0.0"')).toBe("2.0.0");
    expect(patchVersion('-  "version": "1.2.3",')).toBeNull();
    expect(patchVersion('+      "version": "1.0.0"')).toBeNull();
    expect(patchVersion(undefined)).toBeNull();
    expect([manifestFolder("package.json"), manifestFolder("packages/a/package.json"), manifestFolder("README.md")]).toEqual(["", "packages/a", null]);
  });

  it("reads the full npm document of a package only when its modified time changed since the last run", async () => {
    const inner = fakeFetch(REPOS, { "@ex/core": "1.4.0", "@ex/fresh": "0.1.0" });
    let modified = "2026-11-09T10:00:00.000Z";
    const full: string[] = [];
    const f: FetchFn = async (url, init) => {
      if (url !== `${REG}/@ex%2fcore`) return inner(url, init);
      const accept = (init?.headers as Record<string, string> | undefined)?.["accept"] ?? "";
      if (accept.includes("install-v1")) return new Response(JSON.stringify({ "dist-tags": { latest: "1.4.0" }, modified, versions: { "1.3.0": {}, "1.4.0": {} } }));
      full.push(url);
      return new Response(JSON.stringify({ time: { created: "2026-01-01T00:00:00.000Z", modified, "1.3.0": "2026-10-01T00:00:00.000Z", "1.4.0": "2026-11-09T10:00:00.000Z" } }));
    };
    const one = await collect({ owner: "example-owner", token: null, fetch: f });
    expect(one.npm["@ex/core"]?.times).toEqual({ "1.3.0": "2026-10-01T00:00:00.000Z", "1.4.0": "2026-11-09T10:00:00.000Z" });
    expect(one.npmTimes?.["@ex/core"]).toEqual({ modified, times: one.npm["@ex/core"]?.times });
    expect(full).toHaveLength(1);
    // The same modified time: the times come from the last run, with no full read.
    const two = await collect({ owner: "example-owner", token: null, fetch: f, npmTimes: one.npmTimes ?? {} });
    expect(two.npm["@ex/core"]?.times).toEqual(one.npm["@ex/core"]?.times);
    expect(full).toHaveLength(1);
    // A publish changes the modified time, so the next run reads the full document again.
    modified = "2026-11-09T12:00:00.000Z";
    const three = await collect({ owner: "example-owner", token: null, fetch: f, npmTimes: two.npmTimes ?? {} });
    expect(full).toHaveLength(2);
    expect(three.npmTimes?.["@ex/core"]?.modified).toBe(modified);
    // A package whose document has no modified time gets no entry, and npm with no times gives no field.
    expect(three.npmTimes).not.toHaveProperty("@ex/fresh");
    expect(three.npm["@ex/fresh"]).not.toHaveProperty("times");
  });

  it("reads each version on npm and the runtime ranges of the latest version", async () => {
    const inner = fakeFetch(REPOS, { "@ex/core": "1.4.0", "@ex/fresh": "0.1.0" });
    const doc = {
      "dist-tags": { latest: "1.4.0" },
      versions: { "1.4.0": { dependencies: { "@ex/base": "^2.0.0", odd: 3 }, devDependencies: { vitest: "^5.0.0" } }, "1.5.0": {} },
    };
    const f: FetchFn = async (url, init) => (url === `${REG}/@ex%2fcore` ? new Response(JSON.stringify(doc), { status: 200 }) : inner(url, init));
    const data = await collect({ owner: "example-owner", token: null, fetch: f });
    expect(data.npm["@ex/core"]).toMatchObject({ latest: "1.4.0", versions: ["1.4.0", "1.5.0"], latestDeps: { dependencies: { "@ex/base": "^2.0.0" } } });
    // A document with no versions gives no fields, as a snapshot from before them
    expect(data.npm["@ex/fresh"]).toMatchObject({ exists: true, latest: "0.1.0" });
    expect(data.npm["@ex/fresh"]).not.toHaveProperty("versions");
    expect(runtimeRanges(undefined)).toEqual({});
    expect(runtimeRanges({ peerDependencies: { "@ex/a": "^1.0.0" }, devDependencies: { "@ex/b": "^1.0.0" } })).toEqual({ peerDependencies: { "@ex/a": "^1.0.0" } });
  });

  it("writes one document for each node and action, and moves a finished action to done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "release-train-"));
    dirs.push(dir);
    const f = fakeFetch(REPOS, { "@ex/core": "1.4.0" });
    const data = await collect({ owner: "example-owner", token: null, fetch: f });
    const g = publicView(buildGraph({ owner: "example-owner", repos: data.repos, npm: data.npm }));
    const p1 = plan(g);
    writeDb(dir, p1, {}, new Date("2026-01-01T00:00:00Z"));
    const actions = readdirSync(join(dir, "db", "actions")).sort();
    expect(actions).toContain(`${docId("update:app-repo")}.json`);
    expect(readdirSync(join(dir, "db", "nodes"))).toContain(`${docId("app-repo:.")}.json`);
    const summaryDoc = JSON.parse(readFileSync(join(dir, "db", "meta", "summary.json"), "utf8")) as { owner: string };
    expect(summaryDoc.owner).toBe("example-owner");

    const p2 = { ...p1, actions: p1.actions.filter((a) => a.id !== "update:app-repo") };
    writeDb(dir, p2, {}, new Date("2026-01-02T00:00:00Z"));
    expect(readdirSync(join(dir, "db", "done"))).toEqual([`${docId("update:app-repo")}.json`]);
    expect(readdirSync(join(dir, "db", "history"))).toHaveLength(2);
  });

  it("writes an alert for red CI, keeps its first date and removes it when CI is green", async () => {
    const dir = mkdtempSync(join(tmpdir(), "release-train-"));
    dirs.push(dir);
    const data = await collect({ owner: "example-owner", token: null, fetch: fakeFetch(REPOS, { "@ex/core": "1.4.0" }) });
    const p = plan(publicView(buildGraph({ owner: "example-owner", repos: data.repos, npm: data.npm })));
    const red = { "update:app-repo": { state: "ci-failed" as const, detail: "CI fails.", url: "https://github.com/example-owner/app-repo/pull/1" } };
    const file = join(dir, "db", "alerts", `${docId("update:app-repo")}.json`);
    writeDb(dir, p, red, new Date("2026-01-01T00:00:00Z"));
    writeDb(dir, p, red, new Date("2026-01-02T00:00:00Z"));
    const alert = JSON.parse(readFileSync(file, "utf8")) as { since: string; url: string; relay: string };
    expect([alert.since, alert.url]).toEqual(["2026-01-01T00:00:00.000Z", red["update:app-repo"].url]);
    expect(alert.relay).toContain("maintainer");
    writeDb(dir, p, {}, new Date("2026-01-03T00:00:00Z"));
    expect(readdirSync(join(dir, "db", "alerts"))).toEqual([]);
  });

  it("makes document ids that the tracker site permits", () => {
    for (const id of ["@ex/core", "update:app-repo", "app-repo:.", "new:@ex/a"]) {
      expect(docId(id)).toMatch(/^[A-Za-z0-9_\-.~@+]+$/);
      expect(docId(id).endsWith(".")).toBe(false);
    }
  });
});

describe("the retries of the GitHub reads", () => {
  // This clock does not wait: it records each delay and starts the next try at once.
  const instant = (waits: number[] = []): Clock => ({
    now: () => 0,
    after: (ms, run) => {
      waits.push(ms);
      queueMicrotask(run);
      return Object.assign(() => {}, { unref: () => {} }) as ReturnType<Clock["after"]>;
    },
  });
  const noWait = () => ({ clock: instant(), random: () => 0.5 });

  it("reads the data when the first try of a read gives HTTP 500", async () => {
    const calls: string[] = [];
    const inner = fakeFetch(REPOS, { "@ex/core": "1.4.0" }, calls);
    let failed = "";
    const f: FetchFn = async (url, init) => {
      if (failed === "" && url.includes("/contents/")) {
        failed = url;
        return new Response("server error", { status: 500 });
      }
      return inner(url, init);
    };
    const lines: string[] = [];
    const data = await collect({ owner: "example-owner", token: null, fetch: f, retry: noWait(), log: (line) => lines.push(line) });
    const clean = await collect({ owner: "example-owner", token: null, fetch: fakeFetch(REPOS, { "@ex/core": "1.4.0" }) });
    expect(failed).not.toBe("");
    expect(data.repos).toEqual(clean.repos);
    expect(lines.some((line) => line.startsWith("retry 1 of 3") && line.includes("HTTP 500"))).toBe(true);
  });

  it("stops after the cap of tries, with a clear message", async () => {
    let n = 0;
    const f: FetchFn = async () => {
      n++;
      return new Response("down", { status: 503 });
    };
    const error = await collect({ owner: "example-owner", token: null, fetch: f, retry: { ...noWait(), attempts: 3 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).message).toMatch(/^HTTP 503 for .* after 3 tries$/);
    expect(n).toBe(3);
  });

  it("does not try again after a status that does not pass with time", async () => {
    let n = 0;
    const f: FetchFn = async () => {
      n++;
      return new Response("no", { status: 403 });
    };
    const error = await collect({ owner: "example-owner", token: null, fetch: f, retry: noWait() }).catch((e: unknown) => e);
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).message).not.toContain("tries");
    expect(n).toBe(1);
  });

  it("waits for the Retry-After of a 429, up to its cap", async () => {
    const waits: number[] = [];
    const inner = fakeFetch(REPOS, { "@ex/core": "1.4.0" });
    const answers = [
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
      new Response("", { status: 429, headers: { "retry-after": "600" } }),
    ];
    const f: FetchFn = async (url, init) => (url.includes("/repos?") && answers.length > 0 ? (answers.shift() as Response) : inner(url, init));
    const data = await collect({ owner: "example-owner", token: null, fetch: f, retry: { clock: instant(waits), maxRetryAfter: 30_000 } });
    expect(data.repos.length).toBeGreaterThan(0);
    expect(waits).toEqual([2000, 30_000]);
  });

  it("tries again after a network error, and throws the last error after the cap", async () => {
    let n = 0;
    const f: FetchFn = async () => {
      n++;
      throw new TypeError("fetch failed");
    };
    await expect(collect({ owner: "example-owner", token: null, fetch: f, retry: { ...noWait(), attempts: 2 } })).rejects.toThrow("fetch failed");
    expect(n).toBe(2);
  });

  it("reads the seconds and the date forms of Retry-After with retryAfterDelay of the service", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterDelay("5", now)).toBe(5000);
    expect(retryAfterDelay("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(retryAfterDelay("soon", now)).toBeNull();
    expect(retryAfterDelay(null, now)).toBeNull();
  });
});
