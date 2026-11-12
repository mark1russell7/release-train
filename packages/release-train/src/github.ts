import type { FetchFn } from "./collect.ts";

/** The result of one request to the GitHub API. */
export interface GhResponse<T> {
  status: number;
  ok: boolean;
  data: T | null;
  /** The message of an error response, if GitHub gives one. */
  message: string | null;
}

/** A small client for the REST API and the GraphQL API of GitHub. */
export interface GitHub {
  request<T>(method: string, path: string, body?: unknown): Promise<GhResponse<T>>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<{ data: T | null; errors: string[] }>;
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
      return { status: res.status, ok: res.ok, data: res.ok ? (data as T) : null, message };
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
