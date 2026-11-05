import { describe, expect, it } from "vitest";
import type { FetchFn } from "./collect.ts";
import type { GhResponse, GitHub } from "./github.ts";
import { LAG_LIMIT_MS, RED_LIMIT_MS, isReleased, lagOver, lagReport, lagSummary, publishedPaths, usedManifest } from "./lag.ts";
import type { PackageNode } from "./types.ts";

const NOW = new Date("2026-11-04T12:00:00Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const OLD = "a".repeat(40);

const pkg = (name: string, over: Partial<PackageNode> = {}): PackageNode => ({
  name,
  repo: "r",
  path: "packages/x",
  version: "1.0.0",
  repoPrivate: false,
  npm: { exists: true, latest: "1.0.0" },
  ...over,
});

const ghOf = (routes: Record<string, unknown>): GitHub => ({
  async request<T>(_method: string, path: string): Promise<GhResponse<T>> {
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (key === undefined) return { status: 404, ok: false, data: null, message: "Not Found" };
    return { status: 200, ok: true, data: routes[key] as T, message: null };
  },
  graphql: async () => ({ data: null, errors: [] }),
});

const npmOf = (gitHead: string | null): FetchFn => async () => new Response(JSON.stringify({ gitHead, dist: {} }), { status: 200 });

const commit = (sha: string, date: string, title = "feat: a change"): { sha: string; commit: { message: string; committer: { date: string } } } => ({
  sha,
  commit: { message: `${title}\n\nbody`, committer: { date } },
});

const run = async (packages: PackageNode[], routes: Record<string, unknown>, gitHead: string | null = OLD) =>
  lagReport({ owner: "o", gh: ghOf({ "/search/issues": { items: [] }, ...routes }), packages, branches: new Map([["r", "main"]]), fetch: npmOf(gitHead), now: NOW });

describe("isReleased", () => {
  it("counts the source and the manifest of the package", () => {
    expect(isReleased("packages/x/src/a.ts", "packages/x")).toBe(true);
    expect(isReleased("packages/x/package.json", "packages/x")).toBe(true);
    expect(isReleased("src/a.ts", "")).toBe(true);
  });

  it("does not count another package, a test, a text or the settings of a tool", () => {
    for (const f of ["packages/x/site/a.ts", "packages/x/.gitignore", "packages/x/renovate.json", "packages/y/src/a.ts", "packages/x/src/a.test.ts", "packages/x/src/a.test.unit.ts", "packages/x/test/api/report.txt", "packages/x/README.md", "packages/x/tsconfig.test.json", "packages/x/docs/a.ts", "packages/x/bench/a.ts", "packages/x/vitest.config.ts"]) {
      expect(isReleased(f, "packages/x")).toBe(false);
    }
  });
});

describe("the files list of a package", () => {
  const prober = publishedPaths({ main: "./src/index.ts", files: ["build", "bpf/prober.h", "native/src", "fixtures/records.bin", "README.md", "LICENSE"] });

  it("counts a listed file, also in a folder that the names do not count", () => {
    expect(isReleased("packages/x/fixtures/records.bin", "packages/x", prober)).toBe(true);
    expect(isReleased("packages/x/native/src/a.rs", "packages/x", prober)).toBe(true);
  });

  it("counts the source of a package that lists the output of its build", () => {
    expect(isReleased("packages/x/src/a.ts", "packages/x", prober)).toBe(true);
    expect(isReleased("packages/x/src/a.ts", "packages/x", publishedPaths({ files: ["native"] }))).toBe(false);
  });

  it("does not count a file that the package does not publish, a test or a text", () => {
    for (const f of ["packages/x/image/compare.sh", "packages/x/src/a.test.ts", "packages/x/README.md", "packages/x/LICENSE"]) {
      expect(isReleased(f, "packages/x", prober)).toBe(false);
    }
  });

  it("counts the main file and the bin files, because npm publishes them with any list", () => {
    const list = publishedPaths({ files: ["build/"], main: "./entry.js", bin: { a: "./cli/a.js" } });
    expect(isReleased("packages/x/entry.js", "packages/x", list)).toBe(true);
    expect(isReleased("packages/x/cli/a.js", "packages/x", list)).toBe(true);
  });

  it("leaves out a negated item, so a build config does not count and the source does", () => {
    const list = publishedPaths({ files: ["build", "src", "!src/**/*.test.ts", "!src/fc-setup.ts"] });
    expect(list).toEqual(["build", "src"]);
    expect(isReleased("packages/x/tsdown.config.ts", "packages/x", list)).toBe(false);
    expect(isReleased("packages/x/src/a.ts", "packages/x", list)).toBe(true);
  });

  it("gives no list for a wildcard, so the names of the files decide", () => {
    expect(publishedPaths({ files: ["build/*.js"] })).toBeNull();
    expect(publishedPaths({})).toBeNull();
    expect(publishedPaths({ files: ["build/**"] })).toEqual(["build"]);
  });
});

describe("usedManifest", () => {
  it("does not change for the fields of the tools, and changes for a runtime dependency", () => {
    const base = { name: "x", dependencies: { a: "^1.0.0" } };
    const tools = { version: "2.0.0", devDependencies: { b: "^2.0.0" }, scripts: { t: "t" }, conventions: { rules: {} } };
    expect(usedManifest({ ...base, ...tools })).toBe(usedManifest(base));
    expect(usedManifest({ ...base, dependencies: { a: "^2.0.0" } })).not.toBe(usedManifest(base));
  });
});

const encodedManifest = (m: unknown): { content: string } => ({ content: Buffer.from(JSON.stringify(m)).toString("base64") });

describe("lagReport", () => {
  it("does not report a package.json with a change of its tools only", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: [commit("b1", ago(9 * 24 * HOUR))], files: [{ filename: "packages/x/package.json" }] },
      [`/repos/o/r/contents/packages/x/package.json?ref=${OLD}`]: encodedManifest({ name: "x", devDependencies: { a: "1" } }),
      "/repos/o/r/contents/packages/x/package.json?ref=main": encodedManifest({ name: "x", devDependencies: { a: "2" } }),
    });
    expect(r.rows).toEqual([]);
  });

  it("reports a package.json with a new runtime dependency", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: [commit("b1", ago(9 * 24 * HOUR))], files: [{ filename: "packages/x/package.json" }] },
      "/repos/o/r/commits/b1": { files: [{ filename: "packages/x/package.json" }] },
      [`/repos/o/r/contents/packages/x/package.json?ref=${OLD}`]: encodedManifest({ name: "x", dependencies: { a: "1" } }),
      "/repos/o/r/contents/packages/x/package.json?ref=b1": encodedManifest({ name: "x", dependencies: { a: "2" } }),
      "/repos/o/r/contents/packages/x/package.json?ref=main": encodedManifest({ name: "x", dependencies: { a: "2" } }),
    });
    expect(r.rows[0]).toMatchObject({ reason: "kept-version", over: true, files: 1 });
  });

  it("starts the age at the commit that moved a runtime field, and not at an earlier change of the tools", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: {
        status: "ahead",
        commits: [commit("b1", ago(9 * 24 * HOUR)), commit("b2", ago(HOUR))],
        files: [{ filename: "packages/x/package.json" }],
      },
      "/repos/o/r/commits/b1": { files: [{ filename: "packages/x/package.json" }] },
      "/repos/o/r/commits/b2": { files: [{ filename: "packages/x/package.json" }] },
      [`/repos/o/r/contents/packages/x/package.json?ref=${OLD}`]: encodedManifest({ name: "x", dependencies: { a: "1" } }),
      "/repos/o/r/contents/packages/x/package.json?ref=b1": encodedManifest({ name: "x", dependencies: { a: "1" }, devDependencies: { b: "1" } }),
      "/repos/o/r/contents/packages/x/package.json?ref=b2": encodedManifest({ name: "x", dependencies: { a: "2" } }),
      "/repos/o/r/contents/packages/x/package.json?ref=main": encodedManifest({ name: "x", dependencies: { a: "2" } }),
    });
    expect(r.rows[0]).toMatchObject({ over: false, firstChange: { sha: "b2" } });
  });

  it("counts a package.json that it cannot read as a change, so a fault gives a row", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: [commit("b1", ago(HOUR))], files: [{ filename: "packages/x/package.json" }] },
      "/repos/o/r/commits/b1": { files: [{ filename: "packages/x/package.json" }] },
    });
    expect(r.rows).toHaveLength(1);
  });

  it("reports a kept version: the source moved, the number did not, and no release starts", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: [commit("b1", ago(3 * 24 * HOUR))], files: [{ filename: "packages/x/src/a.ts" }] },
      "/repos/o/r/commits/b1": { files: [{ filename: "packages/x/src/a.ts" }] },
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ package: "@o/x", reason: "kept-version", over: true, ageDays: 3, files: 1, partial: false });
    expect(lagOver(r)).toBe(true);
    expect(lagSummary(r)).toContain("the version did not change");
  });

  it("reports a new version that npm does not have", async () => {
    const r = await run([pkg("@o/x", { version: "1.1.0" })], {
      [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: [commit("b1", ago(HOUR))], files: [{ filename: "packages/x/package.json" }] },
      "/repos/o/r/commits/b1": { files: [{ filename: "packages/x/package.json" }] },
    });
    expect(r.rows[0]).toMatchObject({ reason: "release-missing", over: false });
    expect(lagOver(r)).toBe(false);
  });

  it("dates the change by the first commit that touches the package, not the first commit of the repository", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: {
        status: "ahead",
        commits: [commit("b1", ago(10 * 24 * HOUR), "other package"), commit("b2", ago(HOUR), "this package")],
        files: [{ filename: "packages/y/src/a.ts" }, { filename: "packages/x/src/a.ts" }],
      },
      "/repos/o/r/commits/b1": { files: [{ filename: "packages/y/src/a.ts" }] },
      "/repos/o/r/commits/b2": { files: [{ filename: "packages/x/src/a.ts" }] },
    });
    expect(r.rows[0]?.firstChange.title).toBe("this package");
    expect(r.rows[0]?.over).toBe(false);
  });

  it("does not report a package with only tests or text after its release", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: [commit("b1", ago(9 * 24 * HOUR))], files: [{ filename: "packages/x/src/a.test.ts" }, { filename: "packages/x/README.md" }] },
    });
    expect(r.rows).toEqual([]);
  });

  it("does not report a change to a file that the files list leaves out", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: [commit("b1", ago(9 * 24 * HOUR))], files: [{ filename: "packages/x/image/compare.sh" }] },
      "/repos/o/r/contents/packages/x/package.json?ref=main": encodedManifest({ files: ["build"] }),
    });
    expect(r.rows).toEqual([]);
  });

  it("reports a change to a listed file in a folder that the names do not count", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: [commit("b1", ago(9 * 24 * HOUR))], files: [{ filename: "packages/x/fixtures/a.bin" }] },
      "/repos/o/r/commits/b1": { files: [{ filename: "packages/x/fixtures/a.bin" }] },
      "/repos/o/r/contents/packages/x/package.json?ref=main": encodedManifest({ files: ["fixtures"] }),
    });
    expect(r.rows[0]?.over).toBe(true);
  });

  it("does not start the clock at a docs or style commit", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: {
        status: "ahead",
        commits: [commit("b1", ago(9 * 24 * HOUR), "docs: a comment"), commit("b2", ago(HOUR), "fix: a change")],
        files: [{ filename: "packages/x/src/a.ts" }],
      },
      "/repos/o/r/commits/b1": { files: [{ filename: "packages/x/src/a.ts" }] },
      "/repos/o/r/commits/b2": { files: [{ filename: "packages/x/src/a.ts" }] },
    });
    expect(r.rows[0]?.firstChange.title).toBe("fix: a change");
    expect(r.rows[0]?.over).toBe(false);
  });

  it("does not report a package when each change comes from a docs or style commit", async () => {
    const r = await run([pkg("@o/x")], {
      [`/repos/o/r/compare/${OLD}...main`]: {
        status: "ahead",
        total_commits: 2,
        commits: [commit("b1", ago(9 * 24 * HOUR), "docs(core): a comment"), commit("b2", ago(9 * 24 * HOUR), "style: a format")],
        files: [{ filename: "packages/x/src/a.ts" }],
      },
    });
    expect(r.rows).toEqual([]);
  });

  it("keeps a row when the read of the commits stops before their end", async () => {
    const many = [commit("d0", ago(HOUR), "docs: a comment"), ...Array.from({ length: 70 }, (_, i) => commit(`c${i}`, ago(HOUR)))];
    const routes: Record<string, unknown> = { [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", total_commits: 71, commits: many, files: [{ filename: "packages/x/src/a.ts" }] } };
    for (const c of many) routes[`/repos/o/r/commits/${c.sha}`] = { files: [{ filename: "other.ts" }] };
    const r = await run([pkg("@o/x")], routes);
    expect(r.rows[0]?.partial).toBe(true);
  });

  describe("the commits of the folder", () => {
    const base = commit("p0", ago(20 * 24 * HOUR));
    const folderRoute = `/repos/o/r/commits?path=packages%2Fx&sha=main&since=${encodeURIComponent(base.commit.committer.date)}&per_page=100`;
    const others = Array.from({ length: 70 }, (_, i) => commit(`c${i}`, ago(10 * 24 * HOUR)));
    const answer = { status: "ahead", base_commit: base, total_commits: 71, commits: others, files: [{ filename: "packages/x/src/a.ts" }] };

    it("does not report a change that only a docs commit makes, in a repository with many commits", async () => {
      const r = await run([pkg("@o/x")], {
        [`/repos/o/r/compare/${OLD}...main`]: answer,
        [folderRoute]: [commit("d1", ago(9 * 24 * HOUR), "docs: comments"), base],
      });
      expect(r.rows).toEqual([]);
    });

    it("gives the first commit of the folder that changes a published file, newest last", async () => {
      const r = await run([pkg("@o/x")], {
        [`/repos/o/r/compare/${OLD}...main`]: answer,
        [folderRoute]: [commit("f2", ago(HOUR), "fix: later"), commit("f1", ago(9 * 24 * HOUR), "fix: first"), base],
        "/repos/o/r/commits/f1": { files: [{ filename: "packages/x/src/a.ts" }] },
        "/repos/o/r/commits/f2": { files: [{ filename: "packages/x/src/a.ts" }] },
      });
      expect(r.rows[0]?.firstChange.title).toBe("fix: first");
      expect(r.rows[0]?.partial).toBe(false);
      expect(r.rows[0]?.over).toBe(true);
    });

    it("keeps a row when the page of the folder is full, because more commits can follow", async () => {
      const full = Array.from({ length: 100 }, (_, i) => commit(`d${i}`, ago(HOUR), "docs: comments"));
      const r = await run([pkg("@o/x")], { [`/repos/o/r/compare/${OLD}...main`]: answer, [folderRoute]: full });
      expect(r.rows[0]?.partial).toBe(true);
    });

    it("reads the commits of the comparison when the read of the folder fails", async () => {
      const r = await run([pkg("@o/x")], {
        [`/repos/o/r/compare/${OLD}...main`]: { ...answer, total_commits: 1, commits: [commit("g1", ago(9 * 24 * HOUR))] },
        "/repos/o/r/commits/g1": { files: [{ filename: "packages/x/src/a.ts" }] },
      });
      expect(r.rows[0]?.over).toBe(true);
    });
  });

  it("does not report a package at the head of the branch", async () => {
    const r = await run([pkg("@o/x")], { [`/repos/o/r/compare/${OLD}...main`]: { status: "identical", commits: [], files: [] } });
    expect(r.rows).toEqual([]);
    expect(r.unread).toEqual([]);
    expect(r.packages).toBe(1);
  });

  it("does not read a package that is not on npm, or that another person publishes", async () => {
    const r = await run([pkg("@o/x", { npm: { exists: false, latest: null } }), pkg("@o/y", { npm: { exists: true, latest: "1.0.0", foreign: true } })], {});
    expect(r.packages).toBe(0);
  });

  it("gives a package with no commit as not read, and the other packages continue", async () => {
    const r = await run([pkg("@o/x")], {}, null);
    expect(r.unread).toMatchObject([{ package: "@o/x" }]);
    expect(lagSummary(r)).toContain("## Not read");
    expect(lagOver(r)).toBe(false);
  });

  it("gives a failed compare as not read", async () => {
    const r = await run([pkg("@o/x")], {});
    expect(r.unread[0]?.detail).toContain("did not compare");
  });

  it("states that the change is older when the walk stops", async () => {
    const many = Array.from({ length: 70 }, (_, i) => commit(`c${i}`, ago(HOUR)));
    const routes: Record<string, unknown> = { [`/repos/o/r/compare/${OLD}...main`]: { status: "ahead", commits: many, files: [{ filename: "packages/x/src/a.ts" }] } };
    for (const c of many) routes[`/repos/o/r/commits/${c.sha}`] = { files: [{ filename: "other.ts" }] };
    const r = await run([pkg("@o/x")], routes);
    expect(r.rows[0]?.partial).toBe(true);
    expect(lagSummary(r)).toContain("over 0");
  });

  it("gives the limits in the units of the rule", () => {
    expect(LAG_LIMIT_MS).toBe(48 * HOUR);
    expect(RED_LIMIT_MS).toBe(24 * HOUR);
  });
});

describe("the red pull requests of the train", () => {
  const search = (n: number) => ({ items: [{ number: n, title: "update", html_url: `https://github.com/o/r/pull/${n}`, repository_url: "https://api.github.com/repos/o/r" }] });

  it("reports a failed check over one day, and only the failed checks", async () => {
    const r = await run([], {
      "/search/issues": search(7),
      "/repos/o/r/pulls/7": { head: { sha: "h" } },
      "/repos/o/r/commits/h/check-runs": { check_runs: [{ name: "ok", conclusion: "success", completed_at: ago(HOUR) }, { name: "test", conclusion: "failure", completed_at: ago(30 * HOUR) }] },
    });
    expect(r.red[0]).toMatchObject({ number: 7, checks: ["test"], over: true });
    expect(lagOver(r)).toBe(true);
    expect(lagSummary(r)).toContain("[r #7]");
  });

  it("starts the age at the first block, so a new head of the train does not reset it", async () => {
    const r = await run([], {
      "/search/issues": search(7),
      "/repos/o/r/pulls/7": { head: { sha: "h" } },
      "/repos/o/r/commits/h/check-runs": { check_runs: [{ name: "test", conclusion: "failure", completed_at: ago(HOUR) }, { name: "test", conclusion: "failure", completed_at: ago(HOUR) }] },
      "/repos/o/r/issues/7/events": [
        { event: "labeled", created_at: ago(72 * HOUR), label: { name: "other" } },
        { event: "labeled", created_at: ago(50 * HOUR), label: { name: "release-train:blocked" } },
        { event: "unlabeled", created_at: ago(49 * HOUR), label: { name: "release-train:blocked" } },
      ],
    });
    expect(r.red[0]).toMatchObject({ checks: ["test"], over: true, ageDays: 2.1 });
  });

  it("does not count a failure under one day, or a pull request with no failure", async () => {
    const young = await run([], {
      "/search/issues": search(7),
      "/repos/o/r/pulls/7": { head: { sha: "h" } },
      "/repos/o/r/commits/h/check-runs": { check_runs: [{ name: "test", conclusion: "failure", completed_at: ago(HOUR) }] },
    });
    expect(young.red[0]?.over).toBe(false);
    expect(lagOver(young)).toBe(false);
    const green = await run([], {
      "/search/issues": search(7),
      "/repos/o/r/pulls/7": { head: { sha: "h" } },
      "/repos/o/r/commits/h/check-runs": { check_runs: [{ name: "test", conclusion: "success", completed_at: ago(HOUR) }] },
    });
    expect(green.red).toEqual([]);
  });
});
