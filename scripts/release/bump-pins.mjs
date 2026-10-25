// Moves the pins of the template in the release.yml of other repositories: one pull request each.
//
//   node scripts/release/bump-pins.mjs [--sha <commit>] [--dry-run] <owner/repo> ...
//
// A repository pins each shared release workflow and action of the template to a commit of main:
//
//   uses: mark1russell7/template/.github/actions/npm-publish@<full commit SHA> # main
//
// Renovate does not change release.yml (renovate/README.md). A workflow change between the merge of
// a version and its release run makes the tag job fail with HTTP 403 (RELEASING.md). Thus the release
// session moves these pins itself, at a quiet time. For each repository, the script:
//   1. Reads .github/workflows/release.yml of main with the GitHub API.
//   2. Finds the pins of the template. It skips the repository when it has no pin, or when each pin
//      is at the target commit. It refuses a target that is older than a pin.
//   3. Refuses the repository when a release can start. An open pull request to main changes the
//      "version" of a package.json, for example "Version the packages" of Changesets. Or a pull
//      request is on a branch release/<version>. Or GitHub has a run of release.yml that is not complete.
//   4. Makes a branch from main, commits the new release.yml on it (contents API) and opens a pull
//      request (pulls API). The script makes no clone.
//   5. Shows the address of the pull request.
//
// After a refusal or an error, the script goes to the next repository. The summary at the end shows
// the result of each repository. The exit code is 1 when a repository has a refusal or an error.
//
// Options:
//   --sha <commit>       The target commit of the template (default: the head of main). It must be
//                        on main, because each pin follows main ("# main").
//   --dry-run            Shows the plan. It makes no branch, no commit and no pull request.
//   --check              Only does the release check of step 3. It changes nothing. Do this check
//                        immediately before the merge of a pull request of this script.
//   --notes <text>       A paragraph for the pull request: what the new commits of the template bring.
//   --co-author <name>   Adds "Co-Authored-By: <name>" to the commit message, for example
//                        "Claude Opus 5.5 <noreply@anthropic.com>".
//   --footer <text>      The last line of the text of the pull request.
//
// A repository without an owner ("vex") gets the owner of the template. The script uses gh with its
// account. The token of gh needs the scope "workflow" to change a workflow file.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ON_MAIN, compareWithMain } from "./dispatch.mjs";

export const TEMPLATE = "mark1russell7/template";
export const WORKFLOW = ".github/workflows/release.yml";
export const BASE = "main";

/** The branches of a version: "Version the packages" of Changesets, and release/<version> (RELEASING.md). */
export const VERSION_BRANCH = /^(changeset-release|release)\//;

/** The most commits of the template that the text of a pull request lists. */
export const MAX_COMMITS = 40;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A pin of the template: "mark1russell7/template/<path>@<40 hex> # main".
const PIN = new RegExp(`(${escape(TEMPLATE)}/[^\\s@]+)@([0-9a-f]{40})(?=[ \\t]+#[ \\t]*main\\b)`, "g");

/** This function starts gh and gives its output text. Its error has the error text of gh. */
function gh(args, input) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(String(error.stderr ?? "").trim() || error.message);
  }
}

/** This function gives the JSON values of an output with one JSON value on each line (gh --jq). */
const jsonLines = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

const short = (sha) => sha.slice(0, 7);

/** This function gives the first line of an error, for the output. */
const firstLine = (error) => String(error?.message ?? error).trim().split("\n")[0];

/** This function gives the pins of the template in a workflow text: [{ path, sha }], in the sequence of the text. */
export function findPins(text) {
  return [...text.matchAll(PIN)].map((match) => ({ path: match[1].slice(TEMPLATE.length + 1), sha: match[2] }));
}

/** This function gives the workflow text with each pin of the template at the target commit. The other text stays the same. */
export function replacePins(text, target) {
  return text.replace(PIN, (_, path) => `${path}@${target}`);
}

/**
 * This function tells if the changed files of a pull request change the "version" of a package.json.
 * `files` has { filename, patch } for each package.json. A file without a patch (GitHub gives none for a
 * big change) counts as a version change.
 */
export function changesVersion(files) {
  return files.some(({ patch }) => typeof patch !== "string" || /^[+-]\s*"version"\s*:/m.test(patch));
}

/**
 * This function gives the reasons that a release can start in a repository, or an empty list. `pulls` has
 * { number, head, url } for each open pull request to main. `filesOf(number)` gives the package.json
 * files of a pull request ({ filename, patch }). `runs` has { status, url } for each run of release.yml
 * that is not complete. `ownBranch` is the branch of this script: its pull request does not count.
 */
export function releaseBlockers({ pulls, filesOf, runs, ownBranch }) {
  const reasons = runs.map(({ status, url }) => `a run of release.yml is ${status.replaceAll("_", " ")}: ${url}`);
  for (const { number, head, url } of pulls) {
    if (head === ownBranch) continue;
    if (VERSION_BRANCH.test(head)) {
      reasons.push(`the open pull request #${number} is on the version branch ${head}: ${url}`);
      continue;
    }
    if (changesVersion(filesOf(number))) reasons.push(`the open pull request #${number} changes the version of a package.json: ${url}`);
  }
  return reasons;
}

/** This function gives the branch of the pull request for a target commit. */
export const branchName = (target) => `ci/template-release-pins-${short(target)}`;

/** This function gives the title of the pull request for a target commit. */
export const prTitle = (target) => `ci: move the template release pins to ${short(target)}`;

/** This function makes the text of a commit subject safe for a pull request of a different repository. */
export function commitSubject(message) {
  return (
    message
      .split("\n")[0]
      // "#40" in a different repository is a different issue: name the template.
      .replace(/(^|[\s([])#(\d+)\b/g, `$1${TEMPLATE}#$2`)
      // A name with "@" in code font notifies no person.
      .replace(/(^|\s)(@[\w./-]+)/g, "$1`$2`")
  );
}

/**
 * This function gives the text of the pull request. `pins` has { path, sha } for each changed pin.
 * `commits` has { sha, message } for each new commit of the template, oldest first.
 */
export function prBody({ repository, target, pins, commits, notes, footer }) {
  const link = (sha) => `[\`${short(sha)}\`](https://github.com/${TEMPLATE}/commit/${sha})`;
  const lines = [
    `This pull request moves the pins of \`${TEMPLATE}\` in \`${WORKFLOW}\` to ${link(target)} of \`main\`. ` +
      `\`scripts/release/bump-pins.mjs\` of the template opened it. Renovate does not change \`release.yml\` (\`RELEASING.md\` of the template).`,
    "",
    "| Pin | From | To |",
    "|---|---|---|",
    ...pins.map(({ path, sha }) => `| \`${path}\` | ${link(sha)} | ${link(target)} |`),
    "",
    "## What the new commits of the template bring",
    "",
  ];
  if (notes) lines.push(notes, "");
  if (commits.length === 0) lines.push("The template has no new commit since the old pins.");
  else {
    lines.push("The commits of the template after the old pins:", "");
    const newest = commits.slice(-MAX_COMMITS).reverse();
    for (const { sha, message } of newest) lines.push(`- ${link(sha)} ${commitSubject(message)}`);
    if (commits.length > MAX_COMMITS) lines.push(`- ${commits.length - MAX_COMMITS} older commits.`);
  }
  lines.push(
    "",
    "## Before the merge",
    "",
    "A workflow change between the merge of a version and its release run makes the tag job fail with HTTP 403. " +
      "When the script opened this pull request, no open pull request changed a package version, and no run of `release.yml` was active.",
    "",
    `Immediately before the merge, do the check again: \`node scripts/release/bump-pins.mjs --check ${repository}\` in the template.`,
  );
  if (footer) lines.push("", footer);
  return `${lines.join("\n")}\n`;
}

/** This function gives the commit message. */
export function commitMessage({ target, pins, coAuthor }) {
  const from = [...new Set(pins.map(({ sha }) => short(sha)))].join(", ");
  const lines = [prTitle(target), "", `The pins of ${TEMPLATE} in release.yml go from ${from} to ${short(target)} (scripts/release/bump-pins.mjs of the template).`];
  if (coAuthor) lines.push("", `Co-Authored-By: ${coAuthor}`);
  return lines.join("\n");
}

/** This function gives the full commit SHA of the target, and stops when the commit is not on main. */
export function resolveTarget(sha, run = gh) {
  const full = run(["api", `repos/${TEMPLATE}/commits/${sha ?? BASE}`, "--jq", ".sha"]).trim();
  if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`GitHub gave no commit for ${sha ?? BASE}`);
  if (sha !== undefined) {
    const status = compareWithMain(TEMPLATE, full, run);
    if (!ON_MAIN.has(status)) throw new Error(`the commit ${full} is not on main of ${TEMPLATE} (status: ${status})`);
  }
  return full;
}

/** This function gives the reasons that a release can start in a repository (step 3), with the open pull requests. */
export function checkRepo(repository, { ownBranch } = {}, run = gh) {
  const runs = jsonLines(
    run(["api", `repos/${repository}/actions/workflows/release.yml/runs?per_page=30`, "--jq", '.workflow_runs[] | select(.status != "completed") | {status, url: .html_url}']),
  );
  const pulls = jsonLines(
    run(["api", "--paginate", `repos/${repository}/pulls?state=open&base=${BASE}&per_page=100`, "--jq", ".[] | {number, head: .head.ref, url: .html_url}"]),
  );
  const filesOf = (number) =>
    jsonLines(
      run([
        "api",
        "--paginate",
        `repos/${repository}/pulls/${number}/files?per_page=100`,
        "--jq",
        '.[] | select(.filename == "package.json" or (.filename | endswith("/package.json"))) | {filename, patch}',
      ]),
    );
  return { pulls, blockers: releaseBlockers({ pulls, filesOf, runs, ownBranch }) };
}

/**
 * This function moves the pins of one repository (steps 1 to 5). It gives { repository, result, text, url }:
 * result is "opened", "planned", "skipped", "refused" or "error". `compareCache` keeps the compare of
 * each old pin, for the next repositories.
 */
export function bumpRepo(repository, { target, dryRun = false, notes, coAuthor, footer, compareCache = new Map() }, run = gh) {
  const done = (result, text, url) => ({ repository, result, text, url });
  const branch = branchName(target);

  let head;
  let file;
  try {
    head = run(["api", `repos/${repository}/git/ref/heads/${BASE}`, "--jq", ".object.sha"]).trim();
    file = JSON.parse(run(["api", `repos/${repository}/contents/${WORKFLOW}?ref=${head}`]));
  } catch (error) {
    if (/HTTP 404|Not Found/.test(firstLine(error))) return done("skipped", `no ${WORKFLOW} on ${BASE}`);
    return done("error", `GitHub did not give ${WORKFLOW}: ${firstLine(error)}`);
  }
  const text = Buffer.from(file.content, "base64").toString("utf8");
  const pins = findPins(text);
  if (pins.length === 0) return done("skipped", `${WORKFLOW} has no pin of ${TEMPLATE} ("@<commit> # main")`);
  const old = pins.filter(({ sha }) => sha !== target);
  if (old.length === 0) return done("skipped", `each pin is at ${short(target)}`);

  // The new commits of the template, and a target that is older than a pin.
  const commits = new Map();
  for (const sha of new Set(old.map((pin) => pin.sha))) {
    let compare = compareCache.get(sha);
    if (compare === undefined) {
      try {
        compare = JSON.parse(
          run([
            "api",
            `repos/${TEMPLATE}/compare/${sha}...${target}`,
            "--jq",
            "{status, commits: [.commits[] | {sha, message: .commit.message}]}",
          ]),
        );
      } catch (error) {
        return done("error", `GitHub did not compare the pin ${short(sha)} with ${short(target)}: ${firstLine(error)}`);
      }
      compareCache.set(sha, compare);
    }
    if (compare.status === "behind") return done("refused", `the target ${short(target)} is older than the pin ${short(sha)}`);
    for (const commit of compare.commits) commits.set(commit.sha, commit);
  }

  let check;
  try {
    check = checkRepo(repository, { ownBranch: branch }, run);
  } catch (error) {
    return done("refused", `the release check failed, so the script did not continue: ${firstLine(error)}`);
  }
  const own = check.pulls.find((pull) => pull.head === branch);
  if (own !== undefined) return done("skipped", `the pull request #${own.number} for ${short(target)} is open`, own.url);
  if (check.blockers.length > 0) return done("refused", `a release can start (HTTP 403 of the tag job): ${check.blockers.join("; ")}`);

  const changed = old.map(({ path, sha }) => ({ path, sha }));
  const plan = `${changed.length} of ${pins.length} pins from ${[...new Set(changed.map(({ sha }) => short(sha)))].join(", ")} to ${short(target)}`;
  if (dryRun) return done("planned", `${plan}, on the branch ${branch}`);

  try {
    run(["api", "-X", "POST", `repos/${repository}/git/refs`, "--input", "-", "--jq", ".ref"], JSON.stringify({ ref: `refs/heads/${branch}`, sha: head }));
  } catch (error) {
    return done("error", `GitHub did not make the branch ${branch} (remove an old branch with that name): ${firstLine(error)}`);
  }
  try {
    run(
      ["api", "-X", "PUT", `repos/${repository}/contents/${WORKFLOW}`, "--input", "-", "--jq", ".commit.sha"],
      JSON.stringify({
        message: commitMessage({ target, pins: changed, coAuthor }),
        content: Buffer.from(replacePins(text, target), "utf8").toString("base64"),
        sha: file.sha,
        branch,
      }),
    );
    const url = run(
      ["api", "-X", "POST", `repos/${repository}/pulls`, "--input", "-", "--jq", ".html_url"],
      JSON.stringify({
        title: prTitle(target),
        head: branch,
        base: BASE,
        body: prBody({ repository, target, pins: changed, commits: [...commits.values()], notes, footer }),
      }),
    ).trim();
    return done("opened", plan, url);
  } catch (error) {
    // No pull request: remove the branch, so that the next start of the script can make it again.
    try {
      run(["api", "-X", "DELETE", `repos/${repository}/git/refs/heads/${branch}`]);
    } catch {
      // The error text below tells the cause.
    }
    return done("error", `GitHub did not commit or open the pull request: ${firstLine(error)}`);
  }
}

/** This function reads the arguments. It gives { repositories, options } or { error }. */
export function parseArgs(argv) {
  const valued = new Set(["--sha", "--notes", "--co-author", "--footer"]);
  const flags = new Set(["--dry-run", "--check"]);
  const options = { dryRun: false, check: false };
  const repositories = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valued.has(arg)) {
      if (argv[i + 1] === undefined) return { error: `${arg} needs a value` };
      const key = arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
      options[key] = argv[++i];
    } else if (flags.has(arg)) options[arg === "--dry-run" ? "dryRun" : "check"] = true;
    else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    else if (/^[\w.-]+(\/[\w.-]+)?$/.test(arg)) repositories.push(arg.includes("/") ? arg : `${TEMPLATE.split("/")[0]}/${arg}`);
    else return { error: `not a repository: ${arg}` };
  }
  if (repositories.length === 0) return { error: "no repository" };
  return { repositories, options };
}

// This part runs for "node bump-pins.mjs", not for an import (the tests). realpath: the path can have a link.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    process.stderr.write(
      `${parsed.error}\nusage: node scripts/release/bump-pins.mjs [--sha <commit>] [--dry-run | --check] [--notes <text>] [--co-author <name>] [--footer <text>] <owner/repo> ...\n`,
    );
    process.exit(2);
  }
  const { repositories, options } = parsed;
  const results = [];
  if (options.check) {
    for (const repository of repositories) {
      try {
        const { blockers } = checkRepo(repository);
        results.push({ repository, result: blockers.length === 0 ? "quiet" : "refused", text: blockers.join("; ") || "no version pull request and no active release run" });
      } catch (error) {
        results.push({ repository, result: "error", text: `the release check failed: ${firstLine(error)}` });
      }
      const last = results.at(-1);
      process.stdout.write(`${repository}: ${last.result}: ${last.text}\n`);
    }
  } else {
    let target;
    try {
      target = resolveTarget(options.sha);
    } catch (error) {
      process.stderr.write(`The target commit is not correct: ${firstLine(error)}\n`);
      process.exit(1);
    }
    process.stdout.write(`Target: ${TEMPLATE}@${target}${options.dryRun ? " (dry run: no change)" : ""}\n`);
    const compareCache = new Map();
    for (const repository of repositories) {
      const result = bumpRepo(repository, { ...options, target, compareCache });
      results.push(result);
      process.stdout.write(`${repository}: ${result.result}: ${result.text}${result.url ? ` ${result.url}` : ""}\n`);
    }
  }
  process.stdout.write("\nSummary:\n");
  for (const { repository, result, url } of results) process.stdout.write(`  ${result.padEnd(8)} ${repository}${url ? `  ${url}` : ""}\n`);
  process.exit(results.some(({ result }) => result === "refused" || result === "error") ? 1 : 0);
}
