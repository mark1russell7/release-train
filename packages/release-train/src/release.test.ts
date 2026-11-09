// All repository and package names in these tests are made up.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { apply, dispatchOnly, prBody, selectUpdates } from "./apply.ts";
import type { RepoUpdate, Updater } from "./apply.ts";
import { gitHub } from "./github.ts";
import type { FetchFn } from "./collect.ts";
import { buildGraph } from "./graph.ts";
import { plan } from "./plan.ts";
import { addChangelogSection, awaitRelease, changesetText, decideBump, decisionBreaks, namesModule, setManifestVersion, typedFiles } from "./release.ts";
import type { Manifest, NpmInfo, RepoSnapshot } from "./types.ts";
import { changesetName, gitUpdater, UPDATE_SCRIPT } from "./workspace.ts";
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
      const file = changeset ? readdirSync(join(opts.cwd, ".changeset")).find((n) => /^release-train-[0-9a-f]{8}\.md$/.test(n)) : undefined;
      if (file) seen.changeset = readFileSync(join(opts.cwd, ".changeset", file), "utf8");
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

  it("adds the section of the new version to the changelog of the package, and keeps the changelog when it has the section", async () => {
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "none" as const };
    const go = async (first: string): Promise<string> => {
      let log = "";
      const inner = runWith(false, [], {});
      const run: RunFn = async (cmd, args, opts) => {
        const out = await inner(cmd, args, opts);
        if (cmd === "git" && args[0] === "clone") writeFileSync(join(opts.cwd, "CHANGELOG.md"), first);
        if (cmd === "git" && args.includes("commit")) log = readFileSync(join(opts.cwd, "CHANGELOG.md"), "utf8");
        return out;
      };
      const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run, fetch: fetchFn });
      expect((await up.update(u, { defaultBranch: "main", rebuild: false })).status).toBe("pushed");
      return log;
    };
    const added = await go("# Changes\n\n## 0.3.0\n\nOld.\n");
    expect(added).toMatch(/^# Changes\n\n## 0\.4\.0\n\nThe release train changes the range of `@ex\/core` to a version outside the old range\. .+\n\n### Breaking\n\n- The range `\^1\.0\.0` of `@ex\/core` in `dependencies` does not hold `2\.0\.0`, so it changes\.\n\n## 0\.3\.0\n\nOld\.\n$/);
    const kept = "## 0.4.0\n\nThe owner wrote this.\n\n## 0.3.0\n";
    expect(await go(kept)).toBe(kept);
  });

  it("marks a break with the heading Breaking and one line for each range", () => {
    expect(addChangelogSection("## 0.3.0\n", "0.4.0", "Why.", ["A.", "B."])).toBe("## 0.4.0\n\nWhy.\n\n### Breaking\n\n- A.\n- B.\n\n## 0.3.0\n");
    expect(addChangelogSection("# C\r\n", "2.0.0", "Why.", ["A."])).toBe("# C\r\n\r\n## 2.0.0\r\n\r\nWhy.\r\n\r\n### Breaking\r\n\r\n- A.\r\n");
    expect(addChangelogSection("## 0.3.0\n", "0.3.1", "Why.", [])).toBe("## 0.3.1\n\nWhy.\n\n## 0.3.0\n");
  });

  it("gives a break for MINOR before 1.0.0 and for MAJOR, and no break for PATCH", () => {
    const types = ["patch", "minor", "major"] as const;
    expect(types.map((type) => decisionBreaks({ type }))).toEqual([false, true, true]);
  });

  it("writes no mark of a break for a patch release", async () => {
    const plain = tgz({ "package/dist/index.d.ts": "export declare const x: number;" });
    const patchFetch: FetchFn = async (url) => (url.endsWith(".tgz") ? new Response(plain, { status: 200 }) : fetchFn(url));
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "none" as const };
    let log = "";
    const inner = runWith(false, [], {});
    const run: RunFn = async (cmd, args, opts) => {
      const out = await inner(cmd, args, opts);
      if (cmd === "git" && args[0] === "clone") writeFileSync(join(opts.cwd, "CHANGELOG.md"), "## 0.3.0\n\nOld.\n");
      if (cmd === "git" && args.includes("commit")) log = readFileSync(join(opts.cwd, "CHANGELOG.md"), "utf8");
      return out;
    };
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run, fetch: patchFetch });
    const r = await up.update(u, { defaultBranch: "main", rebuild: false });
    expect(r.releases?.[0]).toMatchObject({ to: "0.3.1", type: "patch" });
    expect(log).toMatch(/^## 0\.3\.1\n\n.+\n\n## 0\.3\.0\n/);
    expect(log).not.toContain("### Breaking");
    const seen: { manifest?: string; changeset?: string } = {};
    const withSets = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run: runWith(true, [], seen), fetch: patchFetch });
    await withSets.update(u, { defaultBranch: "main", rebuild: false });
    expect(seen.changeset).toContain('"@ex/pub": patch');
    expect(seen.changeset).not.toContain("breaking");
  });

  it("puts a section below Unreleased, reads each form of a heading and keeps the line ends", () => {
    expect(addChangelogSection("# C\n\n## Unreleased\n\n- a\n\n## 1.0.0\n", "1.1.0", "Why.")).toBe("# C\n\n## Unreleased\n\n- a\n\n## 1.1.0\n\nWhy.\n\n## 1.0.0\n");
    expect(addChangelogSection("# C\n", "1.1.0", "Why.")).toBe("# C\n\n## 1.1.0\n\nWhy.\n");
    expect(addChangelogSection("# C\r\n\r\n## 1.0.0\r\n", "1.1.0", "Why.")).toBe("# C\r\n\r\n## 1.1.0\r\n\r\nWhy.\r\n\r\n## 1.0.0\r\n");
    for (const text of ["## 1.1.0\n", "## [1.1.0] (2026-11-05)\n", "## v1.1.0 - notes\n"]) expect(addChangelogSection(text, "1.1.0", "Why."), text).toBeNull();
    expect(addChangelogSection("## 1.1.0-rc.1\n", "1.1.0", "Why.")).toBe("## 1.1.0\n\nWhy.\n\n## 1.1.0-rc.1\n");
  });

  it("keeps a version on main that is already high enough", async () => {
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "none" as const };
    const seen: { manifest?: string } = {};
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run: runWith(false, [], seen, "0.5.0"), fetch: fetchFn });
    const r = await up.update(u, { defaultBranch: "main", rebuild: false });
    expect(r.releases?.[0]?.to).toBe("0.5.0");
    expect(seen.manifest).toContain('"version": "0.5.0"');
  });

  it("starts the version script of the package after the new version, as npm version does", async () => {
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "pnpm" as const };
    const go = async (code: number) => {
      const cmds: string[] = [];
      const seen: { version?: string; env?: NodeJS.ProcessEnv; message?: string } = {};
      const run: RunFn = async (cmd, args, opts) => {
        cmds.push(`${cmd} ${args.join(" ")}`);
        if (cmd === "git" && args[0] === "clone")
          writeFileSync(join(opts.cwd, "package.json"), `{\n  "name": "@ex/pub",\n  "version": "0.3.0",\n  "scripts": { "version": "node scripts/sync.ts" },\n  "dependencies": { "@ex/core": "^1.0.0" }\n}\n`);
        if (cmd === "pnpm" && args[0] === "run" && args[1] === "version") {
          seen.version = (JSON.parse(readFileSync(join(opts.cwd, "package.json"), "utf8")) as { version: string }).version;
          seen.env = opts.env;
          return { code, stdout: "", stderr: code === 0 ? "" : "VERSION and package.json differ" };
        }
        if (cmd === "pnpm" && args[0] === "install")
          writeFileSync(join(opts.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@ex/core':\n        specifier: ^2.0.0\n        version: 2.0.0\n");
        if (cmd === "git" && args.includes("commit")) seen.message = args[args.indexOf("-m") + 1] ?? "";
        const out = cmd === "pnpm" && args[0] === "--version" ? "10.0.0\n" : cmd === "git" && args[0] === "status" ? " M package.json\n" : "";
        return { code: cmd === "git" && args[0] === "fetch" ? 1 : 0, stdout: out, stderr: "" };
      };
      const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run, fetch: fetchFn });
      return { cmds, seen, r: await up.update(u, { defaultBranch: "main", rebuild: false }) };
    };
    const { cmds, seen, r } = await go(0);
    expect(r.status).toBe("pushed");
    // The script sees the new version, after the lockfile, with the packages installed and no git credentials
    expect(seen.version).toBe("0.4.0");
    const script = cmds.indexOf("pnpm run version");
    expect(cmds.slice(0, script)).toContain("pnpm install --lockfile-only --frozen-lockfile");
    expect(cmds.slice(0, script).at(-1)).toBe("pnpm install --frozen-lockfile --ignore-scripts");
    expect(cmds.slice(script + 1)).toContain("pnpm install --lockfile-only");
    expect(Object.keys(seen.env ?? {}).filter((key) => key.startsWith("GIT_CONFIG_"))).toEqual([]);
    expect(seen.message).toContain("- version script: ./package.json");
    const failed = await go(1);
    expect(failed.r).toMatchObject({ status: "failed", error: expect.stringContaining("The version script of ./package.json failed (exit 1): VERSION and package.json differ") });
  });

  it("starts no version script for a version that stays", async () => {
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "none" as const };
    const cmds: string[] = [];
    const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run: runWith(false, cmds, {}, "0.5.0"), fetch: fetchFn });
    await up.update(u, { defaultBranch: "main", rebuild: false });
    expect(cmds.some((c) => c.includes("run version"))).toBe(false);
    expect(cmds.some((c) => c.includes(UPDATE_SCRIPT))).toBe(false);
  });

  it("starts the root script release-train:update after the install of each update, and commits its new files", async () => {
    const u = { ...(selectUpdates(cascadePlan()).ready.find((x) => x.repo === "pub-repo") as RepoUpdate), lockKind: "pnpm" as const };
    const go = async (code: number) => {
      const cmds: string[] = [];
      const seen: { env?: NodeJS.ProcessEnv; message?: string } = {};
      let wrote = false;
      const run: RunFn = async (cmd, args, opts) => {
        cmds.push(`${cmd} ${args.join(" ")}`);
        // The version on main is already high enough, so no version script starts, and the update script starts all the same.
        if (cmd === "git" && args[0] === "clone")
          writeFileSync(join(opts.cwd, "package.json"), `{\n  "name": "@ex/pub",\n  "version": "0.5.0",\n  "scripts": { "version": "node scripts/sync.ts", "${UPDATE_SCRIPT}": "node scripts/data.ts" },\n  "dependencies": { "@ex/core": "^1.0.0" }\n}\n`);
        if (cmd === "git" && args[0] === "ls-files") return { code: 0, stdout: wrote ? "old.txt\ndata/new.json\n" : "old.txt\n", stderr: "" };
        if (cmd === "pnpm" && args[0] === "run" && args[1] === UPDATE_SCRIPT) {
          seen.env = opts.env;
          wrote = code === 0;
          return { code, stdout: "", stderr: code === 0 ? "" : "the engine is missing" };
        }
        if (cmd === "pnpm" && args[0] === "install")
          writeFileSync(join(opts.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@ex/core':\n        specifier: ^2.0.0\n        version: 2.0.0\n");
        if (cmd === "git" && args.includes("commit")) seen.message = args[args.indexOf("-m") + 1] ?? "";
        const out = cmd === "pnpm" && args[0] === "--version" ? "10.0.0\n" : cmd === "git" && args[0] === "status" ? " M package.json\n" : "";
        return { code: cmd === "git" && args[0] === "fetch" ? 1 : 0, stdout: out, stderr: "" };
      };
      const up = gitUpdater({ owner: OWNER, token: "t", author: { name: "a", email: "a@b" }, run, fetch: fetchFn });
      return { cmds, seen, r: await up.update(u, { defaultBranch: "main", rebuild: false }) };
    };
    const { cmds, seen, r } = await go(0);
    expect(r.status).toBe("pushed");
    expect(cmds).not.toContain("pnpm run version");
    // The script starts after the lockfile, with the packages installed and no git credentials
    const script = cmds.indexOf(`pnpm run ${UPDATE_SCRIPT}`);
    expect(script).toBeGreaterThan(-1);
    expect(cmds.slice(0, script)).toContain("pnpm install --lockfile-only --frozen-lockfile");
    expect(cmds.slice(0, script)).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(Object.keys(seen.env ?? {}).filter((key) => key.startsWith("GIT_CONFIG_"))).toEqual([]);
    // Only the new file of the script is staged by name. A file that was untracked before stays out.
    const staged = cmds.filter((c) => c.startsWith("git add -- ")).join(" ");
    expect(staged).toContain("data/new.json");
    expect(staged).not.toContain("old.txt");
    expect(seen.message).toContain(`- script ${UPDATE_SCRIPT} of package.json`);
    const failed = await go(2);
    expect(failed.r).toMatchObject({ status: "failed", error: expect.stringContaining(`The script ${UPDATE_SCRIPT} of package.json failed (exit 2): the engine is missing`) });
    expect(failed.cmds.some((c) => c.includes("commit"))).toBe(false);
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
    expect(seen.changeset).toContain("This release has breaking changes.");
    expect(cmds.some((c) => /^git add -- \.changeset\/release-train-[0-9a-f]{8}\.md$/.test(c))).toBe(true);
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

describe("changesetName", () => {
  it("names the changeset by the fingerprint, and numbers a name that the branch has already", () => {
    expect(changesetName(() => false, "0123456789ab")).toBe("release-train-01234567.md");
    const taken = new Set(["release-train-01234567.md", "release-train-01234567-2.md"]);
    expect(changesetName((n) => taken.has(n), "0123456789ab")).toBe("release-train-01234567-3.md");
  });
});
