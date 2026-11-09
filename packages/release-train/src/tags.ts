import { releaseNotes, tagName } from "@mark1russell7/conventions";
import { runCommand } from "@procedures/shell/command";
import semver from "semver";
import { slsaStatements, type Attestations } from "./attest.ts";
import { pool } from "./collect.ts";
import type { FetchFn } from "./collect.ts";
import type { PackageNode, RepoSnapshot } from "./types.ts";
import type { RunResult } from "./workspace.ts";

export { MAX_NOTES, changelogSection, npmUrl, releaseNotes, tagName } from "@mark1russell7/conventions";

/** The default size of the window of `tags`, in days. An older version needs `--since`. */
export const TAGS_WINDOW_DAYS = 14;

/** This function gives the default start date of `tags`: `TAGS_WINDOW_DAYS` days before `now`, in UTC. */
export function defaultSince(now: Date = new Date()): string {
  return new Date(now.getTime() - TAGS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** This function refuses a write with a start date from before the window. A dry run has no such limit. */
export function checkWriteWindow(since: string, now: Date = new Date()): void {
  const earliest = defaultSince(now);
  if (since < earliest) throw new Error(`--write needs a start date of ${earliest} or later, not ${since}. A dry run reads older dates.`);
}

/**
 * The youngest age of a version that `tags` examines, in milliseconds. A younger version can wait for the job `tag` of
 * its release run. That job skips a tag that exists, so an early backfill stops the job before it sets the latest release.
 */
export const MIN_AGE_MS: number = 60 * 60 * 1000;

const SHA = /^[0-9a-f]{40}$/;

/** The rule of the workflow for a tag: only the characters of an npm name and a version, and no hyphen at the start. */
const TAG = /^[A-Za-z0-9@][A-Za-z0-9@._/+-]*$/;

/** The function that starts `gh` with an argument list. `input` goes to its standard input. Tests give a fake. */
export type GhFn = (args: readonly string[], input?: string) => Promise<RunResult>;

/** This function starts `gh` with no shell, through the command helper of `@procedures/shell`. */
export const ghCommand: GhFn = async (args, input) => {
  const r = await runCommand("gh", { args, timeout: 120_000, ...(input === undefined ? {} : { input }) });
  return { code: r.exitCode, stdout: r.stdout, stderr: r.error ?? r.stderr };
};

/** This function tells if a date of the form `YYYY-MM-DD` exists in the calendar. */
export function validDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === text;
}

/**
 * This function gives the commit of an npm attestations document, or null.
 * The statement must name the repository by its ID, the same as the job `tag` of the release workflow.
 */
export function provenanceCommit(doc: Attestations, repositoryId: string): string | null {
  for (const statement of slsaStatements(doc)) {
    const build = statement.predicate?.buildDefinition;
    if (String(build?.internalParameters?.github?.repository_id) !== repositoryId) continue;
    const commit = build?.resolvedDependencies?.[0]?.digest?.gitCommit;
    if (typeof commit === "string" && SHA.test(commit)) return commit;
  }
  return null;
}

/** One repository of the backfill. */
export interface TagRepo {
  name: string;
  private: boolean;
  defaultBranch: string;
  /** The count of published packages on the default branch, by the rule of the template for a tag. */
  publishedCount: number;
  packages: { name: string; path: string }[];
}

/**
 * This function gives the repositories of the backfill: each repository with a package of the owner on npm.
 * With `only`, the list has only the repositories of that list.
 */
export function tagRepos(repos: readonly RepoSnapshot[], packages: readonly PackageNode[], only: readonly string[] | null = null): TagRepo[] {
  return repos
    .filter((r) => only === null || only.includes(r.name))
    .map((r) => ({
      name: r.name,
      private: r.private,
      defaultBranch: r.defaultBranch,
      publishedCount: r.manifests.filter(({ manifest: m }) => Boolean(m.name) && m.private !== true).length,
      packages: packages.filter((p) => p.repo === r.name && p.npm.exists).map((p) => ({ name: p.name, path: p.path })),
    }))
    .filter((r) => r.packages.length > 0);
}

/**
 * The state of a version with no tag.
 *
 * - `missing`: a dry run found its commit on the default branch.
 * - `created`: the run made its release.
 * - `failed`: `gh` did not make its release, or the run could not read its text.
 * - `no-commit`: npm names no commit, or two different commits.
 * - `off-branch`: the commit is not on the default branch.
 * - `young`: the version is younger than `MIN_AGE_MS`.
 * - `no-tag-job`: the `release.yml` of the repository has no tag job, so the repository makes no tags.
 * - `error`: a read failed, so the version has no decision.
 */
export type TagState = "missing" | "created" | "failed" | "no-commit" | "off-branch" | "young" | "no-tag-job" | "error";

/** One version with no tag. */
export interface TagRow {
  repo: string;
  private: boolean;
  package: string;
  version: string;
  /** The publish date on npm, as `YYYY-MM-DD`. */
  published: string;
  tag: string;
  commit: string | null;
  state: TagState;
  detail: string;
}

/** The result of one run of the backfill. */
export interface TagsReport {
  owner: string;
  since: string;
  write: boolean;
  /** The count of versions from the start date. */
  versions: number;
  /** The count of these versions with a tag. */
  tagged: number;
  /** The count of `gh` processes that the run started. */
  processes: number;
  rows: TagRow[];
}

/** The input of `backfillTags`. */
export interface TagsInput {
  owner: string;
  repos: readonly TagRepo[];
  gh: GhFn;
  /** The start date, as `YYYY-MM-DD`. */
  since: string;
  /** Only `true` makes releases. Each other run makes no write. */
  write: boolean;
  fetch?: FetchFn;
  registryBase?: string;
  now?: Date;
  minAgeMs?: number;
  log?: (line: string) => void;
}

/** The part of a full npm document that the backfill reads. */
interface NpmDocument {
  time?: Record<string, string>;
  versions?: Record<string, { gitHead?: unknown; dist?: { attestations?: unknown } }>;
}

type NpmVersion = NonNullable<NpmDocument["versions"]>[string];

type CommitAnswer = { commit: string } | { state: "no-commit" | "error"; detail: string };

const RAW = "Accept: application/vnd.github.raw+json";

/** The shared workflow of the template that the tag job of a `release.yml` uses. */
const TAG_JOB = "reusable-release-tag.yml";

const failure = (r: RunResult): string => r.stderr.trim().split("\n")[0] ?? "";

/**
 * This function finds each published version with no git tag, and it makes the release of each one with `write`.
 *
 * The commit comes only from npm: `gitHead` of the version, or the commit of its provenance. A version gets no tag
 * when npm names no commit, when npm names two commits, or when the commit is not on the default branch.
 * A repository with no tag job in its `release.yml` gets no tag.
 * A failed read of one version gives a row with the state `error`, and the run continues.
 */
export async function backfillTags(i: TagsInput): Promise<TagsReport> {
  const f: FetchFn = i.fetch ?? ((u, init) => fetch(u, init));
  const registry = i.registryBase ?? "https://registry.npmjs.org";
  const now = (i.now ?? new Date()).getTime();
  if (i.write) checkWriteWindow(i.since, new Date(now));
  const since = Date.parse(`${i.since}T00:00:00Z`);
  const minAge = i.minAgeMs ?? MIN_AGE_MS;
  const encoded = (name: string): string => name.replaceAll("/", "%2f");
  const headers = { "user-agent": "release-train" };
  let processes = 0;
  const gh: GhFn = (args, input) => {
    processes++;
    return i.gh(args, input);
  };

  const backfillRepo = async (repo: TagRepo): Promise<{ versions: number; tagged: number; rows: TagRow[] }> => {
    const slug = `${i.owner}/${repo.name}`;
    const rows: TagRow[] = [];
    let versions = 0;
    let tagged = 0;

    // The tags of the repository. The read happens once, and only for a repository with a version from the start date.
    let tags: Promise<Set<string> | string> | null = null;
    const readTags = (): Promise<Set<string> | string> => {
      tags ??= gh(["api", "--paginate", `repos/${slug}/git/matching-refs/tags/`, "--jq", ".[].ref"]).then((r) =>
        r.code === 0 ? new Set(r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^refs\/tags\//, ""))) : `gh did not list the tags: ${failure(r)}`,
      );
      return tags;
    };

    let repositoryId: Promise<RunResult> | null = null;
    const readRepositoryId = (): Promise<RunResult> => (repositoryId ??= gh(["api", `repos/${slug}`, "--jq", ".id"]));

    const commitOf = async (name: string, version: string, meta: NpmVersion): Promise<CommitAnswer> => {
      const head = typeof meta.gitHead === "string" && SHA.test(meta.gitHead) ? meta.gitHead : null;
      let proven: string | null = null;
      if (meta.dist?.attestations) {
        const res = await f(`${registry}/-/npm/v1/attestations/${encoded(name)}@${encodeURIComponent(version)}`, { headers });
        if (res.status !== 404) {
          if (!res.ok) return { state: "error", detail: `npm gave HTTP ${res.status} for the provenance.` };
          const id = await readRepositoryId();
          if (id.code !== 0) return { state: "error", detail: `gh did not read the repository: ${failure(id)}` };
          proven = provenanceCommit((await res.json()) as Attestations, id.stdout.trim());
        }
      }
      if (head !== null && proven !== null && head !== proven) return { state: "no-commit", detail: `gitHead is ${head}, but the provenance names ${proven}.` };
      const commit = proven ?? head;
      return commit === null ? { state: "no-commit", detail: "npm has no gitHead and no provenance of this repository for this version." } : { commit };
    };

    // Packages of one repository often share a commit, so each commit gets one check.
    const checks = new Map<string, Promise<string>>();
    const onDefaultBranch = (commit: string): Promise<string> => {
      let check = checks.get(commit);
      if (check === undefined) {
        check = gh(["api", `repos/${slug}/compare/${encodeURIComponent(repo.defaultBranch)}...${commit}?per_page=1`, "--jq", ".status"]).then((r) => {
          // A commit that the repository does not have gives 404. A commit with no shared history gives 422.
          if (r.code !== 0) return /HTTP 404|HTTP 422/.test(r.stderr) ? "off" : `gh did not compare the commit: ${failure(r)}`;
          const status = r.stdout.trim();
          return status === "behind" || status === "identical" ? "on" : "off";
        });
        checks.set(commit, check);
      }
      return check;
    };

    // A repository whose release.yml has no tag job makes no tags on purpose. Its text says so.
    let tagJob: Promise<boolean | string> | null = null;
    const readTagJob = (): Promise<boolean | string> => {
      tagJob ??= gh(["api", "-H", RAW, `repos/${slug}/contents/.github/workflows/release.yml`]).then((r) => {
        if (r.code === 0) return r.stdout.includes(TAG_JOB);
        return r.stderr.includes("HTTP 404") ? false : `gh did not read release.yml: ${failure(r)}`;
      });
      return tagJob;
    };

    const readChangelog = async (path: string, commit: string): Promise<string | undefined> => {
      const file = [...(path ? path.split("/") : []), "CHANGELOG.md"].map(encodeURIComponent).join("/");
      const r = await gh(["api", "-H", RAW, `repos/${slug}/contents/${file}?ref=${commit}`]);
      if (r.code === 0) return r.stdout;
      if (r.stderr.includes("HTTP 404")) return undefined;
      throw new Error(`gh did not read the changelog: ${failure(r)}`);
    };

    const release = async (row: TagRow, path: string, commit: string): Promise<TagRow> => {
      let notes: string;
      try {
        notes = releaseNotes(row.package, row.version, await readChangelog(path, commit));
      } catch (e) {
        return { ...row, state: "failed", detail: e instanceof Error ? e.message : String(e) };
      }
      const flags = ["--latest=false", ...(semver.prerelease(row.version) === null ? [] : ["--prerelease"])];
      const r = await gh(["release", "create", row.tag, "--repo", slug, "--target", commit, "--title", row.tag, "--notes-file", "-", ...flags], notes);
      if (r.code !== 0) return { ...row, state: "failed", detail: `gh did not make the release: ${failure(r)}` };
      i.log?.(`${slug}: made the release ${row.tag}`);
      return { ...row, state: "created", detail: "The run made the release." };
    };

    for (const p of repo.packages) {
      const row = (version: string, at: number, state: TagState, detail: string): TagRow => ({
        repo: repo.name,
        private: repo.private,
        package: p.name,
        version,
        published: Number.isNaN(at) ? "?" : new Date(at).toISOString().slice(0, 10),
        tag: tagName(p.name, version, repo.publishedCount),
        commit: null,
        state,
        detail,
      });
      const res = await f(`${registry}/${encoded(p.name)}`, { headers });
      if (!res.ok) {
        rows.push(row("?", Number.NaN, "error", `npm gave HTTP ${res.status} for the package.`));
        continue;
      }
      const doc = (await res.json()) as NpmDocument;
      const time = doc.time ?? {};
      const inScope = Object.keys(doc.versions ?? {})
        .map((version) => ({ version, at: Date.parse(time[version] ?? "") }))
        .filter(({ at }) => Number.isNaN(at) || at >= since)
        .sort((a, b) => a.at - b.at);
      for (const { version, at } of inScope) {
        versions++;
        if (Number.isNaN(at)) {
          rows.push(row(version, at, "error", "npm gives no publish time for this version."));
          continue;
        }
        const known = await readTags();
        if (typeof known === "string") {
          rows.push(row(version, at, "error", known));
          continue;
        }
        // A repository can get a second package, so its earlier tags have the form of one package.
        if (known.has(tagName(p.name, version, 1)) || known.has(tagName(p.name, version, 2))) {
          tagged++;
          continue;
        }
        const r = row(version, at, "missing", "");
        if (!TAG.test(r.tag)) {
          rows.push({ ...r, state: "error", detail: "The tag has a character that is not correct." });
          continue;
        }
        if (now - at < minAge) {
          rows.push({ ...r, state: "young", detail: "The release run can still make this tag." });
          continue;
        }
        const job = await readTagJob();
        if (job !== true) {
          rows.push(job === false ? { ...r, state: "no-tag-job", detail: "The release.yml of this repository has no tag job." } : { ...r, state: "error", detail: job });
          continue;
        }
        const answer = await commitOf(p.name, version, doc.versions?.[version] ?? {});
        if ("state" in answer) {
          rows.push({ ...r, state: answer.state, detail: answer.detail });
          continue;
        }
        const { commit } = answer;
        const check = await onDefaultBranch(commit);
        if (check === "off") {
          rows.push({ ...r, commit, state: "off-branch", detail: `The commit is not on ${repo.defaultBranch}.` });
          continue;
        }
        if (check !== "on") {
          rows.push({ ...r, commit, state: "error", detail: check });
          continue;
        }
        const ready: TagRow = { ...r, commit, detail: "The commit is on the default branch." };
        rows.push(i.write ? await release(ready, p.path, commit) : ready);
      }
    }
    return { versions, tagged, rows };
  };

  const results = await pool(i.repos, 4, backfillRepo);
  return {
    owner: i.owner,
    since: i.since,
    write: i.write,
    versions: results.reduce((n, r) => n + r.versions, 0),
    tagged: results.reduce((n, r) => n + r.tagged, 0),
    processes,
    rows: results.flatMap((r) => r.rows),
  };
}

/** This function gives a text summary of a report: the counts, then one line for each version with no tag. */
export function tagsSummary(r: TagsReport): string {
  const count = (state: TagState): number => r.rows.filter((x) => x.state === state).length;
  const states: readonly TagState[] = ["missing", "created", "failed", "no-commit", "off-branch", "young", "no-tag-job", "error"];
  const lines = [
    `Tag backfill for ${r.owner}, versions from ${r.since} (${r.write ? "write" : "dry run"})`,
    `${r.versions} versions, ${r.tagged} with a tag, ${r.rows.length} with no tag, ${r.processes} gh processes`,
    `States: ${states.map((s) => `${count(s)} ${s}`).join(", ")}`,
  ];
  for (const x of r.rows) {
    lines.push(`${x.state.padEnd(10)} ${x.published} ${x.repo} ${x.package} ${x.version} ${x.tag} ${x.commit ?? "-"}`);
    if (x.state !== "missing" && x.state !== "created") lines.push(`           ${x.detail}`);
  }
  return lines.join("\n");
}
