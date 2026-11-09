import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, redactNames } from "./cli.ts";
import type { FetchFn } from "./collect.ts";
import {
  MAX_NOTES,
  MIN_AGE_MS,
  backfillTags,
  changelogSection,
  defaultSince,
  provenanceCommit,
  releaseNotes,
  tagName,
  tagRepos,
  tagsSummary,
  validDate,
} from "./tags.ts";
import type { GhFn, TagRepo, TagsInput, TagsReport } from "./tags.ts";
import type { PackageNode, RepoSnapshot } from "./types.ts";

const NOW = new Date("2026-10-25T12:00:00Z");
const SINCE = "2026-10-11";
const OLD = "2026-10-20T00:00:00Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPO_ID = "1234";

const ok = (stdout = ""): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string): { code: number; stdout: string; stderr: string } => ({ code: 1, stdout: "", stderr });

/** This function gives an attestations document, as npm gives it. */
function attestations(commit: string, repositoryId = REPO_ID, predicateType = "https://slsa.dev/provenance/v1"): unknown {
  const statement = {
    predicate: {
      buildDefinition: {
        internalParameters: { github: { repository_id: repositoryId } },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
    },
  };
  return { attestations: [{ predicateType, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] };
}

interface FakeVersion {
  time?: string;
  gitHead?: unknown;
  provenance?: string | { status: number };
}

/** This function gives a fake registry. Each key is a package name. */
function registry(packages: Record<string, Record<string, FakeVersion> | { status: number }>, calls: string[] = []): FetchFn {
  return async (url) => {
    calls.push(url);
    const path = decodeURIComponent(url.replace("https://registry.npmjs.org/", ""));
    if (path.startsWith("-/npm/v1/attestations/")) {
      const key = path.slice("-/npm/v1/attestations/".length);
      const at = key.lastIndexOf("@");
      const versions = packages[key.slice(0, at)] as Record<string, FakeVersion>;
      const p = versions[key.slice(at + 1)]?.provenance;
      if (typeof p === "object") return new Response("{}", { status: p.status });
      return new Response(JSON.stringify(attestations(p ?? "")));
    }
    const doc = packages[path];
    if (doc === undefined) return new Response("{}", { status: 404 });
    if ("status" in doc && typeof doc.status === "number") return new Response("{}", { status: doc.status });
    const versions = doc as Record<string, FakeVersion>;
    return new Response(
      JSON.stringify({
        time: { created: OLD, modified: OLD, ...Object.fromEntries(Object.entries(versions).flatMap(([v, m]) => (m.time === "" ? [] : [[v, m.time ?? OLD]]))) },
        versions: Object.fromEntries(
          Object.entries(versions).map(([v, m]) => [v, { ...(m.gitHead === undefined ? {} : { gitHead: m.gitHead }), dist: m.provenance === undefined ? {} : { attestations: { url: "x" } } }]),
        ),
      }),
    );
  };
}

interface FakeGh {
  gh: GhFn;
  calls: string[][];
  inputs: (string | undefined)[];
}

/** This function gives a fake `gh`. A key of `answers` is a part of the arguments, and the first match answers. */
function fakeGh(answers: Record<string, ReturnType<typeof ok>> = {}): FakeGh {
  const calls: string[][] = [];
  const inputs: (string | undefined)[] = [];
  const defaults: Record<string, ReturnType<typeof ok>> = {
    "git/matching-refs/tags/": ok(""),
    "/compare/": ok("behind\n"),
    "/actions/workflows/release.yml/runs": ok(""),
    "/contents/.github/workflows/release.yml": ok("uses: ex/template/.github/workflows/reusable-release-tag.yml@abc"),
    "/CHANGELOG.md": bad("gh: Not Found (HTTP 404)"),
    "release create": ok("https://example.test/release"),
  };
  const gh: GhFn = async (args, input) => {
    calls.push([...args]);
    inputs.push(input);
    const line = args.join(" ");
    for (const [part, answer] of Object.entries({ ...answers, ...defaults })) if (line.includes(part)) return answers[part] ?? answer;
    if (line === "api repos/ex/one --jq .id" || line === "api repos/ex/many --jq .id") return ok(`${REPO_ID}\n`);
    throw new Error(`The fake gh has no answer for: ${line}`);
  };
  return { gh, calls, inputs };
}

const ONE: TagRepo = { name: "one", private: false, defaultBranch: "main", publishedCount: 1, packages: [{ name: "@ex/one", path: "" }] };

const run = (input: Partial<TagsInput> & { gh: GhFn; fetch: FetchFn }): Promise<TagsReport> =>
  backfillTags({ owner: "ex", repos: [ONE], since: SINCE, write: false, now: NOW, ...input });

const writes = (calls: readonly string[][]): string[][] => calls.filter((c) => c[0] !== "api");

describe("the rule of the tag", () => {
  it("gives v<version> with one published package, and <name>@<version> with more", () => {
    expect(tagName("@ex/a", "1.2.0", 1)).toBe("v1.2.0");
    expect(tagName("@ex/a", "1.2.0", 2)).toBe("@ex/a@1.2.0");
  });

  it("reads each heading form of a changelog section", () => {
    for (const heading of ["## 1.2.0", "## v1.2.0", "## [1.2.0] - 2026-10-18", "# @ex/a@1.2.0 (2026-10-18)"]) {
      expect(changelogSection(`${heading}\n\n- A fix.\n`, "1.2.0", "@ex/a")).toBe("- A fix.");
    }
  });

  it("stops the section at the next heading, but not at a heading in fenced code", () => {
    const text = "## 1.2.0\n- A\n```\n## 9.9.9\n```\n### Sub\n- B\n## 1.1.0\n- C\n";
    expect(changelogSection(text, "1.2.0", "@ex/a")).toBe("- A\n```\n## 9.9.9\n```\n### Sub\n- B");
  });

  it("gives no section for an empty section or another version", () => {
    expect(changelogSection("## 1.2.0\n\n## 1.1.0\n- C\n", "1.2.0", "@ex/a")).toBeUndefined();
    expect(changelogSection("## 1.2.1\n- C\n", "1.2.0", "@ex/a")).toBeUndefined();
  });

  it("gives one list item with a link to npm when no section exists", () => {
    const line = "- Version 1.0.0 of [`@ex/a`](https://www.npmjs.com/package/@ex/a/v/1.0.0) on npm.";
    expect(releaseNotes("@ex/a", "1.0.0", undefined)).toBe(line);
    expect(releaseNotes("@ex/a", "1.0.0", "## 0.9.0\n- Old\n")).toBe(line);
  });

  it("cuts a section that is too long", () => {
    const notes = releaseNotes("@ex/a", "1.0.0", `## 1.0.0\n${"x".repeat(MAX_NOTES + 5)}\n`);
    expect(notes.startsWith("x".repeat(MAX_NOTES))).toBe(true);
    expect(notes).toContain("has the full text");
    expect(notes).not.toContain("x".repeat(MAX_NOTES + 1));
  });
});

describe("provenanceCommit", () => {
  it("gives the commit of a statement of this repository", () => {
    expect(provenanceCommit(attestations(SHA_A) as never, REPO_ID)).toBe(SHA_A);
  });

  it("gives null for a statement of another repository", () => {
    expect(provenanceCommit(attestations(SHA_A, "999") as never, REPO_ID)).toBeNull();
  });

  it("skips a statement of another type, a payload that does not parse and a short commit", () => {
    expect(provenanceCommit(attestations(SHA_A, REPO_ID, "https://github.com/npm/attestation/tree/main/specs/publish/v0.1") as never, REPO_ID)).toBeNull();
    expect(provenanceCommit({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: "e30x" } } }] }, REPO_ID)).toBeNull();
    expect(provenanceCommit(attestations("abc123") as never, REPO_ID)).toBeNull();
    expect(provenanceCommit({}, REPO_ID)).toBeNull();
  });
});

describe("the options of the command line", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has a start date 14 days before today and no write by default", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(parseArgs(["tags"])).toMatchObject({ command: "tags", since: "2026-10-11", write: false });
  });

  it("counts the 14 days in UTC, over the end of a month and a leap day", () => {
    expect(defaultSince(new Date("2026-11-04T23:59:59Z"))).toBe("2026-10-21");
    expect(defaultSince(new Date("2026-11-04T00:00:00Z"))).toBe("2026-10-21");
    expect(defaultSince(new Date("2028-03-10T12:00:00Z"))).toBe("2028-02-25");
  });

  it("reads an older date when asked", () => {
    expect(parseArgs(["tags", "--since", "2026-01-01"]).since).toBe("2026-01-01");
  });

  it("reads --since and --write", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(parseArgs(["tags", "--since", "2026-10-20", "--write"])).toMatchObject({ since: "2026-10-20", write: true });
  });

  it("refuses --write with a date older than 14 days, in each order of the options", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(() => parseArgs(["tags", "--since", "2026-10-10", "--write"])).toThrow("--write needs a start date of 2026-10-11 or later");
    expect(() => parseArgs(["tags", "--write", "--since", "2026-10-10"])).toThrow("--write needs a start date of 2026-10-11 or later");
    expect(() => parseArgs(["tags", "--dry-run", "--write", "--since", "2026-10-10"])).toThrow("--write needs a start date");
  });

  it("keeps --write at the first date of the window, and with the default date", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(parseArgs(["tags", "--since", "2026-10-11", "--write"]).write).toBe(true);
    expect(parseArgs(["tags", "--write"])).toMatchObject({ since: "2026-10-11", write: true });
  });

  it("refuses a date that is not in the calendar", () => {
    expect(validDate("2026-02-28")).toBe(true);
    for (const date of ["2026-02-31", "2026-13-01", "2026-1-1", "soon"]) {
      expect(validDate(date)).toBe(false);
      expect(() => parseArgs(["tags", "--since", date])).toThrow("--since needs a date");
    }
  });
});

describe("tagRepos", () => {
  const node = (name: string, repo: string, exists = true): PackageNode => ({ name, repo, path: name, version: "1.0.0", repoPrivate: false, npm: { exists, latest: null } });
  const snapshot = (name: string, manifests: RepoSnapshot["manifests"]): RepoSnapshot => ({ name, private: false, defaultBranch: "trunk", manifests, lockKind: "pnpm", resolved: {}, warnings: [] });
  const repos = [
    snapshot("a", [{ path: "", manifest: { name: "root", private: true } }, { path: "x", manifest: { name: "@ex/x" } }, { path: "y", manifest: { name: "@ex/y" } }, { path: "z", manifest: {} }]),
    snapshot("b", [{ path: "", manifest: { name: "@ex/b" } }]),
    snapshot("c", [{ path: "", manifest: { name: "@ex/c" } }]),
  ];
  const packages = [node("@ex/x", "a"), node("@ex/y", "a", false), node("@ex/b", "b"), node("@ex/c", "c", false)];

  it("counts each published package of the repository, and keeps only the packages on npm", () => {
    expect(tagRepos(repos, packages)).toEqual([
      { name: "a", private: false, defaultBranch: "trunk", publishedCount: 2, packages: [{ name: "@ex/x", path: "@ex/x" }] },
      { name: "b", private: false, defaultBranch: "trunk", publishedCount: 1, packages: [{ name: "@ex/b", path: "@ex/b" }] },
    ]);
  });

  it("keeps only the repositories of --only", () => {
    expect(tagRepos(repos, packages, ["b"]).map((r) => r.name)).toEqual(["b"]);
  });
});

describe("backfillTags", () => {
  it("reports a version with no tag, and a dry run makes no write", async () => {
    const f = fakeGh();
    const r = await run({ gh: f.gh, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
    expect(r.rows).toEqual([
      { repo: "one", private: false, package: "@ex/one", version: "1.0.0", published: "2026-10-20", tag: "v1.0.0", commit: SHA_A, state: "missing", detail: "The commit is on the default branch." },
    ]);
    expect(r).toMatchObject({ versions: 1, tagged: 0, write: false });
    expect(writes(f.calls)).toEqual([]);
    expect(f.calls.flat()).not.toContain("POST");
    expect(f.inputs.every((x) => x === undefined)).toBe(true);
  });

  it("does not read the release text in a dry run", async () => {
    const f = fakeGh();
    await run({ gh: f.gh, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
    expect(f.calls.some((c) => c.join(" ").includes("CHANGELOG"))).toBe(false);
  });

  it("makes the release with --write: the target, the text on standard input and --latest=false", async () => {
    const f = fakeGh({ "/CHANGELOG.md": ok("## 1.0.0\n- A fix.\n") });
    const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
    expect(writes(f.calls)).toEqual([["release", "create", "v1.0.0", "--repo", "ex/one", "--target", SHA_A, "--title", "v1.0.0", "--notes-file", "-", "--latest=false"]]);
    expect(f.inputs.at(-1)).toBe("- A fix.");
    expect(r.rows[0]).toMatchObject({ state: "created", commit: SHA_A });
  });

  it("marks a version with a hyphen as a prerelease", async () => {
    const f = fakeGh();
    await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0-rc.1": { gitHead: SHA_A } } }) });
    expect(writes(f.calls)[0]?.slice(-2)).toEqual(["--latest=false", "--prerelease"]);
  });

  it("reads the changelog of the package folder at the commit, and uses the npm link without a changelog", async () => {
    const f = fakeGh();
    const repo: TagRepo = { ...ONE, name: "many", publishedCount: 2, packages: [{ name: "@ex/a", path: "packages/a" }] };
    await run({ gh: f.gh, write: true, repos: [repo], fetch: registry({ "@ex/a": { "1.0.0": { gitHead: SHA_A } } }) });
    expect(f.calls.flat()).toContain(`repos/ex/many/contents/packages/a/CHANGELOG.md?ref=${SHA_A}`);
    expect(f.inputs.at(-1)).toBe("- Version 1.0.0 of [`@ex/a`](https://www.npmjs.com/package/@ex/a/v/1.0.0) on npm.");
    expect(writes(f.calls)[0]?.[2]).toBe("@ex/a@1.0.0");
  });

  it("makes no release when the changelog is not readable", async () => {
    const f = fakeGh({ "/CHANGELOG.md": bad("gh: Server Error (HTTP 502)") });
    const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
    expect(writes(f.calls)).toEqual([]);
    expect(r.rows[0]).toMatchObject({ state: "failed", detail: "gh did not read the changelog: gh: Server Error (HTTP 502)" });
  });

  it("reports a refused release, and goes to the next version", async () => {
    const f = fakeGh({ "release create v1.0.0": bad("HTTP 403: Resource not accessible") });
    const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, time: "2026-10-12T00:00:00Z" }, "1.1.0": { gitHead: SHA_B, time: "2026-10-13T00:00:00Z" } } }) });
    expect(r.rows.map((x) => x.state)).toEqual(["failed", "created"]);
    expect(r.rows[0]?.detail).toContain("HTTP 403");
  });

  it("makes the releases of a package from the oldest version to the newest", async () => {
    const f = fakeGh();
    const fetchFn = registry({ "@ex/one": { "1.1.0": { gitHead: SHA_A, time: "2026-10-13T00:00:00Z" }, "1.0.0": { gitHead: SHA_B, time: "2026-10-12T00:00:00Z" } } });
    await run({ gh: f.gh, write: true, fetch: fetchFn });
    expect(writes(f.calls).map((c) => c[2])).toEqual(["v1.0.0", "v1.1.0"]);
  });

  it("skips a version with a tag of either form", async () => {
    const f = fakeGh({ "git/matching-refs/tags/": ok("refs/tags/v1.0.0\nrefs/tags/@ex/one@1.1.0\n") });
    const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A }, "1.1.0": { gitHead: SHA_A } } }) });
    expect(r).toMatchObject({ versions: 2, tagged: 2, rows: [] });
    expect(writes(f.calls)).toEqual([]);
  });

  it("skips a version from before the start date, and keeps a version of that date", async () => {
    const f = fakeGh();
    const r = await run({
      gh: f.gh,
      fetch: registry({ "@ex/one": { "0.9.0": { gitHead: SHA_A, time: "2026-10-10T23:59:59Z" }, "1.0.0": { gitHead: SHA_B, time: "2026-10-11T00:00:00Z" } } }),
    });
    expect(r.versions).toBe(1);
    expect(r.rows.map((x) => x.version)).toEqual(["1.0.0"]);
  });

  it("asks gh nothing for a package with no version from the start date", async () => {
    const f = fakeGh();
    const r = await run({ gh: f.gh, since: "2026-11-01", fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
    expect(r).toMatchObject({ versions: 0, rows: [] });
    expect(f.calls).toEqual([]);
  });

  it("waits for a young version, so the release run can make its tag", async () => {
    const f = fakeGh();
    const time = new Date(NOW.getTime() - MIN_AGE_MS + 1000).toISOString();
    const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, time } } }) });
    expect(r.rows[0]).toMatchObject({ state: "young", commit: null });
    expect(writes(f.calls)).toEqual([]);
  });

  it("does not wait for a young version when each release run of its commit is done, so a refused tag gets made at once", async () => {
    const time = new Date(NOW.getTime() - MIN_AGE_MS + 1000).toISOString();
    const at = async (runs: ReturnType<typeof ok>) => {
      const f = fakeGh({ "/actions/workflows/release.yml/runs": runs });
      const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, time } } }) });
      return { r, f };
    };
    const done = await at(ok("completed\ncompleted\n"));
    expect(done.r.rows[0]).toMatchObject({ state: "created", commit: SHA_A });
    expect(done.f.calls.some((c) => c.join(" ").includes(`runs?head_sha=${SHA_A}`))).toBe(true);
    // A run that is not done, no run yet, or an error of the read: the version waits.
    for (const runs of [ok("completed\nqueued\n"), ok(""), bad("gh: Server Error (HTTP 502)")]) {
      const w = await at(runs);
      expect(w.r.rows[0]).toMatchObject({ state: "young", commit: null });
      expect(writes(w.f.calls)).toEqual([]);
    }
  });

  it("makes no tag in a repository with no tag job, or with no release.yml", async () => {
    for (const answer of [ok("name: Release\n"), bad("gh: Not Found (HTTP 404)")]) {
      const f = fakeGh({ "/contents/.github/workflows/release.yml": answer });
      const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
      expect(r.rows[0]).toMatchObject({ state: "no-tag-job", commit: null });
      expect(writes(f.calls)).toEqual([]);
    }
  });

  it("makes no tag when release.yml is not readable", async () => {
    const f = fakeGh({ "/contents/.github/workflows/release.yml": bad("gh: Server Error (HTTP 502)") });
    const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
    expect(r.rows[0]).toMatchObject({ state: "error" });
    expect(writes(f.calls)).toEqual([]);
  });

  describe("the commit", () => {
    it("comes from the provenance when npm has no gitHead", async () => {
      const f = fakeGh();
      const r = await run({ gh: f.gh, fetch: registry({ "@ex/one": { "1.0.0": { provenance: SHA_B } } }) });
      expect(r.rows[0]).toMatchObject({ state: "missing", commit: SHA_B });
    });

    it("comes from gitHead when npm has no provenance", async () => {
      const f = fakeGh();
      const r = await run({ gh: f.gh, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, provenance: { status: 404 } } } }) });
      expect(r.rows[0]).toMatchObject({ state: "missing", commit: SHA_A });
    });

    it("is accepted when gitHead and the provenance agree", async () => {
      const f = fakeGh();
      const r = await run({ gh: f.gh, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, provenance: SHA_A } } }) });
      expect(r.rows[0]).toMatchObject({ state: "missing", commit: SHA_A });
    });

    it("gives no tag when gitHead and the provenance differ", async () => {
      const f = fakeGh();
      const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, provenance: SHA_B } } }) });
      expect(r.rows[0]).toMatchObject({ state: "no-commit", commit: null });
      expect(writes(f.calls)).toEqual([]);
    });

    it("gives no tag when npm names no commit, or a gitHead that is not a full commit", async () => {
      for (const gitHead of [undefined, "abc123", 7]) {
        const f = fakeGh();
        const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": gitHead === undefined ? {} : { gitHead } } }) });
        expect(r.rows[0]).toMatchObject({ state: "no-commit", commit: null });
        expect(writes(f.calls)).toEqual([]);
      }
    });

    it("gives no tag when the provenance is of another repository", async () => {
      const fetchFn: FetchFn = async (url) =>
        url.includes("attestations")
          ? new Response(JSON.stringify(attestations(SHA_A, "999")))
          : registry({ "@ex/one": { "1.0.0": { provenance: SHA_A } } })(url);
      const r = await run({ gh: fakeGh().gh, fetch: fetchFn });
      expect(r.rows[0]).toMatchObject({ state: "no-commit" });
    });

    it("gives an error row when npm does not give the provenance", async () => {
      const r = await run({ gh: fakeGh().gh, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, provenance: { status: 503 } } } }) });
      expect(r.rows[0]).toMatchObject({ state: "error", detail: "npm gave HTTP 503 for the provenance." });
    });

    it("gives an error row when gh does not read the ID of the repository", async () => {
      const f = fakeGh({ "api repos/ex/one --jq .id": bad("gh: Bad credentials (HTTP 401)") });
      const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { provenance: SHA_A } } }) });
      expect(r.rows[0]).toMatchObject({ state: "error" });
      expect(writes(f.calls)).toEqual([]);
    });
  });

  describe("the default branch", () => {
    it("accepts a commit that the branch has, also its head", async () => {
      for (const status of ["behind", "identical"]) {
        const r = await run({ gh: fakeGh({ "/compare/": ok(`${status}\n`) }).gh, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
        expect(r.rows[0]?.state).toBe("missing");
      }
    });

    it("compares the default branch of the repository with the commit", async () => {
      const f = fakeGh();
      await run({ gh: f.gh, repos: [{ ...ONE, defaultBranch: "trunk" }], fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
      expect(f.calls.flat()).toContain(`repos/ex/one/compare/trunk...${SHA_A}?per_page=1`);
    });

    it("makes no tag for a commit that is not on the branch", async () => {
      for (const answer of [ok("ahead\n"), ok("diverged\n"), bad("gh: Not Found (HTTP 404)"), bad("gh: No common ancestor (HTTP 422)")]) {
        const f = fakeGh({ "/compare/": answer });
        const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
        expect(r.rows[0]).toMatchObject({ state: "off-branch", commit: SHA_A });
        expect(writes(f.calls)).toEqual([]);
      }
    });

    it("gives an error row when the compare fails for another reason", async () => {
      const f = fakeGh({ "/compare/": bad("gh: Server Error (HTTP 500)") });
      const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }) });
      expect(r.rows[0]).toMatchObject({ state: "error", commit: SHA_A });
      expect(writes(f.calls)).toEqual([]);
    });

    it("checks a commit one time, also for versions of two packages", async () => {
      const f = fakeGh();
      const repo: TagRepo = { ...ONE, publishedCount: 2, packages: [{ name: "@ex/a", path: "a" }, { name: "@ex/b", path: "b" }] };
      await run({ gh: f.gh, repos: [repo], fetch: registry({ "@ex/a": { "1.0.0": { gitHead: SHA_A } }, "@ex/b": { "1.0.0": { gitHead: SHA_A } } }) });
      expect(f.calls.filter((c) => c.join(" ").includes("/compare/"))).toHaveLength(1);
    });
  });

  describe("a read that fails", () => {
    it("gives an error row when npm does not give the package", async () => {
      const f = fakeGh();
      const r = await run({ gh: f.gh, fetch: registry({ "@ex/one": { status: 500 } }) });
      expect(r.rows[0]).toMatchObject({ state: "error", version: "?", published: "?", detail: "npm gave HTTP 500 for the package." });
    });

    it("gives an error row when npm gives no publish time", async () => {
      const f = fakeGh();
      const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, time: "" } } }) });
      expect(r.rows[0]).toMatchObject({ state: "error", published: "?" });
      expect(writes(f.calls)).toEqual([]);
    });

    it("gives an error row for each version when gh does not list the tags", async () => {
      const f = fakeGh({ "git/matching-refs/tags/": bad("gh: Server Error (HTTP 500)") });
      const r = await run({ gh: f.gh, write: true, fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A }, "1.1.0": { gitHead: SHA_A } } }) });
      expect(r.rows.map((x) => x.state)).toEqual(["error", "error"]);
      expect(f.calls.filter((c) => c.join(" ").includes("matching-refs"))).toHaveLength(1);
      expect(writes(f.calls)).toEqual([]);
    });

    it("refuses a tag that gh can read as a flag", async () => {
      const f = fakeGh();
      const repo: TagRepo = { ...ONE, publishedCount: 2, packages: [{ name: "-flag", path: "" }] };
      const r = await run({ gh: f.gh, write: true, repos: [repo], fetch: registry({ "-flag": { "1.0.0": { gitHead: SHA_A } } }) });
      expect(r.rows[0]).toMatchObject({ state: "error" });
      expect(writes(f.calls)).toEqual([]);
    });
  });
});

describe("the limit of a write", () => {
  it("refuses a write from before the window, and reads and writes nothing", async () => {
    const f = fakeGh();
    const npm: string[] = [];
    const input = { gh: f.gh, write: true, since: "2026-10-10", fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A } } }, npm) };
    await expect(run(input)).rejects.toThrow("--write needs a start date of 2026-10-11 or later, not 2026-10-10.");
    expect(f.calls).toEqual([]);
    expect(npm).toEqual([]);
  });

  it("lets a dry run read a date from before the window", async () => {
    const f = fakeGh();
    const r = await run({ gh: f.gh, since: "2026-01-01", fetch: registry({ "@ex/one": { "1.0.0": { gitHead: SHA_A, time: "2026-02-01T00:00:00Z" } } }) });
    expect(r.rows.map((x) => x.state)).toEqual(["missing"]);
    expect(writes(f.calls)).toEqual([]);
  });
});

describe("the count of processes", () => {
  const repo = (name: string, ...packages: string[]): TagRepo => ({ name, private: false, defaultBranch: "main", publishedCount: packages.length, packages: packages.map((p) => ({ name: p, path: "" })) });
  const of = (calls: readonly string[][], text: string): number => calls.filter((c) => c.join(" ").includes(text)).length;
  const recent = "2026-10-22T00:00:00Z";
  const window = { since: "2026-10-21" };

  it("starts no gh process for a repository with no version in the window", async () => {
    const f = fakeGh();
    const packages = { "@ex/a": { "1.0.0": { time: "2026-10-20T23:59:59Z" } }, "@ex/b": { "1.0.0": { time: "2026-10-01T00:00:00Z", gitHead: SHA_A } } };
    const r = await run({ gh: f.gh, ...window, repos: [repo("quiet", "@ex/a", "@ex/b")], fetch: registry(packages) });
    expect(f.calls).toEqual([]);
    expect(r).toMatchObject({ processes: 0, versions: 0, rows: [] });
  });

  it("reads the tags of a repository once, and needs no more for versions with a tag", async () => {
    const f = fakeGh({ "git/matching-refs/tags/": ok("refs/tags/@ex/a@1.0.0\nrefs/tags/@ex/a@1.1.0\nrefs/tags/@ex/b@1.0.0\n") });
    const packages = { "@ex/a": { "1.0.0": { time: recent }, "1.1.0": { time: recent } }, "@ex/b": { "1.0.0": { time: recent } } };
    const r = await run({ gh: f.gh, ...window, repos: [repo("many", "@ex/a", "@ex/b")], fetch: registry(packages) });
    expect(f.calls).toHaveLength(1);
    expect(r).toMatchObject({ processes: 1, versions: 3, tagged: 3, rows: [] });
  });

  it("counts one read each for the tags, release.yml and the ID, and one check for each commit", async () => {
    const f = fakeGh();
    const packages = {
      "@ex/a": { "1.0.0": { time: recent, provenance: SHA_A }, "1.1.0": { time: recent, provenance: SHA_B }, "0.9.0": { time: "2026-10-01T00:00:00Z", provenance: SHA_B } },
      "@ex/b": { "1.0.0": { time: recent, provenance: SHA_A }, "1.1.0": { time: recent, provenance: SHA_B } },
      "@ex/old": { "1.0.0": { time: "2026-10-01T00:00:00Z", provenance: SHA_B } },
    };
    const r = await run({ gh: f.gh, ...window, repos: [repo("many", "@ex/a", "@ex/b"), repo("quiet", "@ex/old")], fetch: registry(packages) });
    expect(r.rows.map((x) => x.state)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(of(f.calls, "git/matching-refs/tags/")).toBe(1);
    expect(of(f.calls, "release.yml")).toBe(1);
    expect(of(f.calls, "--jq .id")).toBe(1);
    expect(of(f.calls, "/compare/")).toBe(2);
    expect(of(f.calls, "quiet")).toBe(0);
    expect(f.calls).toHaveLength(5);
    expect(r.processes).toBe(5);
  });

  it("counts the processes of a run with write", async () => {
    const f = fakeGh();
    const r = await run({ gh: f.gh, ...window, write: true, fetch: registry({ "@ex/one": { "1.0.0": { time: recent, gitHead: SHA_A } } }) });
    expect(r.processes).toBe(f.calls.length);
    expect(of(f.calls, "release create")).toBe(1);
  });
});

describe("the output", () => {
  const report: TagsReport = {
    owner: "ex",
    since: SINCE,
    write: false,
    versions: 3,
    tagged: 1,
    processes: 7,
    rows: [
      { repo: "one", private: false, package: "@ex/one", version: "1.0.0", published: "2026-10-20", tag: "v1.0.0", commit: SHA_A, state: "missing", detail: "x" },
      { repo: "hidden", private: true, package: "@ex/hidden", version: "2.0.0", published: "2026-10-21", tag: "v2.0.0", commit: null, state: "no-commit", detail: "npm names no commit." },
    ],
  };

  it("gives the counts, and one line for each version", () => {
    const text = tagsSummary(report);
    expect(text).toContain("(dry run)");
    expect(text).toContain("3 versions, 1 with a tag, 2 with no tag, 7 gh processes");
    expect(text).toContain("1 missing, 0 created, 0 failed, 1 no-commit");
    expect(text).toContain(`missing    2026-10-20 one @ex/one 1.0.0 v1.0.0 ${SHA_A}`);
    expect(text).toContain("npm names no commit.");
    expect(text).not.toContain(" x\n");
  });

  it("tells that a run with write made changes", () => {
    expect(tagsSummary({ ...report, write: true })).toContain("(write)");
  });

  it("hides the private names of the output", () => {
    const text = redactNames(tagsSummary(report), ["hidden", "@ex/hidden"], "");
    expect(text).not.toContain("hidden");
    expect(text).toContain("one @ex/one");
  });
});
