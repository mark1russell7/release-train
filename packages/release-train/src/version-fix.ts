import { createHash } from "node:crypto";
import semver from "semver";
import { TRAIN_BRANCH, ciState, latestRuns } from "./apply.ts";
import { pool } from "./collect.ts";
import type { GitHub } from "./github.ts";
import { SYNC_BRANCH } from "./sync.ts";

/**
 * The version fix. An automated dependency update can change the shipped files of a package, but keep a version that npm
 * has. Then the release check of the template fails ("The release skips a version that is on npm"), or in a repository with
 * Changesets the changeset check fails. This module finds such a pull request of Renovate or of the train, and decides if
 * the train can add the missing PATCH. The writer (`versionFix` of `gitUpdater` in `workspace.ts`) adds it.
 */

/** The login of the Renovate app on GitHub. */
export const RENOVATE_LOGIN = "renovate[bot]";

/**
 * The branches of the Renovate groups with no breaking update. The shared preset `renovate/base.json` of the template
 * makes these groups. They are the patch updates, the minor updates, the minor updates of the development dependencies,
 * and the lock file maintenance.
 */
export const FIX_BRANCHES: readonly string[] = ["renovate/npm-patch", "renovate/npm-minor", "renovate/npm-dev-minor", "renovate/lock-file-maintenance"];

/** The branch of the group of the 0.x minor updates. Before 1.0.0 a minor update can break, so a person reviews it. */
export const ZERO_MINOR_BRANCH = "renovate/npm-zero-minor";

/** The key of the trailer line of a version fix in a commit message. */
export const FIX_TRAILER = "Release-Train-Version-Fix";

/** The text of the CHANGELOG section and of the changeset of a version fix. */
export const FIX_TEXT = "An automated dependency update changes the shipped files, so this PATCH ships them.";

/** The first line of the message of the release check (`scripts/release/pack.ts` of the template). */
const UNSHIPPED_HEAD = "The release skips a version that is on npm, so these changes would not ship.";

/** The first line of the note of the release check for the packages that a pending changeset raises. It is not an error. */
const PENDING_HEAD = "A pending changeset raises the version of these packages";

/** The message of the changeset check (`.github/actions/changeset-check/check.ts` of the template). */
const MISSING_CHANGESET = /These published packages change and have no changeset: (.+?)\. Add one with "pnpm changeset"/;

/** The last line of each failed job of GitHub Actions. It tells no reason. */
const GENERIC_EXIT = /^Process completed with exit code \d+\.?$/;

/** The results of other jobs in a summary job. An annotation gives one result, for example `ci: failure`. */
const RESULT = "(?:success|failure|cancelled|skipped|timed_out|action_required|startup_failure)";
const RESULT_LINE = new RegExp(`^[\\w./() -]{1,100}: ${RESULT}(?:, [\\w./() -]{1,100}: ${RESULT})*$`);
/** A log line of a summary job gives two or more results, for example `checks: failure, pack: failure, site: success`. */
const RESULT_LIST = new RegExp(`^[\\w./() -]{1,100}: ${RESULT}(?:, [\\w./() -]{1,100}: ${RESULT})+$`);

/** The form of a package name on npm. */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** A package whose shipped files differ from the same version on npm. */
export interface Unshipped {
  name: string;
  version: string;
}

/** A package that needs a version fix. The version is the version on npm, or null when only a changeset check names the package. */
export interface FixNeed {
  name: string;
  version: string | null;
}

/** The mark of a version fix in a commit message: a new version from `from` to `to`, or a patch changeset (`from` and `to` are null). */
export interface FixMark {
  name: string;
  from: string | null;
  to: string | null;
}

/**
 * This function gives the lines of a check text. It removes the time stamps of a job log, the color codes and the error
 * prefixes of GitHub Actions.
 */
export function checkLines(text: string): string[] {
  return text.split(/\r?\n/).map((raw) =>
    raw
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/^##\[error\]/, "")
      .replace(/^::error(?: [^:]*)?::/, ""),
  );
}

/**
 * This function reads the release check text: an annotation or a job log. It gives each package whose shipped files differ
 * from the same version on npm. Only the lines of the error block count. The output lines of `pnpm pack` and the note of a
 * pending changeset do not count.
 */
export function parseUnshipped(text: string): Unshipped[] {
  const found = new Map<string, Unshipped>();
  let inside = false;
  for (const line of checkLines(text)) {
    const t = line.trim();
    if (t.startsWith(UNSHIPPED_HEAD)) {
      inside = true;
      continue;
    }
    if (t.startsWith(PENDING_HEAD) || GENERIC_EXIT.test(t)) {
      inside = false;
      continue;
    }
    if (!inside) continue;
    const m = /^(\S+)@([^\s@]+) is on npm, but these shipped files differ from it:$/.exec(t);
    const name = m?.[1];
    const version = m?.[2];
    if (name === undefined || version === undefined || !NPM_NAME.test(name) || semver.valid(version) === null) continue;
    found.set(`${name}@${version}`, { name, version });
  }
  return [...found.values()];
}

/** This function reads the message of the changeset check. It gives the published packages that change and have no changeset. */
export function parseMissingChangesets(text: string): string[] {
  const names = new Set<string>();
  for (const line of checkLines(text)) {
    const list = MISSING_CHANGESET.exec(line)?.[1];
    if (list === undefined) continue;
    for (const name of list.split(",").map((x) => x.trim())) if (NPM_NAME.test(name)) names.add(name);
  }
  return [...names];
}

/** One failed check run of the head of a pull request. */
export interface FailedCheck {
  name: string;
  /** The messages of the annotations of the level `failure`. */
  annotations: readonly string[];
  /** The log of the job. The run reads it only when the annotations tell no known message. */
  log?: string | null;
}

/** What a failed check tells. */
export interface CheckReading {
  unshipped: Unshipped[];
  missing: string[];
  /** True when the check only gives the results of other jobs, for example the summary job `CI OK`. */
  aggregate: boolean;
  /** The error lines that are not a known message. */
  other: string[];
}

/** This function tells if a text is a known message: the release check or the changeset check. */
function known(text: string): boolean {
  return parseUnshipped(text).length > 0 || parseMissingChangesets(text).length > 0;
}

/**
 * This function reads one failed check. Each annotation is a known message, a result line of a summary job, the last line
 * of a failed job, or another error. In a job log, only the error lines (`##[error]`) can be another error.
 */
export function readCheck(c: FailedCheck): CheckReading {
  const reading: CheckReading = { unshipped: [], missing: [], aggregate: false, other: [] };
  const add = (text: string): void => {
    reading.unshipped.push(...parseUnshipped(text));
    reading.missing.push(...parseMissingChangesets(text));
  };
  for (const message of c.annotations) {
    const t = message.trim();
    if (GENERIC_EXIT.test(t)) continue;
    if (known(t)) add(t);
    else if (RESULT_LINE.test(t)) reading.aggregate = true;
    else reading.other.push(t);
  }
  if (c.log) {
    add(c.log);
    for (const raw of c.log.split(/\r?\n/)) {
      const at = raw.indexOf("##[error]");
      if (at < 0) continue;
      const t = (checkLines(raw.slice(at))[0] ?? "").trim();
      if (!GENERIC_EXIT.test(t) && !known(t)) reading.other.push(t);
    }
    if (checkLines(c.log).some((line) => RESULT_LIST.test(line.trim()) && line.includes(": failure"))) reading.aggregate = true;
  }
  return reading;
}

/** The facts of an open pull request that the scope reads. */
export interface PullInfo {
  number: number;
  /** The login of the author, for example `renovate[bot]`. */
  author: string;
  headRef: string;
  headSha: string;
  /** False when the head branch is in a fork. */
  sameRepo: boolean;
  body: string | null;
}

/** The decision of a pull request. A skip has a reason with no name, and a detail that only a public repository shows. */
export type FixDecision =
  | { act: true; source: "renovate" | "train"; needs: FixNeed[] }
  | { act: false; reason: string; detail?: string };

const skip = (reason: string, detail?: string): FixDecision => (detail === undefined ? { act: false, reason } : { act: false, reason, detail });

/** This function gives the kind of a pull request of the train from its body, for example `adopt-in-range`. */
export function trainKind(body: string | null): string | null {
  return /\(plan action `[^`]*`, kind `([^`]+)`/.exec(body ?? "")?.[1] ?? null;
}

/**
 * This function decides from the author and the branch if the version fix can act on a pull request. It acts only on a
 * group of non-breaking updates of Renovate, and on an update of the train that is not a breaking adoption. The train
 * writes the version bump of a breaking adoption itself.
 */
export function pullScope(pr: PullInfo, trainLogin: string | null): FixDecision | { act: true; source: "renovate" | "train" } {
  if (!pr.sameRepo) return skip("the head branch is in a fork");
  if (pr.author === RENOVATE_LOGIN) {
    if (FIX_BRANCHES.includes(pr.headRef)) return { act: true, source: "renovate" };
    if (pr.headRef === ZERO_MINOR_BRANCH) return skip("a 0.x minor update can break, so a person reviews it");
    if (/(^|[/-])major([/-]|$)/.test(pr.headRef)) return skip("a major update can break, so a person reviews it");
    return skip("the Renovate branch is not a group of non-breaking npm updates");
  }
  if (trainLogin !== null && pr.author === trainLogin) {
    if (pr.headRef === SYNC_BRANCH) return skip("the template sync is not a dependency update");
    if (pr.headRef !== TRAIN_BRANCH) return skip("the branch is not the update branch of the train");
    const kind = trainKind(pr.body);
    if (kind === null) return skip("the body of the train pull request names no kind");
    if (kind === "adopt-breaking") return skip("a breaking adoption: the train writes its version bump itself");
    return { act: true, source: "train" };
  }
  if (pr.author.endsWith("[bot]")) return skip("a pull request of another bot");
  return skip("a pull request of a person");
}

/** The CI facts of the head of a pull request. */
export interface CiFacts {
  state: "none" | "running" | "failed" | "green";
  /** True when a commit status (not a check run) failed. */
  statusFailed: boolean;
  failed: readonly FailedCheck[];
}

/**
 * This function decides if the version fix acts on a pull request in scope. It acts only when each failed check tells a
 * known message, or only gives the results of other jobs. A version fix can be in the commits of the pull request. When
 * that fix has a package of the check, the function stops. Thus a second run does not raise a version two times.
 */
export function decideFix(source: "renovate" | "train", ci: CiFacts, marks: readonly FixMark[]): FixDecision {
  if (ci.state === "running") return skip("CI runs");
  if (ci.state === "none") return skip("the head has no CI result");
  if (ci.state === "green") return skip("CI is green");
  if (ci.statusFailed) return skip("a commit status failed");
  const needs = new Map<string, FixNeed>();
  for (const c of ci.failed) {
    const r = readCheck(c);
    if (r.other.length > 0) return skip("a check failed with another error", `${c.name}: ${r.other[0]?.slice(0, 200) ?? ""}`);
    if (r.unshipped.length === 0 && r.missing.length === 0 && !r.aggregate) return skip("a check failed with no known message", c.name);
    for (const u of r.unshipped) needs.set(u.name, u);
    for (const name of r.missing) if (!needs.has(name)) needs.set(name, { name, version: null });
  }
  if (needs.size === 0) return skip("no failed check names a package");
  const marked = [...needs.keys()].filter((name) => marks.some((m) => m.name === name));
  if (marked.length > 0) return skip("the head has a version fix for a package already, so a person decides", marked.join(", "));
  return { act: true, source, needs: [...needs.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** The versions of a package on npm. */
export interface NpmVersions {
  versions: readonly string[];
  latest: string | null;
}

/**
 * This function gives the PATCH of a version on npm. It refuses a version that npm has. It also refuses a version that is
 * not greater than the `latest` version of npm, because the release check refuses it too. A person decides then.
 */
export function patchTarget(version: string, npm: NpmVersions | null): { to: string } | { reason: string } {
  const to = semver.inc(version, "patch");
  if (to === null) return { reason: `${version} is not a SemVer version` };
  if (npm === null) return { reason: "npm gives no versions of the package" };
  if (npm.versions.includes(to)) return { reason: `npm has ${to} already` };
  if (npm.latest !== null && semver.valid(npm.latest) !== null && !semver.gt(to, npm.latest)) return { reason: `${to} is not greater than the latest version ${npm.latest} on npm` };
  return { to };
}

/** This function gives the trailer line of a version fix. */
export function fixTrailer(m: FixMark): string {
  return m.from !== null && m.to !== null ? `${FIX_TRAILER}: ${m.name} ${m.from} -> ${m.to}` : `${FIX_TRAILER}: ${m.name} changeset`;
}

/** This function reads the marks of the version fixes from commit messages. */
export function parseFixMarks(messages: readonly string[]): FixMark[] {
  const found = new Map<string, FixMark>();
  const line = new RegExp(`^${FIX_TRAILER}: (\\S+) (?:(\\S+) -> (\\S+)|changeset)\\s*$`);
  for (const message of messages) {
    for (const raw of message.split(/\r?\n/)) {
      const m = line.exec(raw.trim());
      const name = m?.[1];
      if (name === undefined) continue;
      found.set(name, { name, from: m?.[2] ?? null, to: m?.[3] ?? null });
    }
  }
  return [...found.values()];
}

/** This function gives the commit message of a version fix. The trailers let the train keep the fix when it builds the branch again. */
export function fixCommitMessage(marks: readonly FixMark[]): string {
  const what = marks.length === 1 ? (marks[0]?.name ?? "") : `${marks.length} packages`;
  const rows = marks.map((m) => (m.from !== null && m.to !== null ? `- ${m.name}: ${m.from} -> ${m.to} (package.json)` : `- ${m.name}: a patch changeset`));
  return [`chore(release): patch version of ${what}`, "", FIX_TEXT, "", ...rows, "", ...marks.map(fixTrailer)].join("\n");
}

/** This function gives the fingerprint of the changeset file of a version fix. The same packages give the same file name. */
export function fixFingerprint(names: readonly string[]): string {
  return createHash("sha256").update(`version-fix|${[...names].sort().join(",")}`).digest("hex").slice(0, 12);
}

/** The work of the writer for one pull request. */
export interface FixJob {
  repo: string;
  /** The head branch of the pull request. */
  branch: string;
  /** The head commit that CI read. When the branch has another head, the writer does nothing. */
  sha: string;
  needs: readonly FixNeed[];
}

/** One version fix that the writer made. */
export interface FixDone {
  name: string;
  /** The folder of the package. */
  path: string;
  via: "version" | "changeset";
  from: string | null;
  to: string | null;
}

/** The result of the writer for one pull request. */
export interface FixResult {
  status: "pushed" | "no-change" | "moved" | "failed";
  sha: string | null;
  done: FixDone[];
  /** The packages with no fix, each with its reason. */
  left: { name: string; reason: string }[];
  error: string | null;
}

/** The writer of the version fixes. `gitUpdater` makes it. Tests give a mock. */
export interface VersionFixer {
  versionFix(job: FixJob): Promise<FixResult>;
}

/** One pull request that the run read. */
export interface FixRow {
  repo: string;
  private: boolean;
  pr: number;
  action: "fixed" | "planned" | "skipped" | "no-change" | "error";
  reason: string;
  /** The names of the packages. A public report only. */
  packages: string[];
}

/** The options of a run of the version fix. */
export interface FixRunOptions {
  gh: GitHub;
  owner: string;
  repos: readonly { name: string; private: boolean }[];
  /** The writer. A dry run gives null. */
  fixer: VersionFixer | null;
  /** The login of the GitHub App of the train, for example `name[bot]`. */
  trainLogin: string | null;
  log?: (line: string) => void;
  /** The name of a repository in the log: a private repository gets its hash. */
  label?: (repo: string, priv: boolean) => string;
  concurrency?: number;
}

interface CheckRunData {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  check_suite?: { id: number } | null;
  app?: { slug?: string } | null;
}

interface PullData {
  number: number;
  body: string | null;
  user?: { login?: string } | null;
  head: { sha: string; ref: string; repo?: { full_name: string } | null };
  base: { repo?: { full_name: string } | null };
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/**
 * This function finds the pull requests of the repositories that need a version fix, and gives each one to the writer. It
 * writes one log line for each pull request. A private repository shows only its hash, with no package name and no detail.
 */
export async function versionFixRun(o: FixRunOptions): Promise<FixRow[]> {
  const log = o.log ?? (() => {});
  const label = o.label ?? ((repo: string) => repo);
  const base = `/repos/${o.owner}`;
  const rows: FixRow[] = [];
  const row = (r: FixRow, detail?: string): void => {
    rows.push(r);
    const name = r.private ? label(r.repo, true) : `${r.repo}#${r.pr}`;
    const extra = r.private ? (r.packages.length > 0 ? ` Packages: ${r.packages.length}.` : "") : `${r.packages.length > 0 ? ` Packages: ${r.packages.join(", ")}.` : ""}${detail ? ` (${detail})` : ""}`;
    log(`version fix ${name}: ${r.action}, ${r.reason}.${extra}`);
  };

  const ciOf = async (repo: string, sha: string): Promise<CiFacts> => {
    const runs = await o.gh.request<{ check_runs: CheckRunData[] }>("GET", `${base}/${repo}/commits/${sha}/check-runs?per_page=100`);
    const status = await o.gh.request<{ state: string; total_count: number }>("GET", `${base}/${repo}/commits/${sha}/status`);
    const workflows = await o.gh.request<{ workflow_runs: { workflow_id: number; check_suite_id: number; created_at: string }[] }>("GET", `${base}/${repo}/actions/runs?head_sha=${sha}&per_page=100`);
    const latest = latestRuns(runs.data?.check_runs ?? [], workflows.data?.workflow_runs ?? []) as CheckRunData[];
    if (!runs.ok) return { state: "none", statusFailed: false, failed: [] };
    // A check that runs can still fail with another error, so the fix waits for each check.
    const state = latest.some((r) => r.status !== "completed") ? "running" : ciState(latest, status.data);
    const statusFailed = (status.data?.total_count ?? 0) > 0 && (status.data?.state === "failure" || status.data?.state === "error");
    if (state !== "failed") return { state, statusFailed, failed: [] };
    const failed: FailedCheck[] = [];
    for (const run of latest.filter((r) => r.status === "completed" && r.conclusion !== null && FAILED.has(r.conclusion))) {
      const notes = await o.gh.request<{ annotation_level?: string; message?: string }[]>("GET", `${base}/${repo}/check-runs/${run.id}/annotations?per_page=100`);
      const annotations = (notes.data ?? []).filter((a) => a.annotation_level === "failure").map((a) => a.message ?? "");
      const check: FailedCheck = { name: run.name, annotations };
      const told = readCheck(check);
      // The annotations of a job can hold only the last line. Then the log of the job tells the message.
      if (told.unshipped.length === 0 && told.missing.length === 0 && !told.aggregate && told.other.length === 0 && run.app?.slug === "github-actions" && o.gh.text) {
        const text = await o.gh.text(`${base}/${repo}/actions/jobs/${run.id}/logs`);
        check.log = text.ok ? text.data : null;
      }
      failed.push(check);
    }
    return { state, statusFailed, failed };
  };

  const marksOf = async (repo: string, pr: number): Promise<FixMark[]> => {
    const commits = await o.gh.request<{ commit?: { message?: string } }[]>("GET", `${base}/${repo}/pulls/${pr}/commits?per_page=100`);
    return parseFixMarks((commits.data ?? []).map((c) => c.commit?.message ?? ""));
  };

  await pool(o.repos, o.concurrency ?? 6, async (r) => {
    const res = await o.gh.request<PullData[]>("GET", `${base}/${r.name}/pulls?state=open&per_page=100`);
    if (!res.ok) {
      log(`version fix ${label(r.name, r.private)}: the open pull requests are not readable (HTTP ${res.status}).`);
      return;
    }
    for (const p of res.data ?? []) {
      const one = { repo: r.name, private: r.private, pr: p.number };
      try {
        const info: PullInfo = {
          number: p.number,
          author: p.user?.login ?? "",
          headRef: p.head.ref,
          headSha: p.head.sha,
          sameRepo: p.head.repo?.full_name !== undefined && p.head.repo.full_name === p.base.repo?.full_name,
          body: p.body,
        };
        const scope = pullScope(info, o.trainLogin);
        if (!scope.act) {
          row({ ...one, action: "skipped", reason: scope.reason, packages: [] }, scope.detail);
          continue;
        }
        const ci = await ciOf(r.name, p.head.sha);
        // Only a failed head needs the marks of the commits.
        const d = decideFix(scope.source, ci, ci.state === "failed" ? await marksOf(r.name, p.number) : []);
        if (!d.act) {
          row({ ...one, action: "skipped", reason: d.reason, packages: [] }, d.detail);
          continue;
        }
        const names = d.needs.map((n) => (n.version === null ? n.name : `${n.name}@${n.version}`));
        if (o.fixer === null) {
          row({ ...one, action: "planned", reason: `a dry run, the run adds the PATCH to ${d.needs.length} ${d.needs.length === 1 ? "package" : "packages"}`, packages: names });
          continue;
        }
        const w = await o.fixer.versionFix({ repo: r.name, branch: p.head.ref, sha: p.head.sha, needs: d.needs });
        const done = w.done.map((x) => (x.via === "changeset" ? `${x.name} (changeset)` : `${x.name} ${x.from ?? "?"} -> ${x.to ?? "?"}`));
        const leftDetail = w.left.map((x) => `${x.name}: ${x.reason}`).join("; ");
        if (w.status === "pushed") row({ ...one, action: "fixed", reason: `the PATCH of ${w.done.length} ${w.done.length === 1 ? "package" : "packages"} is pushed (${w.sha?.slice(0, 7) ?? "?"})`, packages: done }, leftDetail || undefined);
        else if (w.status === "failed") row({ ...one, action: "error", reason: "the writer failed", packages: names }, w.error ?? undefined);
        else if (w.status === "moved") row({ ...one, action: "skipped", reason: "the branch has a new head, so a next run reads its CI", packages: [] });
        else row({ ...one, action: "no-change", reason: "the head needs no change", packages: names }, leftDetail || undefined);
      } catch (e) {
        row({ ...one, action: "error", reason: "a read failed", packages: [] }, e instanceof Error ? e.message : String(e));
      }
    }
  });
  return rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
}

/** This function gives the summary of a run. A private repository is only a count. */
export function versionFixSummary(rows: readonly FixRow[], dryRun: boolean): string {
  const count = (a: FixRow["action"]): number => rows.filter((r) => r.action === a).length;
  const lines = [`Version fix${dryRun ? " (dry run)" : ""}: ${rows.length} open pull requests, ${count("fixed")} fixed, ${count("planned")} planned, ${count("no-change")} with no change, ${count("error")} errors.`];
  for (const r of rows) {
    if (r.action === "skipped") continue;
    lines.push(r.private ? `- a private repository: ${r.action}, ${r.reason}.` : `- ${r.repo}#${r.pr}: ${r.action}, ${r.reason}.${r.packages.length > 0 ? ` ${r.packages.join(", ")}.` : ""}`);
  }
  return lines.join("\n");
}
