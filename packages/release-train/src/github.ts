import { accountOfPath, repositoryIdOf, type Accounts } from "./accounts.ts";
import { nextLink } from "./collect.ts";
import type { FetchFn, PageRead } from "./collect.ts";
import type { GateRecord, GuardRecord } from "./budget.ts";
import { refusalKind } from "./meter.ts";
import type { MeterSample, OutsideUse, RefusalKind, Refusals, RouteCount } from "./meter.ts";

/** The result of one request to the GitHub API. */
export interface GhResponse<T> {
  status: number;
  ok: boolean;
  data: T | null;
  /** The message of an error response, if GitHub gives one. */
  message: string | null;
  /** The URL of the next page, from the `link` header. A client that does not read the header does not give it. */
  next?: string | null;
  /**
   * The cause of a refusal with the status 403 or 429, from `refusalKind`. A different status has no cause. A client that
   * does not read the headers does not give it.
   */
  refusal?: RefusalKind;
}

/** A small client for the REST API and the GraphQL API of GitHub. */
export interface GitHub {
  request<T>(method: string, path: string, body?: unknown): Promise<GhResponse<T>>;
  /** The account is the account of the target. A client of one token does not read it. A client of several accounts takes its token. */
  graphql<T>(query: string, variables: Record<string, unknown>, account?: string): Promise<{ data: T | null; errors: string[] }>;
  /** This function reads a text response, for example the log of a job. A client with no text read does not have it. */
  text?(path: string): Promise<GhResponse<string>>;
}

/** This function makes a GitHub client that uses the given `fetch` function and token. */
export function gitHub(opts: { token: string | null; fetch?: FetchFn; apiBase?: string }): GitHub {
  const f: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const api = opts.apiBase ?? "https://api.github.com";
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "release-train",
      "content-type": "application/json",
    };
    if (opts.token) h["authorization"] = `Bearer ${opts.token}`;
    return h;
  };
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<GhResponse<T>> {
      const init: RequestInit = { method, headers: headers() };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await f(path.startsWith("http") ? path : `${api}${path}`, init);
      const text = res.status === 204 ? "" : await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      const message = !res.ok && data && typeof data === "object" && "message" in data ? String((data as { message: unknown }).message) : null;
      const refusal = refusalKind(res.status, res.headers, message ?? "");
      return { status: res.status, ok: res.ok, data: res.ok ? (data as T) : null, message, next: nextLink(res.headers.get("link")), ...(refusal === null ? {} : { refusal }) };
    },
    async text(path: string): Promise<GhResponse<string>> {
      // GitHub sends a job log as a redirect to a signed URL. The fetch follows it.
      const res = await f(path.startsWith("http") ? path : `${api}${path}`, { method: "GET", headers: { ...headers(), accept: "application/vnd.github+json, text/plain" } });
      const text = await res.text();
      return { status: res.status, ok: res.ok, data: res.ok ? text : null, message: res.ok ? null : text.slice(0, 200) };
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<{ data: T | null; errors: string[] }> {
      const res = await f(`${api}/graphql`, { method: "POST", headers: headers(), body: JSON.stringify({ query, variables }) });
      let doc: { data?: T; errors?: { message?: string }[]; message?: string } = {};
      try {
        doc = (await res.json()) as typeof doc;
      } catch {
        // An empty body gives no data.
      }
      const errors = (doc.errors ?? []).map((e) => e.message ?? "GraphQL error")
        .concat(!res.ok && doc.message ? [doc.message] : []);
      return { data: doc.data ?? null, errors };
    },
  };
}

/**
 * This function makes one client for the accounts of a run. Each request goes to the client of the account of its path
 * (`accountOfPath`). A path with no account, or with an account that has no client, goes to the client of the home account.
 * When an answer links its next page as `/repositories/{id}/...`, the client keeps the account of the id for that page.
 *
 * @param o.home - The home account. Its client must be in `clients`.
 * @param o.clients - The client of each account, by name. A name in a different case is the same account.
 * @param o.ids - The account of each known repository id. The client adds each id that it learns.
 */
export function routedGitHub(o: { home: string; clients: ReadonlyMap<string, GitHub>; ids?: Map<number, string>; apiBase?: string }): GitHub {
  const ids = o.ids ?? new Map<number, string>();
  const byName = new Map([...o.clients].map(([a, c]) => [a.toLowerCase(), { account: a, client: c }]));
  const home = byName.get(o.home.toLowerCase());
  if (home === undefined) throw new Error(`The home account ${o.home} has no client.`);
  const pick = (account: string | null | undefined): { account: string; client: GitHub } => (account ? byName.get(account.toLowerCase()) : undefined) ?? home;
  const ofPath = (path: string): { account: string; client: GitHub } => pick(accountOfPath(path, ids, o.apiBase));
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<GhResponse<T>> {
      const to = ofPath(path);
      const res = await to.client.request<T>(method, path, body);
      const id = repositoryIdOf(res.next);
      if (id !== null) ids.set(id, to.account);
      return res;
    },
    async text(path: string): Promise<GhResponse<string>> {
      const { client } = ofPath(path);
      if (client.text === undefined) return { status: 0, ok: false, data: null, message: "The client has no text read." };
      return client.text(path);
    },
    graphql<T>(query: string, variables: Record<string, unknown>, account?: string): Promise<{ data: T | null; errors: string[] }> {
      return pick(account).client.graphql<T>(query, variables);
    },
  };
}

/**
 * This function makes the clients of the accounts of a run. Each account with a token has its own client, and the home
 * account has a client also with no token.
 *
 * - `gh` is one client for each read of the run (`routedGitHub`).
 * - `of` gives the own client of an account, for the reads with no account in the path. An account with no client gets
 *   the client of the home account.
 */
export function accountsGitHub(accounts: Accounts, opts: { fetch?: FetchFn; apiBase?: string } = {}): { gh: GitHub; of(account: string): GitHub } {
  const clients = new Map<string, GitHub>([[accounts.home, gitHub({ token: accounts.token(accounts.home), ...opts })]]);
  for (const account of accounts.others) {
    const token = accounts.token(account);
    if (token !== null) clients.set(account, gitHub({ token, ...opts }));
  }
  const home = clients.get(accounts.home) as GitHub;
  const byName = new Map([...clients].map(([a, c]) => [a.toLowerCase(), c]));
  return {
    gh: clients.size === 1 ? home : routedGitHub({ home: accounts.home, clients, ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}) }),
    of: (account) => byName.get(account.toLowerCase()) ?? home,
  };
}

/** This function gives the page read of `listRepos` from a client. It throws on an error response. */
export function pageRead(gh: GitHub): PageRead {
  return async <T>(url: string): Promise<{ data: T; next: string | null }> => {
    const res = await gh.request<T>("GET", url);
    if (!res.ok || res.data === null) throw new Error(`GitHub gave HTTP ${res.status} for ${url.split("?")[0] ?? url}.`);
    return { data: res.data, next: res.next ?? null };
  };
}

/** The numbers of one read of the rate limit of the REST API: the requests in one hour. */
export interface RateLimitRead {
  limit: number;
  used: number;
  remaining: number;
  /** The time when the count starts again, as an ISO text. */
  reset: string;
}

/** The reads of the rate limit at the start and at the end of a run. A read that failed is null. */
export interface RateLimitReport {
  start: RateLimitRead | null;
  end: RateLimitRead | null;
  /** The GitHub requests of the run by route, with the largest count first. A route template has no name (meter.ts). */
  routes?: RouteCount[];
  /** The use of the rate limit that the meter did not send (meter.ts). */
  outside?: OutsideUse;
  /** The answers of `core` that the meter read, at most `SAMPLE_MAX` (meter.ts). A route template has no name. */
  samples?: MeterSample[];
  /** The refusals with 403 or 429, by cause (meter.ts). */
  refusals?: Refusals;
  /** The decision of the rate budget at the start of the run (budget.ts). */
  gate?: GateRecord;
  /** The guard of the rate budget during the run: its requests, its wait and its stop (budget.ts). A report from before it does not have it. */
  guard?: GuardRecord;
}

/**
 * This function reads the rate limit of the token of the client with `GET /rate_limit`. GitHub does not count this
 * request. A failed read gives null and does not stop the run.
 */
export async function readRateLimit(gh: GitHub): Promise<RateLimitRead | null> {
  type Core = { limit?: unknown; used?: unknown; remaining?: unknown; reset?: unknown };
  try {
    const res = await gh.request<{ resources?: { core?: Core }; rate?: Core }>("GET", "/rate_limit");
    const core = res.data?.resources?.core ?? res.data?.rate;
    if (!core) return null;
    const { limit, used, remaining, reset } = core;
    if (typeof limit !== "number" || typeof used !== "number" || typeof remaining !== "number" || typeof reset !== "number") return null;
    return { limit, used, remaining, reset: new Date(reset * 1000).toISOString() };
  } catch {
    return null;
  }
}

/** This function gives the summary line of the rate limit of a run. A read that failed shows "no read". */
export function rateLimitLine(r: RateLimitReport): string {
  const last = r.end ?? r.start;
  if (!last) return "GitHub rate limit: no read.";
  const used = (x: RateLimitRead | null): string => (x ? String(x.used) : "no read");
  return `GitHub rate limit: ${last.limit} requests an hour, ${used(r.start)} used at the start, ${used(r.end)} used at the end, ${last.remaining} left, reset at ${last.reset}.`;
}
