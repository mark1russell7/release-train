// The check texts in the first tests have the form of real check texts (11-13), with made-up names.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRAIN_BRANCH, hashName, prBody } from "./apply.ts";
import type { RepoUpdate } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { gitHub } from "./github.ts";
import {
  FIX_TEXT,
  FIX_TRAILER,
  decideFix,
  fixCommitMessage,
  fixTrailer,
  parseFixMarks,
  parseMissingChangesets,
  parseUnshipped,
  patchTarget,
  pullScope,
  readCheck,
  versionFixRun,
  versionFixSummary,
} from "./version-fix.ts";
import type { CiFacts, FixJob, FixResult, PullInfo, VersionFixer } from "./version-fix.ts";
import { gitUpdater } from "./workspace.ts";
import type { RunFn } from "./workspace.ts";

const GENERIC = "Process completed with exit code 1.";
const HEAD = "The release skips a version that is on npm, so these changes would not ship. Set a greater version (SemVer) in each package.json:";

// A meter repository, the check "ci / release-check" (template scripts/release/pack.ts)
const LAG_HUD = `${HEAD}\n  @acme/meter@0.3.0 is on npm, but these shipped files differ from it:\n    build/index.d.ts (changed)\n    build/index.d.ts.map (changed)`;
// collections#119, the check "ci / release-check"
const COLLECTIONS = `${HEAD}\n  @acme/lists@0.10.0 is on npm, but these shipped files differ from it:\n    build/dag/index.d.ts (changed)\n    build/dag/index.d.ts.map (changed)\n    build/graph/index.d.ts (changed)\n    build/graph/index.d.ts.map (changed)\n    build/index.d.ts (changed)\n    build/index.d.ts.map (changed)\n    build/index.js (changed)\n    build/index.js.map (changed)\n    build/summary-tree/index.d.ts (changed)\n    build/testing/index.d.ts (changed)\n    build/testing/index.d.ts.map (changed)\n    build/testing/index.js.map (changed)`;
// strategy-space#23, a pull request of the train: conventions fix changed package.json
const STRATEGY_SPACE = `${HEAD}\n  @acme/grid@0.0.5 is on npm, but these shipped files differ from it:\n    package.json (changed)`;
// A bench repository, the check "checks / release-check"
const SYSTEMS = `${HEAD}\n  @acme/bench@0.15.6 is on npm, but these shipped files differ from it:\n    package.json (changed)\n  @acme/cluster@0.14.3 is on npm, but these shipped files differ from it:\n    package.json (changed)`;
// A bench repository, the end of the job log of "pack / Build, pack and plan the tags": the annotations of that job hold only the last line.
const SYSTEMS_PACK_LOG = [
  "2026-11-13T02:14:17.2377863Z /home/runner/work/_temp/release/acme-cluster-0.14.3.tgz",
  "2026-11-13T02:14:17.2874778Z @acme/cluster@0.14.3: acme-cluster-0.14.3.tgz",
  "2026-11-13T02:14:17.3306953Z package: @acme/fsm@0.3.33",
  "2026-11-13T02:14:17.3307252Z Tarball Contents",
  "2026-11-13T02:14:17.3308720Z /home/runner/work/_temp/release/acme-fsm-0.3.33.tgz",
  `2026-11-13T02:14:17.3868646Z ${HEAD}`,
  "2026-11-13T02:14:17.3869672Z @acme/fsm@0.3.33: acme-fsm-0.3.33.tgz",
  "2026-11-13T02:14:17.3870414Z   @acme/bench@0.15.6 is on npm, but these shipped files differ from it:",
  "2026-11-13T02:14:17.3870995Z     package.json (changed)",
  "2026-11-13T02:14:17.3871407Z   @acme/cluster@0.14.3 is on npm, but these shipped files differ from it:",
  "2026-11-13T02:14:17.3871757Z     package.json (changed)",
  "2026-11-13T02:14:17.3961815Z ##[error]Process completed with exit code 1.",
  "2026-11-13T02:14:17.4083861Z Post job cleanup.",
].join("\n");
// A bench repository, the job log of the summary job "ci": its annotations hold only the last line.
const SYSTEMS_CI_LOG = [
  '2026-11-13T02:17:11.6792544Z \u001b[36;1mecho "checks: $CHECKS, pack: $PACK, site: $SITE, checker: $CHECKER, native: $NATIVE"\u001b[0m',
  "2026-11-13T02:17:14.5172158Z env:",
  "2026-11-13T02:17:14.5172425Z   CHECKS: failure",
  "2026-11-13T02:17:14.5172721Z   PACK: failure",
  "2026-11-13T02:17:14.5174622Z ##[endgroup]",
  "2026-11-13T02:17:14.5316716Z checks: failure, pack: failure, site: success, checker: success, native: success",
  "2026-11-13T02:17:14.5328540Z ##[error]Process completed with exit code 1.",
].join("\n");
// client#549, the check "CI / changesets" (template .github/actions/changeset-check/check.ts)
const CLIENT_CHANGESETS =
  'These published packages change and have no changeset: @procedures/s3. Add one with "pnpm changeset" (patch, minor or major). For a change with no release, add an empty changeset ("pnpm changeset --empty") or the label "no-changeset".';

describe("parseUnshipped", () => {
  it("reads the package and the version on npm from the message of the release check", () => {
    expect(parseUnshipped(LAG_HUD)).toEqual([{ name: "@acme/meter", version: "0.3.0" }]);
    expect(parseUnshipped(COLLECTIONS)).toEqual([{ name: "@acme/lists", version: "0.10.0" }]);
    expect(parseUnshipped(STRATEGY_SPACE)).toEqual([{ name: "@acme/grid", version: "0.0.5" }]);
    expect(parseUnshipped(SYSTEMS)).toEqual([
      { name: "@acme/bench", version: "0.15.6" },
      { name: "@acme/cluster", version: "0.14.3" },
    ]);
  });

  it("reads a job log with time stamps, and not the output lines of pnpm pack", () => {
    const found = parseUnshipped(SYSTEMS_PACK_LOG);
    expect(found).toEqual([
      { name: "@acme/bench", version: "0.15.6" },
      { name: "@acme/cluster", version: "0.14.3" },
    ]);
    expect(found.map((x) => x.name)).not.toContain("@acme/fsm");
  });

  it("reads no package outside the error block: a pending changeset is not an error", () => {
    const pending = "A pending changeset raises the version of these packages, so these changes ship with the next version:\n  @ex/lib@1.0.0 is on npm, but these shipped files differ from it:\n    index.js (changed)";
    expect(parseUnshipped(pending)).toEqual([]);
    expect(parseUnshipped(`${HEAD}\n  @ex/a@1.0.0 is on npm, but these shipped files differ from it:\n    a.js (changed)\n${pending}`)).toEqual([{ name: "@ex/a", version: "1.0.0" }]);
    expect(parseUnshipped("  @ex/a@1.0.0 is on npm, but these shipped files differ from it:")).toEqual([]);
    expect(parseUnshipped(GENERIC)).toEqual([]);
    expect(parseUnshipped(`${HEAD}\n  @ex/a@not-a-version is on npm, but these shipped files differ from it:`)).toEqual([]);
  });
});

describe("parseMissingChangesets", () => {
  it("reads the packages of the changeset check, also as an error line of a log", () => {
    expect(parseMissingChangesets(CLIENT_CHANGESETS)).toEqual(["@procedures/s3"]);
    const two = CLIENT_CHANGESETS.replace("@procedures/s3", "@ex/a, @ex/b");
    expect(parseMissingChangesets(`2026-11-13T02:14:17.3961815Z ::error::${two}`)).toEqual(["@ex/a", "@ex/b"]);
    expect(parseMissingChangesets(LAG_HUD)).toEqual([]);
  });
});

describe("readCheck", () => {
  it("reads a summary job as an aggregate, and the last line of a job as no reason", () => {
    expect(readCheck({ name: "CI OK", annotations: [GENERIC, "ci: failure"] })).toEqual({ unshipped: [], missing: [], aggregate: true, other: [] });
    expect(readCheck({ name: "CI OK", annotations: [GENERIC, "changesets: failure", "ci: failure"] }).aggregate).toBe(true);
    expect(readCheck({ name: "ci", annotations: [GENERIC], log: SYSTEMS_CI_LOG })).toEqual({ unshipped: [], missing: [], aggregate: true, other: [] });
  });

  it("reads the message from the log when the annotations hold only the last line", () => {
    const r = readCheck({ name: "pack", annotations: [GENERIC], log: SYSTEMS_PACK_LOG });
    expect(r.unshipped.map((x) => x.name)).toEqual(["@acme/bench", "@acme/cluster"]);
    expect(r.other).toEqual([]);
  });

  it("gives each other error", () => {
    expect(readCheck({ name: "test", annotations: [GENERIC, "expected 2 to be 3"] }).other).toEqual(["expected 2 to be 3"]);
    expect(readCheck({ name: "test", annotations: [GENERIC], log: "2026-11-13T02:14:17.3Z ##[error]Type error TS2322\n##[error]Process completed with exit code 2." }).other).toEqual(["Type error TS2322"]);
    // A single result line in a log is not a summary job: the log of a test can hold such a line.
    expect(readCheck({ name: "test", annotations: [GENERIC], log: "status: failure" }).aggregate).toBe(false);
  });
});

const TRAIN = "ex-train[bot]";
const pr = (extra: Partial<PullInfo> = {}): PullInfo => ({ number: 1, author: "renovate[bot]", headRef: "renovate/npm-patch", headSha: "a".repeat(40), sameRepo: true, body: "", ...extra });
const trainBody = (kind: string): string => `Why. (plan action \`update:lib\`, kind \`${kind}\`, wave 0).`;

describe("pullScope", () => {
  it("acts on the groups of non-breaking updates of Renovate", () => {
    for (const headRef of ["renovate/npm-patch", "renovate/npm-minor", "renovate/npm-dev-minor", "renovate/lock-file-maintenance"]) {
      expect(pullScope(pr({ headRef }), TRAIN)).toEqual({ act: true, source: "renovate" });
    }
  });

  it("skips the 0.x minor group, a major update, another branch, a fork, a person and another bot", () => {
    expect(pullScope(pr({ headRef: "renovate/npm-zero-minor" }), TRAIN)).toMatchObject({ act: false, reason: "a 0.x minor update can break, so a person reviews it" });
    expect(pullScope(pr({ headRef: "renovate/major-typescript" }), TRAIN)).toMatchObject({ act: false, reason: "a major update can break, so a person reviews it" });
    expect(pullScope(pr({ headRef: "renovate/actions" }), TRAIN)).toMatchObject({ act: false, reason: "the Renovate branch is not a group of non-breaking npm updates" });
    expect(pullScope(pr({ sameRepo: false }), TRAIN)).toMatchObject({ act: false, reason: "the head branch is in a fork" });
    expect(pullScope(pr({ author: "someone" }), TRAIN)).toMatchObject({ act: false, reason: "a pull request of a person" });
    expect(pullScope(pr({ author: "dependabot[bot]" }), TRAIN)).toMatchObject({ act: false, reason: "a pull request of another bot" });
  });

  it("acts on an update of the train that is not a breaking adoption", () => {
    const train = (headRef: string, body: string | null) => pullScope(pr({ author: TRAIN, headRef, body }), TRAIN);
    expect(train(TRAIN_BRANCH, trainBody("adopt-in-range"))).toEqual({ act: true, source: "train" });
    expect(train(TRAIN_BRANCH, trainBody("settings"))).toEqual({ act: true, source: "train" });
    expect(train(TRAIN_BRANCH, trainBody("adopt-breaking"))).toMatchObject({ act: false, reason: "a breaking adoption: the train writes its version bump itself" });
    expect(train(TRAIN_BRANCH, null)).toMatchObject({ act: false, reason: "the body of the train pull request names no kind" });
    expect(train("release-train/template", trainBody("adopt-in-range"))).toMatchObject({ act: false, reason: "the template sync is not a dependency update" });
    expect(train("release-train/other", trainBody("adopt-in-range"))).toMatchObject({ act: false, reason: "the branch is not the update branch of the train" });
    // With no login of the train, a pull request of the train is a pull request of another bot.
    expect(pullScope(pr({ author: TRAIN, headRef: TRAIN_BRANCH, body: trainBody("adopt-in-range") }), null)).toMatchObject({ act: false });
  });
});

const failed = (...checks: CiFacts["failed"]): CiFacts => ({ state: "failed", statusFailed: false, failed: checks });

describe("decideFix", () => {
  it("acts when each failed check is a known message or a summary job", () => {
    const ci = failed({ name: "CI OK", annotations: [GENERIC, "ci: failure"] }, { name: "ci / release-check", annotations: [GENERIC, LAG_HUD] });
    expect(decideFix("renovate", ci, [])).toEqual({ act: true, source: "renovate", needs: [{ name: "@acme/meter", version: "0.3.0" }] });
    const systems = failed(
      { name: "ci", annotations: [GENERIC], log: SYSTEMS_CI_LOG },
      { name: "pack / Build, pack and plan the tags", annotations: [GENERIC], log: SYSTEMS_PACK_LOG },
      { name: "checks / release-check", annotations: [GENERIC, SYSTEMS] },
    );
    expect(decideFix("renovate", systems, [])).toMatchObject({ act: true, needs: [{ name: "@acme/bench", version: "0.15.6" }, { name: "@acme/cluster", version: "0.14.3" }] });
    const changesets = failed({ name: "CI OK", annotations: [GENERIC, "changesets: failure", "ci: failure"] }, { name: "CI / changesets", annotations: [GENERIC, CLIENT_CHANGESETS] }, { name: "Changesets", annotations: [GENERIC, CLIENT_CHANGESETS] });
    expect(decideFix("renovate", changesets, [])).toMatchObject({ act: true, needs: [{ name: "@procedures/s3", version: null }] });
  });

  it("skips a head that runs, has no CI, is green, or has a failed commit status", () => {
    expect(decideFix("renovate", { state: "running", statusFailed: false, failed: [] }, [])).toEqual({ act: false, reason: "CI runs" });
    expect(decideFix("renovate", { state: "none", statusFailed: false, failed: [] }, [])).toEqual({ act: false, reason: "the head has no CI result" });
    expect(decideFix("renovate", { state: "green", statusFailed: false, failed: [] }, [])).toEqual({ act: false, reason: "CI is green" });
    expect(decideFix("renovate", { ...failed({ name: "x", annotations: [LAG_HUD] }), statusFailed: true }, [])).toEqual({ act: false, reason: "a commit status failed" });
  });

  it("skips a head with another error, a check with no known message, or only summary jobs", () => {
    const other = failed({ name: "ci / release-check", annotations: [GENERIC, LAG_HUD] }, { name: "ci / test", annotations: [GENERIC, "expected 2 to be 3"] });
    expect(decideFix("renovate", other, [])).toEqual({ act: false, reason: "a check failed with another error", detail: "ci / test: expected 2 to be 3" });
    const silent = failed({ name: "ci / release-check", annotations: [GENERIC, LAG_HUD] }, { name: "ci / build", annotations: [GENERIC] });
    expect(decideFix("renovate", silent, [])).toEqual({ act: false, reason: "a check failed with no known message", detail: "ci / build" });
    expect(decideFix("renovate", failed({ name: "CI OK", annotations: [GENERIC, "ci: failure"] }), [])).toEqual({ act: false, reason: "no failed check names a package" });
  });

  it("never raises a version two times: a mark of the package on the head stops the fix", () => {
    const ci = failed({ name: "ci / release-check", annotations: [LAG_HUD] });
    const marks = parseFixMarks([fixCommitMessage([{ name: "@acme/meter", from: "0.3.0", to: "0.3.1" }])]);
    expect(decideFix("renovate", ci, marks)).toEqual({ act: false, reason: "the head has a version fix for a package already, so a person decides", detail: "@acme/meter" });
  });
});

describe("patchTarget", () => {
  it("gives the PATCH of the version on npm, and refuses a version that npm has or a version that is not the greatest", () => {
    expect(patchTarget("0.3.0", { versions: ["0.2.0", "0.3.0"], latest: "0.3.0" })).toEqual({ to: "0.3.1" });
    expect(patchTarget("0.3.0", { versions: ["0.3.0", "0.3.1"], latest: "0.3.0" })).toEqual({ reason: "npm has 0.3.1 already" });
    expect(patchTarget("0.3.0", { versions: ["0.3.0", "0.4.0"], latest: "0.4.0" })).toEqual({ reason: "0.3.1 is not greater than the latest version 0.4.0 on npm" });
    expect(patchTarget("0.3.0", null)).toEqual({ reason: "npm gives no versions of the package" });
    expect(patchTarget("x", { versions: [], latest: null })).toEqual({ reason: "x is not a SemVer version" });
  });
});

describe("the marks of a version fix", () => {
  it("writes the trailers in the commit message and reads them back", () => {
    const marks = [
      { name: "@ex/a", from: "1.0.0", to: "1.0.1" },
      { name: "@ex/b", from: null, to: null },
    ];
    const message = fixCommitMessage(marks);
    expect(message.split("\n")[0]).toBe("chore(release): patch version of 2 packages");
    expect(message).toContain(FIX_TEXT);
    expect(message).toContain(`${FIX_TRAILER}: @ex/a 1.0.0 -> 1.0.1`);
    expect(message).toContain(`${FIX_TRAILER}: @ex/b changeset`);
    expect(parseFixMarks([message])).toEqual(marks);
    expect(fixTrailer(marks[0] as (typeof marks)[0])).toBe(`${FIX_TRAILER}: @ex/a 1.0.0 -> 1.0.1`);
  });
});

/** A made-up GitHub API: each route gives its answer, and the client reads job logs as text. */
function api(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f: FetchFn = async (url) => {
    const u = new URL(url);
    calls.push(`${u.pathname}${u.search}`);
    const data = routes[u.pathname];
    if (data === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(typeof data === "string" ? data : JSON.stringify(data), { status: 200 });
  };
  return { gh: gitHub({ token: "t", fetch: f }), calls };
}

const OWNER = "ex-owner";
const SHA = "b".repeat(40);
const openPull = (n: number, ref: string, login: string, repo: string, body = "") => ({
  number: n,
  body,
  user: { login },
  head: { sha: SHA, ref, repo: { full_name: `${OWNER}/${repo}` } },
  base: { repo: { full_name: `${OWNER}/${repo}` } },
});
const exUnshipped = (name: string, version: string): string => `${HEAD}\n  ${name}@${version} is on npm, but these shipped files differ from it:\n    build/index.js (changed)`;

/** The routes of one repository with one pull request whose release check failed. */
function repoRoutes(repo: string, opts: { pulls: unknown[]; release: string[]; log?: string; commits?: string[] }): Record<string, unknown> {
  const base = `/repos/${OWNER}/${repo}`;
  return {
    [`${base}/pulls`]: opts.pulls,
    [`${base}/commits/${SHA}/check-runs`]: {
      check_runs: [
        { id: 11, name: "CI OK", status: "completed", conclusion: "failure", check_suite: { id: 1 }, app: { slug: "github-actions" } },
        { id: 12, name: "ci / release-check", status: "completed", conclusion: "failure", check_suite: { id: 1 }, app: { slug: "github-actions" } },
        { id: 13, name: "ci / test", status: "completed", conclusion: "success", check_suite: { id: 1 }, app: { slug: "github-actions" } },
      ],
    },
    [`${base}/commits/${SHA}/status`]: { state: "pending", total_count: 0 },
    [`${base}/actions/runs`]: { workflow_runs: [{ workflow_id: 1, check_suite_id: 1, created_at: "2026-11-13T00:00:00Z" }] },
    [`${base}/check-runs/11/annotations`]: [{ annotation_level: "failure", message: GENERIC }, { annotation_level: "failure", message: "ci: failure" }],
    [`${base}/check-runs/12/annotations`]: opts.release.map((message) => ({ annotation_level: "failure", message })),
    ...(opts.log === undefined ? {} : { [`${base}/actions/jobs/12/logs`]: opts.log }),
    [`${base}/pulls/1/commits`]: (opts.commits ?? ["fix(deps): update npm patch updates"]).map((message) => ({ commit: { message } })),
  };
}

class FakeFixer implements VersionFixer {
  jobs: FixJob[] = [];
  async versionFix(job: FixJob): Promise<FixResult> {
    this.jobs.push(job);
    return { status: "pushed", sha: "c".repeat(40), done: job.needs.map((n) => ({ name: n.name, path: "", via: "version", from: n.version, to: "9.9.9" })), left: [], error: null };
  }
}

describe("versionFixRun", () => {
  it("gives a pull request in scope to the writer, and logs one line for each pull request", async () => {
    const { gh } = api({
      ...repoRoutes("lib-repo", {
        pulls: [openPull(1, "renovate/npm-patch", "renovate[bot]", "lib-repo"), openPull(2, "renovate/npm-zero-minor", "renovate[bot]", "lib-repo")],
        release: [GENERIC, exUnshipped("@ex/lib", "1.2.0")],
      }),
    });
    const fixer = new FakeFixer();
    const lines: string[] = [];
    const rows = await versionFixRun({ gh, owner: OWNER, repos: [{ name: "lib-repo", private: false }], fixer, trainLogin: TRAIN, log: (l) => lines.push(l) });
    expect(fixer.jobs).toEqual([{ repo: "lib-repo", branch: "renovate/npm-patch", sha: SHA, needs: [{ name: "@ex/lib", version: "1.2.0" }] }]);
    expect(rows.map((r) => [r.pr, r.action])).toEqual([
      [1, "fixed"],
      [2, "skipped"],
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.includes("lib-repo#1"))).toContain("Packages: @ex/lib 1.2.0 -> 9.9.9.");
    expect(versionFixSummary(rows, false)).toContain("1 fixed");
  });

  it("changes nothing in a dry run", async () => {
    const { gh } = api(repoRoutes("lib-repo", { pulls: [openPull(1, "renovate/npm-minor", "renovate[bot]", "lib-repo")], release: [GENERIC, exUnshipped("@ex/lib", "1.2.0")] }));
    const rows = await versionFixRun({ gh, owner: OWNER, repos: [{ name: "lib-repo", private: false }], fixer: null, trainLogin: TRAIN });
    expect(rows).toMatchObject([{ action: "planned", packages: ["@ex/lib@1.2.0"] }]);
    expect(versionFixSummary(rows, true)).toContain("(dry run)");
  });

  it("reads the job log when the annotations of the check hold only the last line", async () => {
    const { gh, calls } = api(repoRoutes("lib-repo", { pulls: [openPull(1, "renovate/npm-patch", "renovate[bot]", "lib-repo")], release: [GENERIC], log: `2026-11-13T02:14:17.3Z ${exUnshipped("@ex/lib", "1.2.0").replaceAll("\n", "\n2026-11-13T02:14:17.3Z ")}\n##[error]${GENERIC}` }));
    const fixer = new FakeFixer();
    await versionFixRun({ gh, owner: OWNER, repos: [{ name: "lib-repo", private: false }], fixer, trainLogin: TRAIN });
    expect(calls).toContain(`/repos/${OWNER}/lib-repo/actions/jobs/12/logs`);
    expect(fixer.jobs[0]?.needs).toEqual([{ name: "@ex/lib", version: "1.2.0" }]);
  });

  it("does not raise a version again when a commit of the pull request has the mark", async () => {
    const commits = ["fix(deps): update", fixCommitMessage([{ name: "@ex/lib", from: "1.2.0", to: "1.2.1" }])];
    const { gh } = api(repoRoutes("lib-repo", { pulls: [openPull(1, "renovate/npm-patch", "renovate[bot]", "lib-repo")], release: [GENERIC, exUnshipped("@ex/lib", "1.2.1")], commits }));
    const fixer = new FakeFixer();
    const rows = await versionFixRun({ gh, owner: OWNER, repos: [{ name: "lib-repo", private: false }], fixer, trainLogin: TRAIN });
    expect(fixer.jobs).toEqual([]);
    expect(rows).toMatchObject([{ action: "skipped", reason: "the head has a version fix for a package already, so a person decides" }]);
  });

  it("gives a private repository only as a hash, with no package name and no detail", async () => {
    const { gh } = api(repoRoutes("secret-repo", { pulls: [openPull(1, "renovate/npm-patch", "renovate[bot]", "secret-repo")], release: [GENERIC, exUnshipped("@ex/secret-lib", "1.2.0")] }));
    const lines: string[] = [];
    const rows = await versionFixRun({
      gh,
      owner: OWNER,
      repos: [{ name: "secret-repo", private: true }],
      fixer: new FakeFixer(),
      trainLogin: TRAIN,
      log: (l) => lines.push(l),
      label: (repo, priv) => (priv ? hashName(repo, "k") : repo),
    });
    const text = [...lines, versionFixSummary(rows, false)].join("\n");
    expect(text).toContain(hashName("secret-repo", "k"));
    expect(text).toContain("Packages: 1.");
    expect(text).not.toContain("secret");
  });
});

// The writer, on a real git repository in a temporary folder. The clone URL of GitHub goes to a bare repository.
const git = (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile("git", [...args], { cwd, timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** This function makes a bare repository with the branch main, and gives the commands of the fixture. */
async function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rt-fix-test-"));
  temps.push(root);
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(work);
  await git(["init", "--quiet", "--bare", "--initial-branch=main", bare], root);
  await git(["init", "--quiet", "--initial-branch=main"], work);
  const write = (more: Record<string, string>): void => {
    for (const [path, text] of Object.entries(more)) {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), text);
    }
  };
  const commit = async (message: string, branch: string): Promise<string> => {
    await git(["add", "-A"], work);
    await git([...ID, "commit", "--quiet", "-m", message], work);
    await git(["push", "--quiet", "--force", bare, `HEAD:refs/heads/${branch}`], work);
    return (await git(["rev-parse", "HEAD"], work)).stdout.trim();
  };
  write(files);
  await commit("first", "main");
  const url = `file:///${bare.replaceAll("\\", "/")}`;
  const cmds: string[] = [];
  const run: RunFn = async (cmd, args, opts) => {
    cmds.push(`${cmd} ${args.join(" ")}`);
    if (cmd !== "git") return { code: 0, stdout: "", stderr: "" };
    const mapped = args.map((a) => (a.startsWith("https://github.com/") ? url : a));
    const at = mapped.indexOf("commit");
    const final = at >= 0 ? [...mapped.slice(0, at), "-c", "commit.gpgsign=false", ...mapped.slice(at)] : mapped;
    return git(final, opts.cwd);
  };
  const show = async (ref: string, path: string): Promise<string | null> => {
    const r = await git(["--git-dir", bare, "show", `${ref}:${path}`], root);
    return r.code === 0 ? r.stdout : null;
  };
  const message = async (ref: string): Promise<string> => (await git(["--git-dir", bare, "log", "-1", "--format=%B", ref], root)).stdout;
  const author = async (ref: string): Promise<string> => (await git(["--git-dir", bare, "log", "-1", "--format=%an <%ae>", ref], root)).stdout.trim();
  return { write, commit, run, show, message, author, cmds, work };
}

const manifest = (name: string, version: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`;
const registry = (versions: string[], latest: string): FetchFn => async () =>
  new Response(JSON.stringify({ "dist-tags": { latest }, versions: Object.fromEntries(versions.map((v) => [v, {}])) }), { status: 200 });
const BOT = { name: "ex-train[bot]", email: "1+ex-train[bot]@users.noreply.github.com" };

describe("the writer of the version fix", () => {
  it("adds the PATCH of the version on npm and a CHANGELOG section, and pushes one commit of the App", async () => {
    const fx = await fixture({ "package.json": manifest("@ex/lib", "1.2.0"), "CHANGELOG.md": "# Changelog\n\n## 1.2.0\n\nOld.\n" });
    fx.write({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    const sha = await fx.commit("fix(deps): update", "renovate/npm-patch");
    const up = gitUpdater({ owner: OWNER, token: "t", author: BOT, run: fx.run, fetch: registry(["1.1.0", "1.2.0"], "1.2.0") });
    const r = await up.versionFix({ repo: "lib-repo", branch: "renovate/npm-patch", sha, needs: [{ name: "@ex/lib", version: "1.2.0" }] });
    expect(r).toMatchObject({ status: "pushed", done: [{ name: "@ex/lib", path: "", via: "version", from: "1.2.0", to: "1.2.1" }], left: [] });
    expect(JSON.parse((await fx.show("renovate/npm-patch", "package.json")) ?? "{}")).toMatchObject({ version: "1.2.1" });
    expect(await fx.show("renovate/npm-patch", "CHANGELOG.md")).toBe(`# Changelog\n\n## 1.2.1\n\n${FIX_TEXT}\n\n## 1.2.0\n\nOld.\n`);
    expect(await fx.author("renovate/npm-patch")).toBe(`${BOT.name} <${BOT.email}>`);
    expect(await fx.message("renovate/npm-patch")).toContain(`${FIX_TRAILER}: @ex/lib 1.2.0 -> 1.2.1`);
    // The push has no force: a new head of the branch wins
    expect(fx.cmds.find((c) => c.startsWith("git push"))).not.toContain("--force");
    // No version script and no Prettier: no install
    expect(fx.cmds.filter((c) => !c.startsWith("git "))).toEqual([]);
  }, 60_000);

  it("does nothing on a second run: the branch has the greater version already", async () => {
    const fx = await fixture({ "package.json": manifest("@ex/lib", "1.2.0") });
    const sha = await fx.commit("fix(deps): update", "renovate/npm-patch");
    const up = gitUpdater({ owner: OWNER, token: "t", author: BOT, run: fx.run, fetch: registry(["1.2.0"], "1.2.0") });
    const first = await up.versionFix({ repo: "lib-repo", branch: "renovate/npm-patch", sha, needs: [{ name: "@ex/lib", version: "1.2.0" }] });
    expect(first.status).toBe("pushed");
    const second = await up.versionFix({ repo: "lib-repo", branch: "renovate/npm-patch", sha: first.sha ?? "", needs: [{ name: "@ex/lib", version: "1.2.0" }] });
    expect(second).toMatchObject({ status: "no-change", done: [], left: [{ name: "@ex/lib", reason: "the branch has 1.2.1 already, greater than 1.2.0 on npm" }] });
    expect(fx.cmds.filter((c) => c.startsWith("git push"))).toHaveLength(1);
  }, 60_000);

  it("changes nothing when the branch has a new head, or when npm has the PATCH", async () => {
    const fx = await fixture({ "package.json": manifest("@ex/lib", "1.2.0") });
    const sha = await fx.commit("fix(deps): update", "renovate/npm-patch");
    const moved = gitUpdater({ owner: OWNER, token: "t", author: BOT, run: fx.run, fetch: registry(["1.2.0"], "1.2.0") });
    expect(await moved.versionFix({ repo: "lib-repo", branch: "renovate/npm-patch", sha: "0".repeat(40), needs: [{ name: "@ex/lib", version: "1.2.0" }] })).toMatchObject({ status: "moved", sha });
    const taken = gitUpdater({ owner: OWNER, token: "t", author: BOT, run: fx.run, fetch: registry(["1.2.0", "1.2.1"], "1.2.1") });
    expect(await taken.versionFix({ repo: "lib-repo", branch: "renovate/npm-patch", sha, needs: [{ name: "@ex/lib", version: "1.2.0" }] })).toMatchObject({
      status: "no-change",
      left: [{ name: "@ex/lib", reason: "npm has 1.2.1 already" }],
    });
    expect(fx.cmds.filter((c) => c.startsWith("git push"))).toEqual([]);
  }, 60_000);

  it("writes one patch changeset in a repository with Changesets", async () => {
    const fx = await fixture({
      "package.json": manifest("ex-root", "0.0.0", { private: true }),
      ".changeset/config.json": "{}\n",
      "packages/s3/package.json": manifest("@ex/s3", "0.4.0"),
      "packages/s3/test/fixture/package.json": manifest("@ex/s3", "0.0.0"),
    });
    const sha = await fx.commit("fix(deps): update", "renovate/npm-minor");
    const up = gitUpdater({ owner: OWNER, token: "t", author: BOT, run: fx.run, fetch: registry(["0.4.0"], "0.4.0") });
    const r = await up.versionFix({ repo: "client-repo", branch: "renovate/npm-minor", sha, needs: [{ name: "@ex/s3", version: null }] });
    expect(r).toMatchObject({ status: "pushed", done: [{ name: "@ex/s3", path: "packages/s3", via: "changeset", from: null, to: null }] });
    const files = await git(["--git-dir", join(fx.work, "..", "origin.git"), "ls-tree", "-r", "--name-only", "renovate/npm-minor"], fx.work);
    const changeset = files.stdout.split("\n").find((f) => f.startsWith(".changeset/release-train-")) ?? "";
    expect(await fx.show("renovate/npm-minor", changeset)).toBe(`---\n"@ex/s3": patch\n---\n\n${FIX_TEXT}\n`);
    expect(JSON.parse((await fx.show("renovate/npm-minor", "packages/s3/package.json")) ?? "{}")).toMatchObject({ version: "0.4.0" });
    expect(await fx.message("renovate/npm-minor")).toContain(`${FIX_TRAILER}: @ex/s3 changeset`);
  }, 60_000);
});

describe("the update of the train keeps a version fix of its branch", () => {
  const update = (): RepoUpdate => ({
    repo: "lib-repo",
    private: false,
    actionId: "update:lib-repo",
    kind: "adopt-in-range",
    wave: 0,
    why: "Why.",
    lockKind: "none",
    items: [{ path: "", dependent: "@ex/lib", dep: "@ex/core", type: "dependencies", range: "^1.0.0", newRange: "^2.0.0", from: null, to: "2.0.0", why: "w" }],
    fingerprint: "f".repeat(64),
  });
  /** The branch of the train: the update commit of an earlier run, then the commit of the version fix. */
  const branch = async (mainVersion: string) => {
    const fx = await fixture({ "package.json": manifest("@ex/lib", mainVersion, { dependencies: { "@ex/core": "^1.0.0" } }), "CHANGELOG.md": "# Changelog\n" });
    const up = gitUpdater({ owner: OWNER, token: "t", author: BOT, run: fx.run, fetch: registry(["1.2.0"], "1.2.0") });
    const first = await up.update(update(), { defaultBranch: "main", rebuild: false });
    expect(first.status).toBe("pushed");
    const fixed = await up.versionFix({ repo: "lib-repo", branch: TRAIN_BRANCH, sha: first.sha ?? "", needs: [{ name: "@ex/lib", version: "1.2.0" }] });
    expect(fixed.status).toBe("pushed");
    return { fx, up, fixed };
  };

  it("builds the same content again, so the run does not push the fix away", async () => {
    const { fx, up, fixed } = await branch("1.2.0");
    const again = await up.update(update(), { defaultBranch: "main", rebuild: false });
    expect(again).toMatchObject({ status: "same", sha: fixed.sha, versionFixes: [{ name: "@ex/lib", via: "version", from: "1.2.0", to: "1.2.1" }] });
    expect(fx.cmds.filter((c) => c.startsWith("git push"))).toHaveLength(2);
    // A new build of the branch (a rebuild) keeps the fix and its trailer, so the next run reads it again
    const rebuilt = await up.update(update(), { defaultBranch: "main", rebuild: true });
    expect(rebuilt.status).toBe("pushed");
    expect(JSON.parse((await fx.show(TRAIN_BRANCH, "package.json")) ?? "{}")).toMatchObject({ version: "1.2.1", dependencies: { "@ex/core": "^2.0.0" } });
    expect(await fx.message(TRAIN_BRANCH)).toContain(`${FIX_TRAILER}: @ex/lib 1.2.0 -> 1.2.1`);
    expect(prBody(update(), rebuilt)).toContain("## Version fix");
  }, 90_000);

  it("drops the fix when the default branch has a new version", async () => {
    const { fx, up } = await branch("1.2.0");
    fx.write({ "package.json": manifest("@ex/lib", "1.3.0", { dependencies: { "@ex/core": "^1.0.0" } }) });
    await fx.commit("chore(release): 1.3.0", "main");
    const again = await up.update(update(), { defaultBranch: "main", rebuild: true });
    expect(again.status).toBe("pushed");
    expect(again).not.toHaveProperty("versionFixes");
    expect(JSON.parse((await fx.show(TRAIN_BRANCH, "package.json")) ?? "{}")).toMatchObject({ version: "1.3.0" });
  }, 90_000);
});
