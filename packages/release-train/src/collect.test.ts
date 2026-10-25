// All names in these tests are made up. No test uses the network.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summary } from "./cli.ts";
import { collect } from "./collect.ts";
import type { FetchFn } from "./collect.ts";
import { docId, writeDb } from "./db.ts";
import { buildGraph, publicView } from "./graph.ts";
import { globToRegExp, matchWorkspaces, parseNpmLock, parsePnpmLock, parseSpec } from "./parse.ts";
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
}

function fakeFetch(repos: FakeRepo[], npm: Record<string, string | null>, calls: string[] = []): FetchFn {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (url.startsWith(REG)) {
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
      return json({ tree: Object.keys(r.files).map((path) => ({ path, type: "blob" })), truncated: false });
    }
    const content = /^\/repos\/example-owner\/([^/]+)\/contents\/(.+)$/.exec(p);
    if (content) {
      const r = repos.find((x) => x.name === content[1]);
      const text = r?.files[decodeURIComponent(content[2] as string)];
      return text === undefined ? new Response("", { status: 404 }) : new Response(text);
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
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/fresh:\n    dependencies:\n      '@ex/core':\n        specifier: workspace:*\n        version: link:../core\n",
    },
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
    expect(globToRegExp("packages/*").test("packages/a")).toBe(true);
    expect(globToRegExp("packages/*").test("packages/a/b")).toBe(false);
    expect(globToRegExp("apps/**").test("apps/a/b")).toBe(true);
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
    expect(alert.relay).toContain("strategist");
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
