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
