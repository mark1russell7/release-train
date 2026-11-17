import { retry, retryAfterDelay, type Clock } from "@mark1russell7/service";
import type { Backoff } from "@mark1russell7/service/backoff";
import { accountOfPath, repositoryIdOf, runAccounts, type Accounts } from "./accounts.ts";
import { attestationsUrl, workflowProvenance, type Attestations } from "./attest.ts";
import { RateStop } from "./meter.ts";
import { DEP_TYPES } from "./types.ts";
import type { DepType, LockKind, Manifest, ManifestFile, NpmInfo, Provenance, PullVersion, RepoSnapshot } from "./types.ts";
import { manifestWorkspaces, matchWorkspaces, parseNpmLock, parsePnpmLock, parsePnpmWorkspace } from "./parse.ts";
import type { NpmTimes } from "./state.ts";

/** The `fetch` function that the collector uses. Tests give a mock. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** The options of `collect`. */
export interface CollectOptions {
  /** The home account. It owns the npm scope. */
  owner: string;
  /** The token of the home account, or null. */
  token: string | null;
  /**
   * The accounts of the run, with the token of each. The home account of it is `owner`. The default is `owner` with
   * `token` and no other account.
   */
  accounts?: Accounts;
  fetch?: FetchFn;
  /** When this option is true, the collector reads no private repository. */
  publicOnly?: boolean;
  /** This option sets the number of requests at one time. */
  concurrency?: number;
  /** The npm user of the owner. The default is the owner name. */
  npmUser?: string;
  apiBase?: string;
  registryBase?: string;
  log?: (line: string) => void;
  /** The collector gives the list of repositories to this function before it reads them, for example to hide private names. */
  onRepos?: (repos: readonly { name: string; private: boolean }[]) => void;
  /** These options control the retries of the GitHub reads. */
  retry?: RetryOptions;
  /**
   * The publish times of the last run, by npm name. The collector reads the full npm document of a package only when its
   * `modified` time is not the time here. Absent: the collector reads each full document.
   */
  npmTimes?: Readonly<Record<string, NpmTimes>>;
}

/** The options of the retries of a GitHub read. Each time is in milliseconds. */
export interface RetryOptions {
  /** This number is the most tries of one read, the first try included. The default is 4. */
  attempts?: number;
  /** This policy gives the delay before each new try. The default starts at 1 s, doubles, and stops at 15 s, with the full jitter. */
  backoff?: Backoff;
  /**
   * This time is the most wait that a `Retry-After` can ask for. The default is 60 s. A spent primary rate limit gets no
   * new try here: the guard of the run waits one time for its reset (budget.ts).
   */
  maxRetryAfter?: number;
  /** This clock waits between the tries. Tests give a clock that does not wait. */
  clock?: Clock;
  /** This function gives the random numbers of the jitter, from 0 up to 1. */
  random?: () => number;
}

/** The default backoff of the GitHub reads: 1 s, 2 s, 4 s and more, up to 15 s, with the full jitter. */
export const DEFAULT_BACKOFF: Backoff = { base: 1000, factor: 2, cap: 15000, jitter: { kind: "subtract", fraction: 1 } };

/** This function tells if a status can pass with time: 429 (too many requests) and each 5xx status. */
export const retryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** The status and the headers of an HTTP answer. */
export type HttpAnswer = Pick<Response, "status" | "headers">;

/**
 * This function tells if a GitHub answer is a rate limit. GitHub answers a spent rate limit with 403 or 429. A secondary
 * rate limit sends `retry-after`. A spent primary rate limit sends `x-ratelimit-remaining: 0`. A 403 with neither header is
 * a real permission error.
 */
export const rateLimited = (answer: HttpAnswer): boolean =>
  (answer.status === 403 || answer.status === 429) &&
  (answer.headers.has("retry-after") || answer.headers.get("x-ratelimit-remaining")?.trim() === "0");

/** This function tells if a GitHub answer can pass with time: a status of `retryableStatus`, or a rate limit. */
export const retryableAnswer = (answer: HttpAnswer): boolean => retryableStatus(answer.status) || rateLimited(answer);

/**
 * This function tells if a GitHub answer refuses a request because the primary rate limit is spent: 403 or 429 with
 * `x-ratelimit-remaining: 0`. The retries of `collect` do not try it again. The guard of the run waits one time for
 * its reset (budget.ts), because a reset can be up to one hour away.
 */
export const spentLimit = (answer: HttpAnswer): boolean =>
  (answer.status === 403 || answer.status === 429) && answer.headers.get("x-ratelimit-remaining")?.trim() === "0";

/** This function tells if `collect` tries a GitHub read again: an answer of `retryableAnswer`, but not of `spentLimit`. */
const triesAgain = (answer: HttpAnswer): boolean => retryableAnswer(answer) && !spentLimit(answer);

/** This function gives the time of `x-ratelimit-reset` in epoch milliseconds when `x-ratelimit-remaining` is 0, or null. */
export function resetTime(headers: Headers): number | null {
  if (headers.get("x-ratelimit-remaining")?.trim() !== "0") return null;
  const reset = headers.get("x-ratelimit-reset")?.trim() ?? "";
  return /^\d+$/.test(reset) ? Number(reset) * 1000 : null;
}

/**
 * This function gives the wait in milliseconds that a rate limit asks for, or null. The `retry-after` header comes first.
 * Else a spent primary rate limit waits until `x-ratelimit-reset`. A time before `now` gives 0.
 */
export function rateLimitWait(headers: Headers, now: number): number | null {
  const after = retryAfterDelay(headers.get("retry-after"), now);
  if (after !== null) return after;
  const reset = resetTime(headers);
  return reset === null ? null : Math.max(0, reset - now);
}

/** This function gives the cause of a rate limit in plain words, or null for an answer that is not a rate limit. */
export function rateLimitText(answer: HttpAnswer, now: number): string | null {
  if (!rateLimited(answer)) return null;
  const after = retryAfterDelay(answer.headers.get("retry-after"), now);
  if (after !== null) return `the rate limit of GitHub asks for a wait of ${Math.ceil(after / 1000)} s (retry-after)`;
  const reset = resetTime(answer.headers);
  // The text rounds the time up to the next whole minute, so that it does not give a time before the reset.
  if (reset !== null) return `the rate limit of the token is spent until ${new Date(Math.ceil(reset / 60_000) * 60_000).toISOString().slice(11, 16)}Z (x-ratelimit-reset)`;
  return answer.headers.has("retry-after") ? "the rate limit of GitHub asks for a wait (retry-after)" : "the rate limit of the token is spent (x-ratelimit-remaining)";
}

/** This function gives the text of a failed request: the status, the URL, the count of tries and the cause of a rate limit. */
const failureText = (status: number, url: string, tries: number, limit: string | null): string =>
  `HTTP ${status} for ${url}${tries > 1 ? ` after ${tries} tries` : ""}${limit ? `: ${limit}` : ""}`;

/** A GitHub answer that can pass with time. The retries of `retry` catch it. */
class BusyAnswer extends Error {
  readonly response: Response;
  constructor(response: Response, url: string) {
    super(failureText(response.status, url, 1, rateLimitText(response, Date.now())));
    this.response = response;
  }
}

/** This function gives the runtime ranges of one version document of npm. It keeps only the ranges that are strings. */
export function runtimeRanges(doc: Partial<Record<DepType, unknown>> | undefined): Partial<Record<DepType, Record<string, string>>> {
  const out: Partial<Record<DepType, Record<string, string>>> = {};
  for (const t of DEP_TYPES) {
    const section = doc?.[t];
    if (t === "devDependencies" || !section || typeof section !== "object") continue;
    const ranges = Object.entries(section).filter((e): e is [string, string] => typeof e[1] === "string");
    if (ranges.length > 0) out[t] = Object.fromEntries(ranges);
  }
  return out;
}

/**
 * This function gives the version that the diff of a `package.json` sets, or null.
 * It reads the added line of the field `version` at the first level of indentation.
 */
export function patchVersion(patch: string | undefined): string | null {
  const m = /^\+(?:\t| {2}| {4})"version"\s*:\s*"([^"]+)"/m.exec(patch ?? "");
  return m?.[1] ?? null;
}

/** This function gives the folder of a `package.json` path, or null for another file. The root folder is the empty string. */
export function manifestFolder(file: string): string | null {
  if (file === "package.json") return "";
  return file.endsWith("/package.json") ? file.slice(0, -"/package.json".length) : null;
}

/** The data that `collect` gives to the graph builder. */
export interface Collected {
  repos: RepoSnapshot[];
  npm: Record<string, NpmInfo>;
  warnings: string[];
  /** The publish times of each package that npm has, for the `npmTimes` option of the next run. */
  npmTimes?: Record<string, NpmTimes>;
  /** The count of the full npm documents that the collector read. */
  fullReads?: number;
  /** The accounts that the collector did not read, because they have no token. */
  noRead?: string[];
}

export interface GhRepo {
  id?: number;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  default_branch: string;
  owner?: { login?: string };
}

interface TreeEntry {
  path: string;
  type: string;
}

/** This error holds the HTTP status of a failed request. Its text names the cause of a rate limit, from `rateLimitText`. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string, tries = 1, rateLimit: string | null = null) {
    super(failureText(status, url, tries, rateLimit));
    this.status = status;
  }
}

/** This function starts the tasks with a limit on the number of tasks at one time. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * This function gives the URL of the next page from the `link` header of a response, or null.
 * It reads each part with string operations and no regular expression, so its time is linear in the length of the header.
 */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const text = part.trim();
    if (!text.startsWith("<")) continue;
    const end = text.indexOf(">");
    if (end < 2) continue;
    const params = text.slice(end + 1).split(";").map((p) => p.trim());
    if (params.includes('rel="next"')) return text.slice(1, end);
  }
  return null;
}

/** The read of one page of the GitHub API: the data and the URL of the next page. It throws on an error. */
export type PageRead = <T>(url: string) => Promise<{ data: T; next: string | null }>;

/**
 * The kind of a GitHub token, from its prefix. `installation` is a token of a GitHub App installation (`ghs_`), also the
 * token of a workflow. `user` is a token of a person (`ghp_`, `github_pat_`, `gho_`, `ghu_`). `unknown` is another text.
 */
export type TokenKind = "installation" | "user" | "unknown";

/** This function gives the kind of a GitHub token from the prefix that GitHub gives each kind of token. */
export function tokenKind(token: string): TokenKind {
  if (token.startsWith("ghs_")) return "installation";
  return ["ghp_", "github_pat_", "gho_", "ghu_"].some((prefix) => token.startsWith(prefix)) ? "user" : "unknown";
}

/**
 * This function lists the repositories of an owner that a token can read, with no archive and no fork. The prefix of the
 * token gives the list. An installation token reads `/installation/repositories`. The token of the owner reads `/user/repos`.
 * Another token reads the public repositories. An error of the read throws, because a different list is not a correct answer.
 */
export async function listRepos(read: PageRead, opts: { owner: string; token: string | null; publicOnly: boolean }): Promise<GhRepo[]> {
  const paginate = async <T>(first: string): Promise<T[]> => {
    const all: T[] = [];
    let url: string | null = first;
    while (url) {
      const page: { data: T[]; next: string | null } = await read<T[]>(url);
      all.push(...page.data);
      url = page.next;
    }
    return all;
  };
  const installationList = async (): Promise<GhRepo[]> => {
    const all: GhRepo[] = [];
    let url: string | null = "/installation/repositories?per_page=100";
    while (url) {
      const page: { data: { repositories: GhRepo[] }; next: string | null } = await read<{ repositories: GhRepo[] }>(url);
      all.push(...page.data.repositories);
      url = page.next;
    }
    return all;
  };
  const keep = (repos: GhRepo[]): GhRepo[] =>
    repos
      .filter((r) => !r.archived && !r.fork)
      .filter((r) => !(opts.publicOnly && r.private))
      .filter((r) => !r.owner?.login || r.owner.login.toLowerCase() === opts.owner.toLowerCase())
      .sort((a, b) => a.name.localeCompare(b.name));
  const publicList = `/users/${opts.owner}/repos?type=owner&per_page=100`;
  const ownerList = "/user/repos?affiliation=owner&visibility=all&per_page=100";
  if (!opts.token || opts.publicOnly) return keep(await paginate<GhRepo>(publicList));
  const kind = tokenKind(opts.token);
  // The public list has no private repository, so it is not a correct answer for an installation token after a failed read
  if (kind === "installation") return keep(await installationList());
  if (kind === "user") {
    const me = await read<{ login?: string }>("/user");
    return keep(await paginate<GhRepo>(me.data.login?.toLowerCase() === opts.owner.toLowerCase() ? ownerList : publicList));
  }
  // A token with no known prefix, for example an old token of 40 hexadecimal digits: the reads find the kind of the token
  let listUrl = publicList;
  try {
    const me = await read<{ login?: string }>("/user");
    if (me.data.login?.toLowerCase() === opts.owner.toLowerCase()) listUrl = ownerList;
  } catch {
    // A workflow token cannot read /user. The public list is correct for it.
  }
  let listed: GhRepo[] | null = null;
  if (listUrl === publicList) {
    // The token of a GitHub App installation lists its repositories, also the private ones.
    try {
      listed = await installationList();
    } catch {
      // A token that is not of an installation cannot read this list. The public list is correct for it.
    }
  }
  return keep(listed ?? (await paginate<GhRepo>(listUrl)));
}

/** A repository of a list of several accounts, with its account. */
export type AccountRepo = GhRepo & { account: string };

/**
 * This function lists the repositories of each account of a run, with the home account first. It gives the repositories in
 * the order of their names.
 *
 * - An account other than the home account with no token is not read. Its name goes into `noRead`, and the log tells it.
 *   The other accounts stay in the list. With `publicOnly`, the account takes the home token, because a public list
 *   needs no token of the account.
 * - A repository name in two accounts throws an error. The train keys each repository by its name.
 *
 * @param readOf - This function gives the page read of an account, with the token of that account.
 */
export async function listAccounts(
  accounts: Accounts,
  readOf: (account: string) => PageRead,
  opts: { publicOnly: boolean; log?: (line: string) => void },
): Promise<{ repos: AccountRepo[]; noRead: string[] }> {
  const homeToken = accounts.token(accounts.home);
  const noRead: string[] = [];
  const byName = new Map<string, AccountRepo>();
  for (const account of [accounts.home, ...accounts.others]) {
    const own = accounts.token(account);
    const token = own ?? (opts.publicOnly ? homeToken : null);
    if (account !== accounts.home && own === null && !opts.publicOnly) {
      noRead.push(account);
      opts.log?.(`The account ${account} has no token in GH_TOKENS, so the run does not read its repositories: no read.`);
      continue;
    }
    for (const r of await listRepos(readOf(account), { owner: account, token, publicOnly: opts.publicOnly })) {
      const key = r.name.toLowerCase();
      const other = byName.get(key);
      if (other !== undefined) {
        throw new Error(`The repository name ${r.name} is in the accounts ${other.account} and ${account}. The train keys each repository by its name, so each name must be in one account only.`);
      }
      byName.set(key, { ...r, account: r.owner?.login ?? account });
    }
  }
  return { repos: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), noRead };
}

/** This function reads the repositories, the manifests, the lockfiles and the npm state of one owner. */
export async function collect(opts: CollectOptions): Promise<Collected> {
  const f: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const api = opts.apiBase ?? "https://api.github.com";
  const registry = opts.registryBase ?? "https://registry.npmjs.org";
  const limit = opts.concurrency ?? 6;
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];
  // Only the GitHub reads get the retries. A failed npm read is a warning already.
  const attempts = Math.max(1, Math.floor(opts.retry?.attempts ?? 4));
  const maxAfter = opts.retry?.maxRetryAfter ?? 60_000;
  // retry of @mark1russell7/service makes the tries. A 429, a 5xx or a 403 with `retry-after` throws BusyAnswer, so that it
  // gets a new try. A 403 with no rate limit is a real permission error, so it gets no new try. A spent primary rate limit
  // gets no new try here (spentLimit). A stop of the guard of the run (RateStop) gets no new try. After the last try, the
  // read gives the last answer, and the caller throws HttpError with the count of tries.
  const gh: FetchFn = (url, init) =>
    retry(
      async () => {
        const res = await f(url, init);
        if (triesAgain(res)) throw new BusyAnswer(res, url);
        return res;
      },
      {
        ...(opts.retry?.backoff ?? DEFAULT_BACKOFF),
        tries: attempts,
        retryable: (error) => !(error instanceof RateStop),
        ...(opts.retry?.clock ? { clock: opts.retry.clock } : {}),
        ...(opts.retry?.random ? { random: opts.retry.random } : {}),
        delayOf: (error, attempt) => {
          log(`retry ${attempt} of ${attempts - 1}: ${error instanceof Error ? error.message : String(error)}${error instanceof BusyAnswer ? "" : ` for ${url}`}`);
          // A 5xx and a 429 with no rate limit header wait for the backoff. A `retry-after` waits for its seconds, up to the cap.
          if (!(error instanceof BusyAnswer) || (error.response.status !== 429 && error.response.status !== 403)) return null;
          const wait = rateLimitWait(error.response.headers, Date.now());
          return wait === null ? null : Math.min(wait, maxAfter);
        },
      },
    ).then(
      (res) => res,
      async (error: unknown) => {
        if (!(error instanceof BusyAnswer)) throw error;
        return error.response;
      },
    );
  const failure = (res: Response, url: string): HttpError =>
    new HttpError(res.status, url, triesAgain(res) ? attempts : 1, rateLimitText(res, Date.now()));

  // Each read takes the token of its account. A read of an account with no token takes the home token in a public run.
  const accounts = opts.accounts ?? runAccounts(opts.owner, opts.token ?? null);
  const publicOnly = opts.publicOnly ?? false;
  const homeToken = accounts.token(accounts.home);
  const tokenOf = (account: string): string | null => accounts.token(account) ?? (publicOnly ? homeToken : null);
  const ids = new Map<number, string>();
  const ghHeaders = (accept: string, account: string): Record<string, string> => {
    const h: Record<string, string> = { accept, "x-github-api-version": "2022-11-28", "user-agent": "release-train" };
    const token = tokenOf(account);
    if (token) h["authorization"] = `Bearer ${token}`;
    return h;
  };

  const ghJson = async <T>(url: string, account?: string): Promise<{ data: T; next: string | null }> => {
    const as = account ?? accountOfPath(url, ids, api) ?? accounts.home;
    const res = await gh(url.startsWith("http") ? url : `${api}${url}`, { headers: ghHeaders("application/vnd.github+json", as) });
    if (!res.ok) throw failure(res, url);
    const next = nextLink(res.headers.get("link"));
    const id = repositoryIdOf(next);
    if (id !== null) ids.set(id, as);
    return { data: (await res.json()) as T, next };
  };

  // The account of each repository of the list. The list sets it before the first read of a repository.
  const accountOf = new Map<string, string>();
  const slug = (repo: string): string => `${accountOf.get(repo) ?? accounts.home}/${repo}`;

  const ghRaw = async (repo: string, path: string, ref: string): Promise<string | null> => {
    const url = `${api}/repos/${slug(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const res = await gh(url, { headers: ghHeaders("application/vnd.github.raw", accountOf.get(repo) ?? accounts.home) });
    if (res.status === 404) return null;
    if (!res.ok) throw failure(res, url);
    return res.text();
  };

  const paginate = async <T>(first: string): Promise<T[]> => {
    const all: T[] = [];
    let url: string | null = first;
    while (url) {
      const page: { data: T[]; next: string | null } = await ghJson<T[]>(url);
      all.push(...page.data);
      url = page.next;
    }
    return all;
  };

  const listed = await listAccounts(accounts, (account) => <T,>(url: string) => ghJson<T>(url, account), { publicOnly, log });
  const ghRepos = listed.repos;
  for (const r of ghRepos) accountOf.set(r.name, r.account);
  opts.onRepos?.(ghRepos.map((r) => ({ name: r.name, private: r.private })));
  log(`repositories: ${ghRepos.length}${listed.noRead.length > 0 ? `, no read of the accounts ${listed.noRead.join(", ")}` : ""}`);

  // Phase 1: the manifests of each repository.
  interface Partial1 {
    snap: RepoSnapshot;
    lockPath: string | null;
  }
  const phase1 = await pool(ghRepos, limit, async (r): Promise<Partial1 | null> => {
    const snap: RepoSnapshot = {
      name: r.name,
      account: r.account,
      private: r.private,
      defaultBranch: r.default_branch,
      manifests: [],
      lockKind: "none",
      resolved: {},
      warnings: [],
    };
    let tree: { tree: TreeEntry[]; truncated?: boolean };
    try {
      tree = (await ghJson<{ tree: TreeEntry[]; truncated?: boolean }>(
        `/repos/${slug(r.name)}/git/trees/${encodeURIComponent(r.default_branch)}?recursive=1`,
      )).data;
    } catch (e) {
      // An empty repository gives HTTP 409.
      if (e instanceof HttpError && (e.status === 409 || e.status === 404)) return null;
      throw e;
    }
    if (tree.truncated) snap.warnings.push("The git tree is too large. GitHub gave only a part of it.");
    const blobs = new Set(tree.tree.filter((t) => t.type === "blob").map((t) => t.path));
    if (!blobs.has("package.json")) return null;
    const rootText = await ghRaw(r.name, "package.json", r.default_branch);
    if (rootText === null) return null;
    let root: Manifest;
    try {
      root = JSON.parse(rootText) as Manifest;
    } catch {
      snap.warnings.push("The root package.json is not valid JSON.");
      return { snap, lockPath: null };
    }
    snap.manifests.push({ path: "", manifest: root });
    snap.packageManager = typeof root.packageManager === "string" ? root.packageManager : null;
    snap.pnpmWorkspace = null;

    let globs: string[] = manifestWorkspaces(root);
    if (blobs.has("pnpm-workspace.yaml")) {
      const ws = await ghRaw(r.name, "pnpm-workspace.yaml", r.default_branch);
      snap.pnpmWorkspace = ws;
      if (ws) globs = [...globs, ...parsePnpmWorkspace(ws)];
    }
    if (globs.length > 0) {
      const dirs = [...blobs]
        .filter((p) => p.endsWith("/package.json"))
        .map((p) => p.slice(0, -"/package.json".length));
      const wsDirs = matchWorkspaces(globs, dirs);
      // A submodule is an entry of type "commit" in the tree
      const links = matchWorkspaces(globs, tree.tree.filter((t) => t.type === "commit").map((t) => t.path));
      if (links.length > 0) snap.submodules = links;
      const files = await pool(wsDirs, limit, async (d): Promise<ManifestFile | null> => {
        const text = await ghRaw(r.name, `${d}/package.json`, r.default_branch);
        if (text === null) return null;
        try {
          return { path: d, manifest: JSON.parse(text) as Manifest };
        } catch {
          snap.warnings.push(`${d}/package.json is not valid JSON.`);
          return null;
        }
      });
      for (const m of files) if (m) snap.manifests.push(m);
    }

    let lockKind: LockKind = "none";
    let lockPath: string | null = null;
    if (blobs.has("pnpm-lock.yaml")) [lockKind, lockPath] = ["pnpm", "pnpm-lock.yaml"];
    else if (blobs.has("package-lock.json")) [lockKind, lockPath] = ["npm", "package-lock.json"];
    else if (blobs.has("yarn.lock")) lockKind = "yarn";
    snap.lockKind = lockKind;
    snap.pendingChangesets = [...blobs].filter((b) => b.startsWith(".changeset/") && b.endsWith(".md") && b !== ".changeset/README.md").length;
    return { snap, lockPath };
  });
  const snaps = phase1.filter((p): p is Partial1 => p !== null);

  // The names of the packages of the owner.
  const owned = new Set<string>();
  for (const { snap } of snaps) {
    for (const { manifest: m } of snap.manifests) if (m.name && m.private !== true) owned.add(m.name);
  }

  // Phase 2: the lockfiles, only for a repository that depends on a package of the owner.
  await pool(snaps, limit, async ({ snap, lockPath }) => {
    if (!lockPath) return;
    const used = new Set<string>();
    for (const { manifest: m } of snap.manifests) {
      for (const t of DEP_TYPES) for (const n of Object.keys(m[t] ?? {})) if (owned.has(n)) used.add(n);
    }
    if (used.size === 0) return;
    const text = await ghRaw(snap.name, lockPath, snap.defaultBranch);
    if (text === null) return;
    try {
      snap.resolved =
        snap.lockKind === "pnpm"
          ? parsePnpmLock(text)
          : parseNpmLock(text, snap.manifests.map((m) => m.path), [...used]);
    } catch {
      snap.warnings.push(`${lockPath} could not be read.`);
    }
  });

  // Phase 2b: the versions that the open pull requests set, so that the plan finds two pull requests with one version.
  await pool(snaps, limit, async ({ snap }) => {
    const folders = new Set(snap.manifests.filter((m) => typeof m.manifest.version === "string").map((m) => m.path));
    if (folders.size === 0) return;
    try {
      const open = await paginate<{ number: number }>(`/repos/${slug(snap.name)}/pulls?state=open&per_page=100`);
      const found: PullVersion[] = [];
      for (const pr of open) {
        const files = await paginate<{ filename: string; patch?: string }>(`/repos/${slug(snap.name)}/pulls/${pr.number}/files?per_page=100`);
        for (const file of files) {
          const path = manifestFolder(file.filename);
          const version = path !== null && folders.has(path) ? patchVersion(file.patch) : null;
          if (path !== null && version) found.push({ number: pr.number, path, version });
        }
      }
      snap.pulls = found;
    } catch (e) {
      snap.warnings.push(`The open pull requests could not be read: ${e instanceof Error ? e.message : String(e)}.`);
    }
  });

  // A package is foreign when its npm repository is not of an account of the run and no maintainer is the owner.
  const npmUser = (opts.npmUser ?? opts.owner).toLowerCase();
  const own = [accounts.home, ...accounts.others].map((a) => a.toLowerCase());
  const isForeign = async (n: string, version: string): Promise<boolean> => {
    const res = await f(`${registry}/${n.replaceAll("/", "%2f")}/${encodeURIComponent(version)}`, { headers: { "user-agent": "release-train" } });
    if (!res.ok) return false;
    const m = (await res.json()) as { repository?: string | { url?: string }; maintainers?: { name?: string }[] };
    const repoUrl = (typeof m.repository === "string" ? m.repository : (m.repository?.url ?? "")).toLowerCase();
    const ownRepo = own.some((a) => repoUrl.includes(`github.com/${a}/`) || repoUrl.startsWith(`github:${a}/`) || repoUrl.startsWith(`${a}/`));
    const ownMaint = (m.maintainers ?? []).some((x) => x.name?.toLowerCase() === npmUser);
    return !ownRepo && !ownMaint;
  };

  // The provenance of a version: the workflow of its SLSA attestation. null when npm has no attestation of it.
  const provenanceOf = async (n: string, version: string): Promise<Provenance | null> => {
    const res = await f(attestationsUrl(registry, n, version), { headers: { "user-agent": "release-train" } });
    if (!res.ok) return null;
    return workflowProvenance((await res.json()) as Attestations);
  };

  // The publish times of a package. The abbreviated document has no times, so a changed package costs one full read.
  const npmTimes: Record<string, NpmTimes> = {};
  let fullReads = 0;
  const timesOf = async (n: string, url: string, modified: string | null): Promise<Record<string, string> | undefined> => {
    const known = modified === null ? undefined : opts.npmTimes?.[n];
    if (known !== undefined && known.modified === modified) {
      npmTimes[n] = known;
      return Object.keys(known.times).length > 0 ? known.times : undefined;
    }
    fullReads++;
    const res = await f(url, { headers: { accept: "application/json", "user-agent": "release-train" } });
    if (!res.ok) {
      warnings.push(`npm gave HTTP ${res.status} for the full document of ${n}.`);
      return undefined;
    }
    const time = ((await res.json()) as { time?: Record<string, unknown> }).time ?? {};
    const times = Object.fromEntries(Object.entries(time).filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "created" && e[0] !== "modified"));
    if (modified !== null) npmTimes[n] = { modified, times };
    return Object.keys(times).length > 0 ? times : undefined;
  };

  // Phase 3: the npm state of each package.
  const names = [...owned].sort();
  const infos = await pool(names, limit, async (n): Promise<[string, NpmInfo]> => {
    const url = `${registry}/${n.replaceAll("/", "%2f")}`;
    const res = await f(url, { headers: { accept: "application/vnd.npm.install-v1+json", "user-agent": "release-train" } });
    if (res.status === 404) return [n, { exists: false, latest: null }];
    if (!res.ok) {
      warnings.push(`npm gave HTTP ${res.status} for ${n}.`);
      return [n, { exists: true, latest: null }];
    }
    const doc = (await res.json()) as { "dist-tags"?: Record<string, string>; modified?: unknown; versions?: Record<string, Partial<Record<DepType, unknown>>> };
    const latest = doc["dist-tags"]?.["latest"] ?? null;
    const foreign = latest ? await isForeign(n, latest) : false;
    const known = doc.versions && typeof doc.versions === "object" ? { versions: Object.keys(doc.versions).sort(), latestDeps: runtimeRanges(latest ? doc.versions[latest] : undefined) } : {};
    const times = await timesOf(n, url, typeof doc.modified === "string" ? doc.modified : null);
    return [n, { exists: true, latest, foreign, ...known, ...(latest && !foreign ? { provenance: await provenanceOf(n, latest) } : {}), ...(times ? { times } : {}) }];
  });
  log(`packages: ${names.length}, full npm documents read: ${fullReads}`);
  return { repos: snaps.map((s) => s.snap), npm: Object.fromEntries(infos), warnings, npmTimes, fullReads, noRead: listed.noRead };
}
