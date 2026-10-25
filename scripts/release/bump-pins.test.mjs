// The tests of bump-pins.mjs: node --test scripts/release/

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchName,
  bumpRepo,
  changesVersion,
  commitSubject,
  findPins,
  parseArgs,
  prTitle,
  releaseBlockers,
  replacePins,
  resolveTarget,
} from "./bump-pins.mjs";

const OLD = "1111111111111111111111111111111111111111";
const OLDER = "2222222222222222222222222222222222222222";
const TARGET = "40b0fbd09ca4c07c451a5f9ca72d40eb62128d99";
const HEAD = "3333333333333333333333333333333333333333";
const BLOB = "4444444444444444444444444444444444444444";
const CHECKOUT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const REPO = "owner/repo";

const workflow = (build = OLD, publish = OLD, tag = OLD) =>
  [
    "jobs:",
    "  build:",
    `    uses: mark1russell7/template/.github/workflows/reusable-release-build.yml@${build} # main`,
    "  publish:",
    "    steps:",
    `      - uses: actions/checkout@${CHECKOUT} # v7.0.1`,
    `      - uses: mark1russell7/template/.github/actions/npm-publish@${publish} # main`,
    "  tag:",
    `    uses: mark1russell7/template/.github/workflows/reusable-release-tag.yml@${tag} # main`,
    "",
  ].join("\n");

/**
 * This function gives a mock of gh for one repository on GitHub, and records each call. `state` sets the
 * workflow text, the open pull requests, their package.json files, the active runs and the compare status.
 */
function github(state = {}) {
  const {
    text = workflow(),
    pulls = [],
    files = {},
    runs = [],
    compare = "ahead",
    commits = [{ sha: TARGET, message: 'release: an optional "latest" entry (s3) (#40)\n\nbody' }],
    fail = {},
  } = state;
  const calls = [];
  const run = (args, input) => {
    const call = { args, input: input === undefined ? undefined : JSON.parse(input) };
    calls.push(call);
    const [, ...rest] = args;
    const method = rest[0] === "-X" ? rest[1] : "GET";
    const path = args.find((arg) => /^repos\//.test(arg));
    const key = `${method} ${path}`;
    for (const [pattern, error] of Object.entries(fail)) if (key.includes(pattern)) throw new Error(error);
    if (key === `GET repos/${REPO}/git/ref/heads/main`) return `${HEAD}\n`;
    if (key === `GET repos/${REPO}/contents/.github/workflows/release.yml?ref=${HEAD}`) {
      return JSON.stringify({ sha: BLOB, encoding: "base64", content: Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n") });
    }
    if (key.startsWith("GET repos/mark1russell7/template/compare/")) return JSON.stringify({ status: compare, commits });
    if (key === `GET repos/${REPO}/actions/workflows/release.yml/runs?per_page=30`) return runs.map((r) => JSON.stringify(r)).join("\n");
    if (key === `GET repos/${REPO}/pulls?state=open&base=main&per_page=100`) return pulls.map((p) => JSON.stringify(p)).join("\n");
    const filesMatch = /^GET repos\/owner\/repo\/pulls\/(\d+)\/files/.exec(key);
    if (filesMatch) return (files[filesMatch[1]] ?? []).map((f) => JSON.stringify(f)).join("\n");
    if (key === `POST repos/${REPO}/git/refs`) return `${call.input.ref}\n`;
    if (key === `PUT repos/${REPO}/contents/.github/workflows/release.yml`) return "5555555\n";
    if (key === `POST repos/${REPO}/pulls`) return "https://github.com/owner/repo/pull/7\n";
    if (key.startsWith("DELETE ")) return "";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { run, calls, writes: () => calls.filter(({ args }) => args.includes("-X")) };
}

test("findPins() finds only the pins of the template that follow main", () => {
  const text = `${workflow()}    uses: mark1russell7/template/.github/actions/other@${OLD} # v1\n    uses: mark1russell7/template/.github/actions/short@1111111 # main\n`;
  assert.deepEqual(findPins(text), [
    { path: ".github/workflows/reusable-release-build.yml", sha: OLD },
    { path: ".github/actions/npm-publish", sha: OLD },
    { path: ".github/workflows/reusable-release-tag.yml", sha: OLD },
  ]);
  assert.deepEqual(findPins("jobs: {}\n"), []);
});

test("replacePins() changes only the commits of the template pins, and keeps the line ends", () => {
  const text = workflow(OLD, OLDER, OLD).replaceAll("\n", "\r\n");
  const out = replacePins(text, TARGET);
  assert.equal(out, workflow(TARGET, TARGET, TARGET).replaceAll("\n", "\r\n"));
  assert.ok(out.includes(`actions/checkout@${CHECKOUT} # v7.0.1`));
  assert.equal(replacePins(out, TARGET), out);
});

test("changesVersion() finds a changed version field, and a package.json without a patch", () => {
  assert.equal(changesVersion([{ filename: "packages/a/package.json", patch: '@@ -2,3 +2,3 @@\n-  "version": "1.0.0",\n+  "version": "1.1.0",' }]), true);
  assert.equal(changesVersion([{ filename: "package.json", patch: '@@ -9 +9 @@\n-    "vitest": "^4.1.0"\n+    "vitest": "^4.2.0"' }]), false);
  assert.equal(changesVersion([{ filename: "package.json", patch: '@@ -1 +1 @@\n   "version": "1.0.0",\n-  "private": true' }]), false);
  assert.equal(changesVersion([{ filename: "package.json" }]), true);
  assert.equal(changesVersion([]), false);
});

test("releaseBlockers() names each version pull request and each active release run", () => {
  const pulls = [
    { number: 1, head: "changeset-release/main", url: "u1" },
    { number: 2, head: "release/1.2.0", url: "u2" },
    { number: 3, head: "feature", url: "u3" },
    { number: 4, head: "renovate/npm-patch", url: "u4" },
    { number: 5, head: branchName(TARGET), url: "u5" },
  ];
  const files = { 3: [{ filename: "package.json", patch: '+  "version": "2.0.0",' }], 4: [{ filename: "package.json", patch: '+    "tsx": "^4.23.16"' }] };
  const asked = [];
  const reasons = releaseBlockers({
    pulls,
    filesOf: (number) => {
      asked.push(number);
      return files[number] ?? [];
    },
    runs: [{ status: "in_progress", url: "r1" }],
    ownBranch: branchName(TARGET),
  });
  assert.deepEqual(reasons, [
    "a run of release.yml is in progress: r1",
    "the open pull request #1 is on the version branch changeset-release/main: u1",
    "the open pull request #2 is on the version branch release/1.2.0: u2",
    "the open pull request #3 changes the version of a package.json: u3",
  ]);
  // A version branch needs no files. The pull request of this script does not count.
  assert.deepEqual(asked, [3, 4]);
  assert.deepEqual(releaseBlockers({ pulls: [], filesOf: () => [], runs: [] }), []);
});

test("bumpRepo() makes a branch, commits the new release.yml and opens the pull request", () => {
  const gh = github();
  const result = bumpRepo(REPO, { target: TARGET, notes: "The tag plan gets a `latest` field.", coAuthor: "A <a@b.c>", footer: "FOOTER" }, gh.run);
  assert.equal(result.result, "opened");
  assert.equal(result.url, "https://github.com/owner/repo/pull/7");
  const [ref, put, pull] = gh.writes();
  assert.deepEqual(ref.input, { ref: `refs/heads/${branchName(TARGET)}`, sha: HEAD });
  assert.equal(put.input.branch, branchName(TARGET));
  assert.equal(put.input.sha, BLOB);
  assert.equal(Buffer.from(put.input.content, "base64").toString("utf8"), workflow(TARGET, TARGET, TARGET));
  assert.match(put.input.message, /^ci: move the template release pins to 40b0fbd\n/);
  assert.ok(put.input.message.endsWith("\n\nCo-Authored-By: A <a@b.c>"));
  assert.equal(pull.input.title, prTitle(TARGET));
  assert.equal(pull.input.head, branchName(TARGET));
  assert.equal(pull.input.base, "main");
  assert.match(pull.input.body, /The tag plan gets a `latest` field\./);
  assert.match(pull.input.body, /\(mark1russell7\/template#40\)/);
  assert.match(pull.input.body, /bump-pins\.mjs --check owner\/repo/);
  assert.ok(pull.input.body.endsWith("FOOTER\n"));
});

test("bumpRepo() with dryRun does the checks and changes nothing", () => {
  const gh = github();
  const result = bumpRepo(REPO, { target: TARGET, dryRun: true }, gh.run);
  assert.equal(result.result, "planned");
  assert.match(result.text, /3 of 3 pins from 1111111 to 40b0fbd/);
  assert.deepEqual(gh.writes(), []);
});

test("bumpRepo() skips a repository with no pin, or with each pin at the target", () => {
  for (const text of ["jobs: {}\n", workflow(TARGET, TARGET, TARGET)]) {
    const gh = github({ text });
    assert.equal(bumpRepo(REPO, { target: TARGET }, gh.run).result, "skipped");
    assert.deepEqual(gh.writes(), []);
  }
  const missing = github({ fail: { "contents/": "gh: Not Found (HTTP 404)" } });
  assert.deepEqual(bumpRepo(REPO, { target: TARGET }, missing.run).result, "skipped");
});

test("bumpRepo() moves only the old pins", () => {
  const gh = github({ text: workflow(TARGET, OLD, TARGET) });
  const result = bumpRepo(REPO, { target: TARGET }, gh.run);
  assert.match(result.text, /^1 of 3 pins/);
  const put = gh.writes()[1];
  assert.equal(Buffer.from(put.input.content, "base64").toString("utf8"), workflow(TARGET, TARGET, TARGET));
});

test("bumpRepo() refuses a repository where a release can start, and changes nothing", () => {
  const cases = [
    { runs: [{ status: "queued", url: "run-url" }] },
    { pulls: [{ number: 9, head: "changeset-release/main", url: "pr-url" }] },
    { pulls: [{ number: 9, head: "bump", url: "pr-url" }], files: { 9: [{ filename: "packages/x/package.json", patch: '-  "version": "0.1.0",\n+  "version": "0.2.0",' }] } },
  ];
  for (const state of cases) {
    const gh = github(state);
    const result = bumpRepo(REPO, { target: TARGET }, gh.run);
    assert.equal(result.result, "refused");
    assert.match(result.text, /a release can start/);
    assert.deepEqual(gh.writes(), []);
  }
});

test("bumpRepo() continues past a pull request that changes only dependencies", () => {
  const gh = github({ pulls: [{ number: 9, head: "renovate/npm-patch", url: "pr-url" }], files: { 9: [{ filename: "package.json", patch: '-    "tsx": "^4.0.0"\n+    "tsx": "^4.1.0"' }] } });
  assert.equal(bumpRepo(REPO, { target: TARGET }, gh.run).result, "opened");
});

test("bumpRepo() refuses when the release check fails, and when the target is older than a pin", () => {
  const broken = github({ fail: { "actions/workflows": "gh: Server Error (HTTP 500)" } });
  const failed = bumpRepo(REPO, { target: TARGET }, broken.run);
  assert.equal(failed.result, "refused");
  assert.match(failed.text, /release check failed.*HTTP 500/);
  assert.deepEqual(broken.writes(), []);

  const older = github({ compare: "behind", commits: [] });
  const result = bumpRepo(REPO, { target: TARGET }, older.run);
  assert.equal(result.result, "refused");
  assert.match(result.text, /older than the pin 1111111/);
  assert.deepEqual(older.writes(), []);
});

test("bumpRepo() skips a repository that has the pull request of the target", () => {
  const gh = github({ pulls: [{ number: 7, head: branchName(TARGET), url: "own-url" }] });
  const result = bumpRepo(REPO, { target: TARGET }, gh.run);
  assert.deepEqual([result.result, result.url], ["skipped", "own-url"]);
  assert.deepEqual(gh.writes(), []);
});

test("bumpRepo() removes the new branch when GitHub refuses the commit", () => {
  const gh = github({ fail: { "PUT repos/owner/repo/contents": "gh: Resource not accessible (HTTP 403)" } });
  const result = bumpRepo(REPO, { target: TARGET }, gh.run);
  assert.equal(result.result, "error");
  assert.deepEqual(
    gh.writes().map(({ args }) => args.slice(1, 4).join(" ")),
    [`-X POST repos/${REPO}/git/refs`, `-X PUT repos/${REPO}/contents/.github/workflows/release.yml`, `-X DELETE repos/${REPO}/git/refs/heads/${branchName(TARGET)}`],
  );
});

test("bumpRepo() compares each old pin one time for all the repositories", () => {
  const compareCache = new Map();
  const first = github();
  bumpRepo(REPO, { target: TARGET, dryRun: true, compareCache }, first.run);
  const second = github();
  bumpRepo(REPO, { target: TARGET, dryRun: true, compareCache }, second.run);
  const compares = (gh) => gh.calls.filter(({ args }) => args.some((arg) => arg.includes("/compare/"))).length;
  assert.deepEqual([compares(first), compares(second)], [1, 0]);
});

test("resolveTarget() gives the head of main, and refuses a commit that is not on main", () => {
  const calls = [];
  const run = (status) => (args) => {
    calls.push(args);
    return args[1].includes("/compare/") ? `${status}\n` : `${TARGET}\n`;
  };
  assert.equal(resolveTarget(undefined, run("identical")), TARGET);
  assert.deepEqual(calls, [["api", "repos/mark1russell7/template/commits/main", "--jq", ".sha"]]);
  assert.equal(resolveTarget("40b0fbd", run("behind")), TARGET);
  assert.throws(() => resolveTarget("40b0fbd", run("ahead")), /not on main/);
});

test("commitSubject() names the template in an issue link, and puts each @ name in code font", () => {
  assert.equal(commitSubject("fix: the hints (#40)\n\nbody #3"), "fix: the hints (mark1russell7/template#40)");
  assert.equal(commitSubject("the @mark1russell7/vex package"), "the `@mark1russell7/vex` package");
  assert.equal(commitSubject("see owner/x#12 and &#38;"), "see owner/x#12 and &#38;");
});

test("parseArgs() reads the options, and gives the owner of the template to a bare name", () => {
  assert.deepEqual(parseArgs(["--sha", "abc1234", "--dry-run", "--co-author", "A <a@b.c>", "vex", "owner/x"]), {
    repositories: ["mark1russell7/vex", "owner/x"],
    options: { dryRun: true, check: false, sha: "abc1234", coAuthor: "A <a@b.c>" },
  });
  assert.deepEqual(parseArgs(["--check", "vex"]).options, { dryRun: false, check: true });
  assert.match(parseArgs([]).error, /no repository/);
  assert.match(parseArgs(["--sha"]).error, /needs a value/);
  assert.match(parseArgs(["--force", "vex"]).error, /unknown option/);
});
