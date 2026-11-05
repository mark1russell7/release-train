import { pool } from "./collect.ts";
import type { FetchFn } from "./collect.ts";
import { BLOCKED_LABEL, TRAIN_BRANCH } from "./apply.ts";
import type { GitHub } from "./github.ts";
import { SYNC_BRANCH } from "./sync.ts";
import { provenanceCommit } from "./tags.ts";
import type { PackageNode } from "./types.ts";

/** The most age of a change on the default branch with no release, in milliseconds. */
export const LAG_LIMIT_MS: number = 2 * 24 * 60 * 60 * 1000;

/** The most age of a failed check on an open pull request of the train, in milliseconds. */
export const RED_LIMIT_MS: number = 24 * 60 * 60 * 1000;

/** The most commits that the run reads for one package to find its first change. */
export const MAX_WALK = 60;

/** GitHub lists at most this count of files in one compare answer. */
const COMPARE_FILES = 300;

/**
 * The reason that a package has no release of its change.
 *
 * - `kept-version`: the version on the default branch is the published version, so a release starts only after a new number.
 * - `release-missing`: the default branch has a new version, and npm does not have it.
 */
export type LagReason = "kept-version" | "release-missing";

/** One package whose source on the default branch differs from its latest published version. */
export interface LagRow {
  repo: string;
  private: boolean;
  package: string;
  /** The latest version on npm. */
  published: string;
  /** The version on the default branch. */
  onBranch: string | null;
  /** The commit of the latest version. */
  commit: string;
  /** The count of the changed files of the package, on the first page of the compare answer. */
  files: number;
  /** The first commit after the release that changes a file of the package. */
  firstChange: { sha: string; title: string; at: string };
  /** True when the run stopped at `MAX_WALK`, so the change is older than `firstChange`. */
  partial: boolean;
  ageDays: number;
  reason: LagReason;
  /** True when the age is over the limit. */
  over: boolean;
}

/** One pull request of the train with a failed check. */
export interface RedRow {
  repo: string;
  private: boolean;
  number: number;
  url: string;
  title: string;
  /** The names of the failed checks. */
  checks: string[];
  /** The time of the first failure. */
  since: string;
  ageDays: number;
  over: boolean;
}

/** A package that the run could not compare. */
export interface LagUnread {
  repo: string;
  private: boolean;
  package: string;
  detail: string;
}

/** The result of `lagReport`. */
export interface LagReport {
  owner: string;
  generatedAt: string;
  /** The count of the published packages that the run read. */
  packages: number;
  rows: LagRow[];
  red: RedRow[];
  unread: LagUnread[];
}

/** The input of `lagReport`. */
export interface LagInput {
  owner: string;
  gh: GitHub;
  packages: readonly PackageNode[];
  /** The default branch of each repository. */
  branches: ReadonlyMap<string, string>;
  /** When this option is true, the run reads no private pull request. */
  publicOnly?: boolean;
  fetch?: FetchFn;
  registryBase?: string;
  now?: Date;
  concurrency?: number;
  log?: (line: string) => void;
}

interface CommitInfo {
  sha: string;
  commit: { message: string; committer: { date: string } };
}

interface CompareAnswer {
  status: string;
  total_commits?: number;
  base_commit?: CommitInfo;
  commits?: CommitInfo[];
  files?: { filename: string }[];
}

interface PackageVersion {
  gitHead?: unknown;
  dist?: { attestations?: unknown };
}

/** These folders of a package are not in a release: tests, docs, benches, examples, scripts and sites. */
const OUTSIDE_FOLDER = /(^|\/)(test|tests|__tests__|e2e|docs?|bench|benchmarks?|examples?|scripts|fixtures|site|\.github)\//;
/** These files of a package are not in a release: tests, text, hidden files and the settings of tools. */
const OUTSIDE_FILE = /(\.(test|spec)(\.[a-z]+)?\.[cm]?[jt]sx?|\.snap|\.md|(^|\/)(\.[^/]+|tsconfig[^/]*\.json|vitest\.config\.[cm]?ts|LICENSE|pnpm-lock\.yaml|pnpm-workspace\.yaml|renovate\.json|ste\.config\.json))$/;

/** Only these fields of a `package.json` change what a user of the package gets. A tool can add any other field. */
const USED_FIELDS: readonly string[] = [
  "bin",
  "browser",
  "bundleDependencies",
  "dependencies",
  "engines",
  "exports",
  "files",
  "imports",
  "main",
  "module",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "sideEffects",
  "type",
  "types",
];

/** This function gives the text of the part of a `package.json` that a user of the package gets. */
export function usedManifest(manifest: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.entries(manifest).filter(([k]) => USED_FIELDS.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}

/** One page of the commits of a folder. It is larger than `MAX_WALK`, so a full page is never read as all the commits. */
const FOLDER_PAGE = 100;
/** These folders hold the output of a build. A package that lists one of them publishes what its `src` folder builds. */
const BUILD_OUTPUT = /^(build|dist|lib|out)$/;
/** A commit of this type changes no behavior, so it does not start the clock of a release. */
const NO_EFFECT_COMMIT = /^(docs|style)(\([^)]*\))?:/;

/** This function gives the folder or the file that an item of a `files` list names, or null for a pattern with a wildcard. */
function listedPath(item: string): string | null {
  const plain = item.replace(/^\.\//, "").replace(/\/(\*\*?(\/\*)?)?$/, "");
  return /[*?![\]{}]/.test(plain) || plain === "" ? null : plain;
}

/**
 * This function gives the `files` list of a manifest, as paths. It gives null if the manifest has no such list, or if the
 * list has a wildcard. The caller then reads the names of the files only, so a file can count that the package does not publish.
 * A negated item only takes files out. A negated plain path stays in the list with its `!`, so that file does not count. A
 * negated pattern goes out of the list: a file can count, and no change goes unseen.
 */
export function publishedPaths(manifest: Readonly<Record<string, unknown>>): string[] | null {
  const files = manifest.files;
  if (!Array.isArray(files) || !files.every((x) => typeof x === "string")) return null;
  const always = [manifest.main, ...(typeof manifest.bin === "string" ? [manifest.bin] : Object.values((manifest.bin ?? {}) as object))].filter((x): x is string => typeof x === "string");
  const negated = (files as string[]).filter((x) => x.startsWith("!")).map((x) => listedPath(x.slice(1)));
  const paths = [...(files as string[]).filter((x) => !x.startsWith("!")), ...always].map(listedPath);
  if (paths.includes(null)) return null;
  return [...(paths as string[]), ...negated.filter((x) => x !== null).map((x) => `!${x}`)];
}

/**
 * This function tells if a file is a part of what a package publishes. `path` is the folder of the package, and the root
 * folder is the empty string. `published` is the result of `publishedPaths`. A listed file counts, and so does the `src`
 * folder of a package that lists the output of a build. With no list, the function reads the name of the file only.
 */
export function isReleased(file: string, path: string, published: readonly string[] | null = null): boolean {
  const prefix = path === "" ? "" : `${path}/`;
  if (!file.startsWith(prefix)) return false;
  const inside = file.slice(prefix.length);
  if (inside === "package.json") return true;
  if (OUTSIDE_FILE.test(inside)) return false;
  const guess = !OUTSIDE_FOLDER.test(inside);
  if (published === null) return guess;
  const under = (x: string): boolean => inside === x || inside.startsWith(`${x}/`);
  if (published.some((x) => x.startsWith("!") && under(x.slice(1)))) return false;
  if (published.some(under)) return true;
  return guess && inside.startsWith("src/") && published.some((x) => BUILD_OUTPUT.test(x));
}

const days = (ms: number): number => Math.round((ms / (24 * 60 * 60 * 1000)) * 10) / 10;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * This function finds each published package whose source on the default branch differs from its latest version. It also
 * finds each open pull request of the train with a failed check. It makes no write.
 *
 * The published commit comes from npm: the provenance of the version, or its `gitHead`. A package with no commit goes to
 * `unread`, and the other packages continue. A merge commit brings older commits of a pull request. So the age of such a
 * change can be more than its time on the default branch.
 */
export async function lagReport(i: LagInput): Promise<LagReport> {
  const f: FetchFn = i.fetch ?? ((u, init) => fetch(u, init));
  const registry = i.registryBase ?? "https://registry.npmjs.org";
  const now = (i.now ?? new Date()).getTime();
  const headers = { "user-agent": "release-train" };
  const log = i.log ?? (() => {});
  const encoded = (name: string): string => name.replaceAll("/", "%2f");
  const slug = (repo: string): string => `/repos/${i.owner}/${repo}`;

  const ids = new Map<string, Promise<string | null>>();
  const repositoryId = (repo: string): Promise<string | null> => {
    let id = ids.get(repo);
    if (id === undefined) {
      id = i.gh.request<{ id: number }>("GET", slug(repo)).then((r) => (r.data ? String(r.data.id) : null));
      ids.set(repo, id);
    }
    return id;
  };

  const commitOf = async (p: PackageNode, version: string): Promise<string | null> => {
    const res = await f(`${registry}/${encoded(p.name)}/${encodeURIComponent(version)}`, { headers });
    if (!res.ok) throw new Error(`npm gave HTTP ${res.status} for ${p.name}@${version}.`);
    const meta = (await res.json()) as PackageVersion;
    if (meta.dist?.attestations) {
      const doc = await f(`${registry}/-/npm/v1/attestations/${encoded(p.name)}@${encodeURIComponent(version)}`, { headers });
      const id = await repositoryId(p.repo);
      if (doc.ok && id !== null) {
        const proven = provenanceCommit((await doc.json()) as Parameters<typeof provenanceCommit>[0], id);
        if (proven !== null) return proven;
      }
    }
    return typeof meta.gitHead === "string" && /^[0-9a-f]{40}$/.test(meta.gitHead) ? meta.gitHead : null;
  };

  // Packages of one repository often share a commit, so each compare and each commit gets one read.
  const compares = new Map<string, Promise<CompareAnswer | null>>();
  const compare = (repo: string, base: string, branch: string): Promise<CompareAnswer | null> => {
    const key = `${repo}:${base}`;
    let c = compares.get(key);
    if (c === undefined) {
      c = i.gh.request<CompareAnswer>("GET", `${slug(repo)}/compare/${base}...${encodeURIComponent(branch)}`).then((r) => r.data);
      compares.set(key, c);
    }
    return c;
  };
  const readManifest = async (repo: string, file: string, ref: string): Promise<Record<string, unknown> | null> => {
    const r = await i.gh.request<{ content?: string }>("GET", `${slug(repo)}/contents/${file}?ref=${encodeURIComponent(ref)}`);
    if (r.data?.content === undefined) return null;
    try {
      return JSON.parse(Buffer.from(r.data.content, "base64").toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const manifestAt = async (repo: string, file: string, ref: string): Promise<string | null> => {
    const m = await readManifest(repo, file, ref);
    return m === null ? null : usedManifest(m);
  };
  const commits = new Map<string, Promise<string[]>>();
  const filesOf = (repo: string, sha: string): Promise<string[]> => {
    let c = commits.get(sha);
    if (c === undefined) {
      c = i.gh
        .request<{ files?: { filename: string }[] }>("GET", `${slug(repo)}/commits/${sha}`)
        .then((r) => (r.data?.files ?? []).map((x) => x.filename));
      commits.set(sha, c);
    }
    return c;
  };

  const unread: LagUnread[] = [];
  const miss = (p: PackageNode, detail: string): null => {
    unread.push({ repo: p.repo, private: p.repoPrivate, package: p.name, detail });
    return null;
  };

  // A busy repository has many commits since a release, and few of them touch one package. So the walk reads the commits
  // of the folder of the package. A failed read gives null, and the walk then reads the commits of the comparison.
  const commitsOfFolder = async (repo: string, path: string, branch: string, base: CommitInfo | undefined): Promise<CommitInfo[] | null> => {
    if (path === "" || base === undefined) return null;
    const query = `path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(base.commit.committer.date)}&per_page=${FOLDER_PAGE}`;
    const r = await i.gh.request<CommitInfo[]>("GET", `${slug(repo)}/commits?${query}`);
    return Array.isArray(r.data) ? r.data.filter((c) => c.sha !== base.sha).reverse() : null;
  };

  const rowOf = async (p: PackageNode): Promise<LagRow | null> => {
    const published = p.npm.latest as string;
    const branch = i.branches.get(p.repo);
    if (branch === undefined) return miss(p, "The run has no default branch of this repository.");
    const commit = await commitOf(p, published);
    if (commit === null) return miss(p, "npm has no provenance of this repository and no gitHead for the latest version.");
    const answer = await compare(p.repo, commit, branch);
    if (answer === null) return miss(p, `GitHub did not compare ${commit} with ${branch}.`);
    if (answer.status === "identical" || answer.status === "behind") return null;
    const listed = answer.files ?? [];
    const manifest = p.path === "" ? "package.json" : `${p.path}/package.json`;
    // A failed read gives no list, so the names of the files decide and a fault gives a row.
    const head = await readManifest(p.repo, manifest, branch);
    const shippedFiles = head === null ? null : publishedPaths(head);
    const source = listed.filter((x) => isReleased(x.filename, p.path, shippedFiles) && x.filename !== manifest);
    // A failed read counts as a change, so a fault gives a row and not a silent pass.
    const newVersion = p.version !== published;
    const manifestListed = listed.some((x) => x.filename === manifest);
    const old = manifestListed && !newVersion ? await manifestAt(p.repo, manifest, commit) : null;
    const movedAt = async (ref: string): Promise<boolean> => {
      if (newVersion) return true;
      const later = old === null ? null : await manifestAt(p.repo, manifest, ref);
      return later === null || later !== old;
    };
    const manifestMoved = newVersion || (manifestListed && (await movedAt(branch)));
    const counts = async (sha: string): Promise<boolean> => {
      const files = (await filesOf(p.repo, sha)).filter((x) => isReleased(x, p.path, shippedFiles));
      if (files.some((x) => x !== manifest)) return true;
      return files.length > 0 && manifestMoved && (await movedAt(sha));
    };
    const changed = source.length + (manifestMoved ? 1 : 0);
    if (changed === 0 && listed.length < COMPARE_FILES) return null;

    const folder = await commitsOfFolder(p.repo, p.path, branch, answer.base_commit);
    const walk = (folder ?? answer.commits ?? []).slice(0, MAX_WALK);
    let first: CommitInfo | undefined;
    let noEffect = 0;
    for (const c of walk) {
      if (NO_EFFECT_COMMIT.test(c.commit.message)) {
        noEffect += 1;
        continue;
      }
      if (await counts(c.sha)) {
        first = c;
        break;
      }
    }
    if (first === undefined && changed === 0) return null;
    // Each commit is read, and the only commits with a change are of a type with no effect.
    const allRead =
      folder !== null
        ? folder.length <= MAX_WALK
        : (answer.commits ?? []).length <= MAX_WALK && (answer.total_commits ?? 0) <= (answer.commits ?? []).length;
    if (first === undefined && allRead && noEffect > 0) return null;
    const partial = first === undefined;
    const shown = first ?? walk[walk.length - 1];
    if (shown === undefined) return miss(p, "GitHub listed changed files with no commit.");
    const at = shown.commit.committer.date;
    const age = now - Date.parse(at);
    return {
      repo: p.repo,
      private: p.repoPrivate,
      package: p.name,
      published,
      onBranch: p.version,
      commit,
      files: changed,
      firstChange: { sha: shown.sha, title: shown.commit.message.split("\n")[0] ?? "", at },
      partial,
      ageDays: days(age),
      reason: p.version === published ? "kept-version" : "release-missing",
      over: age > LAG_LIMIT_MS,
    };
  };

  const published = i.packages.filter((p) => p.npm.exists && p.npm.latest !== null && p.npm.foreign !== true);
  const rows = await pool(published, i.concurrency ?? 6, async (p) => {
    try {
      return await rowOf(p);
    } catch (e) {
      return miss(p, message(e));
    }
  });
  const red = await redRows(i, now, log);
  return {
    owner: i.owner,
    generatedAt: new Date(now).toISOString(),
    packages: published.length,
    rows: rows.filter((r): r is LagRow => r !== null).sort((a, b) => b.ageDays - a.ageDays || a.package.localeCompare(b.package)),
    red: red.sort((a, b) => b.ageDays - a.ageDays),
    unread: unread.sort((a, b) => a.package.localeCompare(b.package)),
  };
}

interface SearchAnswer {
  items?: { number: number; title: string; html_url: string; repository_url: string; private?: boolean }[];
}

interface EventAnswer {
  event?: string;
  created_at?: string;
  label?: { name?: string };
}

interface CheckAnswer {
  check_runs?: { name: string; conclusion: string | null; completed_at: string | null }[];
}

const FAILED: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * This function gives the open pull requests of the train with a failed check on their head. A merge closes such a pull
 * request, so the first block of an open one starts its age. A new head of the train does not reset this age.
 */
async function redRows(i: LagInput, now: number, log: (line: string) => void): Promise<RedRow[]> {
  const out: RedRow[] = [];
  for (const branch of [TRAIN_BRANCH, SYNC_BRANCH]) {
    const q = `user:${i.owner} is:pr is:open head:${branch}${i.publicOnly ? " is:public" : ""}`;
    const found = await i.gh.request<SearchAnswer>("GET", `/search/issues?per_page=100&q=${encodeURIComponent(q)}`);
    if (found.data === null) {
      log(`GitHub did not search the pull requests of ${branch}: ${found.message ?? found.status}`);
      continue;
    }
    const items = found.data.items ?? [];
    const rows = await pool(items, i.concurrency ?? 6, async (item): Promise<RedRow | null> => {
      const repo = item.repository_url.split("/").pop() ?? "";
      const pull = await i.gh.request<{ head?: { sha?: string } }>("GET", `/repos/${i.owner}/${repo}/pulls/${item.number}`);
      const sha = pull.data?.head?.sha;
      if (sha === undefined) return null;
      const checks = await i.gh.request<CheckAnswer>("GET", `/repos/${i.owner}/${repo}/commits/${sha}/check-runs?per_page=100`);
      const failed = (checks.data?.check_runs ?? []).filter((c) => c.conclusion !== null && FAILED.has(c.conclusion));
      if (failed.length === 0) return null;
      const events = await i.gh.request<EventAnswer[]>("GET", `/repos/${i.owner}/${repo}/issues/${item.number}/events?per_page=100`);
      const blocks = (events.data ?? []).filter((e) => e.event === "labeled" && e.label?.name === BLOCKED_LABEL).map((e) => e.created_at);
      const times = [...blocks, ...failed.map((c) => c.completed_at)].filter((t): t is string => typeof t === "string").sort();
      const since = times[0] ?? new Date(now).toISOString();
      const age = now - Date.parse(since);
      return {
        repo,
        private: i.packages.some((p) => p.repo === repo && p.repoPrivate),
        number: item.number,
        url: item.html_url,
        title: item.title,
        checks: [...new Set(failed.map((c) => c.name))],
        since,
        ageDays: days(age),
        over: age > RED_LIMIT_MS,
      };
    });
    out.push(...rows.filter((r): r is RedRow => r !== null));
  }
  return out;
}

/** This function tells if a report has a row over its limit. */
export function lagOver(report: LagReport): boolean {
  return report.rows.some((r) => r.over) || report.red.some((r) => r.over);
}

const WHY: Record<LagReason, string> = {
  "kept-version": "the version did not change, so no release starts",
  "release-missing": "the new version is not on npm",
};

/** This function gives the report as Markdown. */
export function lagSummary(r: LagReport): string {
  const over = r.rows.filter((x) => x.over);
  const watch = r.rows.filter((x) => !x.over);
  const lines = [
    `# Release lag of ${r.owner} at ${r.generatedAt}`,
    "",
    `${r.packages} published packages: ${over.length} over the limit of ${days(LAG_LIMIT_MS)} days, ${watch.length} under it, ${r.unread.length} not read. ${r.red.filter((x) => x.over).length} of ${r.red.length} red train pull requests are over ${days(RED_LIMIT_MS)} day.`,
  ];
  const table = (title: string, rows: readonly LagRow[]): void => {
    if (rows.length === 0) return;
    lines.push("", `## ${title}`, "", "| Package | npm | Branch | Days | Why | First change |", "| --- | --- | --- | --- | --- | --- |");
    for (const x of rows) {
      const age = `${x.partial ? "over " : ""}${x.ageDays}`;
      const title = x.firstChange.title.replaceAll("|", "\\|");
      lines.push(`| ${x.package} | ${x.published} | ${x.onBranch ?? "?"} | ${age} | ${WHY[x.reason]} | ${x.firstChange.sha.slice(0, 7)} ${title} |`);
    }
  };
  table("Over the limit", over);
  table("Under the limit", watch);
  if (r.red.length > 0) {
    lines.push("", "## Red pull requests of the train", "", "| Pull request | Days | Failed checks |", "| --- | --- | --- |");
    for (const x of r.red) lines.push(`| [${x.repo} #${x.number}](${x.url}) | ${x.ageDays} | ${x.checks.join(", ")} |`);
  }
  if (r.unread.length > 0) {
    lines.push("", "## Not read", "");
    for (const x of r.unread) lines.push(`- ${x.package}: ${x.detail}`);
  }
  return lines.join("\n");
}
