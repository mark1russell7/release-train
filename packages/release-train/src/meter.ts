// The meter of the GitHub requests of a run. It counts each request by its route: the method and the path with each
// variable segment replaced. The template holds only the words of the API and the placeholders, so it holds no name of
// a repository, a branch or a file, and the public report can show it.
import type { FetchFn } from "./collect.ts";

/** The base of the REST API of GitHub. */
export const GITHUB_API = "https://api.github.com";

/** The count of the requests of one route. */
export interface RouteCount {
  /** The method and the path template, for example `GET /repos/{owner}/{repo}/pulls/{number}`. */
  route: string;
  /** The count of the requests. It includes the answers 304 and the failures. */
  count: number;
  /** The count of the answers 304: GitHub tells that the cached copy is current. */
  notModified: number;
  /** The count of the failures: an answer with a status of 400 or more, or a fetch that threw. */
  failed: number;
}

/**
 * The words of the paths of the REST API. Each other segment becomes a placeholder. Thus a template holds only these
 * words and the placeholders.
 */
const WORDS: ReadonlySet<string> = new Set([
  "access_tokens",
  "actions",
  "alerts",
  "annotations",
  "app",
  "artifacts",
  "assignees",
  "attempts",
  "attestations",
  "blobs",
  "branches",
  "cancel",
  "check-runs",
  "check-suites",
  "collaborators",
  "comments",
  "commits",
  "compare",
  "contents",
  "dependency-graph",
  "deployments",
  "dispatches",
  "environments",
  "events",
  "files",
  "forks",
  "git",
  "graphql",
  "hooks",
  "installation",
  "installations",
  "issues",
  "jobs",
  "labels",
  "languages",
  "latest",
  "logs",
  "matching-refs",
  "members",
  "merge",
  "merges",
  "milestones",
  "orgs",
  "pages",
  "protection",
  "pulls",
  "rate_limit",
  "readme",
  "ref",
  "refs",
  "releases",
  "repos",
  "repositories",
  "requested_reviewers",
  "rerun",
  "reviews",
  "rules",
  "rulesets",
  "runs",
  "sbom",
  "search",
  "secrets",
  "status",
  "statuses",
  "tags",
  "teams",
  "timeline",
  "topics",
  "trees",
  "update-branch",
  "user",
  "users",
  "variables",
  "workflows",
]);

/** The first words of a path whose next segments are names: the owner and the repository, a user or an organization. */
const HEADS: ReadonlyMap<string, readonly string[]> = new Map([
  ["repos", ["{owner}", "{repo}"]],
  ["users", ["{owner}"]],
  ["orgs", ["{owner}"]],
  ["repositories", ["{number}"]],
]);

/** The words whose next segments are one value, also with slashes: a file path, a git ref or two refs to compare. */
const REST: ReadonlyMap<string, string> = new Map([
  ["contents", "{path}"],
  ["refs", "{ref}"],
  ["ref", "{ref}"],
  ["matching-refs", "{ref}"],
  ["compare", "{basehead}"],
]);

/** The placeholder of a name after a word, when the segment is not a number or a commit hash. */
const NAMED: ReadonlyMap<string, string> = new Map([
  ["commits", "{ref}"],
  ["trees", "{ref}"],
  ["branches", "{branch}"],
  ["workflows", "{workflow}"],
  ["labels", "{name}"],
]);

/** The routes that GitHub does not count in the rate limit. The meter does not count them. */
const FREE: ReadonlySet<string> = new Set(["GET /rate_limit"]);

/** This function gives the placeholder of a segment that is not a word of the API. */
function placeholder(segment: string, after: string | undefined): string {
  if (/^\d+$/.test(segment)) return "{number}";
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(segment)) return "{sha}";
  return (after === undefined ? undefined : NAMED.get(after)) ?? "{name}";
}

/**
 * This function gives the route template of a request to the API, or null for a URL outside the API.
 *
 * - The template has the method and the path. It has no query.
 * - A number becomes `{number}`, and a commit hash becomes `{sha}`.
 * - The owner and the repository become `{owner}` and `{repo}`. A file path, a git ref and a compare become one placeholder, also with slashes.
 * - Each other segment that is not a word of the API becomes a placeholder.
 *
 * @param method - The method of the request. The default of `fetch` is `GET`.
 * @param url - The URL of the request, or a path of the API.
 * @param apiBase - The base of the API. The template does not include the path of the base, for example `/api/v3`.
 */
export function routeTemplate(method: string, url: string, apiBase: string = GITHUB_API): string | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(apiBase);
    target = new URL(url, base);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (prefix !== "" && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return null;
  const segments = target.pathname.slice(prefix.length).split("/").filter((s) => s !== "");
  const out: string[] = [];
  let i = 0;
  const head = segments[0];
  const named = head === undefined ? undefined : HEADS.get(head);
  if (head !== undefined && named !== undefined) {
    out.push(head, ...named.slice(0, segments.length - 1));
    i = 1 + named.length;
  }
  for (; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    const last = out[out.length - 1];
    const rest = last === undefined ? undefined : REST.get(last);
    if (rest !== undefined) {
      out.push(rest);
      break;
    }
    if (WORDS.has(segment)) out.push(segment);
    else out.push(placeholder(segment, last));
  }
  const verb = method.toUpperCase();
  return `${/^[A-Z]+$/.test(verb) ? verb : "OTHER"} /${out.join("/")}`;
}

/**
 * The use of the rate limit that the meter did not send. Another holder of the same installation, or a path of the run
 * with no meter, uses the same budget. On 2026-11-16 a run sent 2,239 requests, but its token used 9,968.
 */
export interface OutsideUse {
  /**
   * The requests that the token used and the meter did not send. In each window, the count is the rise of
   * `x-ratelimit-used` from the first to the last answer. The requests of the meter in the window are not in it.
   */
  requests: number;
  /** The answers with the header `x-ratelimit-used` of the resource `core`. */
  answers: number;
  /** The largest rises between two answers of the meter, minus the one request of the meter, the largest first. */
  jumps: { at: string; size: number }[];
}

/** The smallest rise that the list of jumps shows. A smaller rise can come from requests of the meter that are in flight at the same time. */
export const JUMP_MIN = 20;

/** The largest count of jumps in the record. */
export const JUMP_COUNT = 5;

/** One read of the headers of an answer: the time in ms, the used count and the reset in s. */
interface UsedSample {
  at: number;
  used: number;
  reset: number;
}

/**
 * This function gives the outside use from the samples of the answers. A window of the rate limit ends when the reset
 * moves by more than one minute. The reset of one window can differ by some seconds from one answer to the next.
 */
export function outsideUse(samples: readonly UsedSample[]): OutsideUse {
  const sorted = [...samples].sort((a, b) => a.at - b.at || a.used - b.used);
  const windows: UsedSample[][] = [];
  for (const sample of sorted) {
    const open = windows[windows.length - 1];
    if (open && Math.abs(sample.reset - (open[0]?.reset ?? sample.reset)) <= 60) open.push(sample);
    else windows.push([sample]);
  }
  let requests = 0;
  const jumps: { at: string; size: number }[] = [];
  for (const w of windows) {
    const used = w.map((x) => x.used);
    requests += Math.max(0, Math.max(...used) - Math.min(...used) - (w.length - 1));
    let top = w[0]?.used ?? 0;
    for (const x of w.slice(1)) {
      const size = x.used - top - 1;
      if (size >= JUMP_MIN) jumps.push({ at: new Date(x.at).toISOString(), size });
      top = Math.max(top, x.used);
    }
  }
  jumps.sort((a, b) => b.size - a.size || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { requests, answers: sorted.length, jumps: jumps.slice(0, JUMP_COUNT) };
}

/** This function gives the sample of an answer, or null when the answer has no header of the rate limit of `core`. */
function sampleOf(res: Response, at: number): UsedSample | null {
  const resource = res.headers.get("x-ratelimit-resource");
  if (resource !== null && resource !== "core") return null;
  const used = res.headers.get("x-ratelimit-used");
  const reset = res.headers.get("x-ratelimit-reset");
  if (used === null || reset === null || !/^\d+$/.test(used.trim()) || !/^\d+$/.test(reset.trim())) return null;
  return { at, used: Number(used), reset: Number(reset) };
}

/** A meter of the GitHub requests of a run. */
export interface Meter {
  /** This `fetch` counts each request to the API, and it gives each other request to the inner `fetch` with no count. */
  readonly fetch: FetchFn;
  /** This function gives the count of each route, with the largest count first. */
  routes(): RouteCount[];
  /** This function gives the use of the rate limit that the meter did not send. */
  outside(): OutsideUse;
}

/**
 * This function makes a meter around a `fetch` function. The meter does not count `GET /rate_limit`, because GitHub
 * does not count it. Each try of a retry is a request, so the meter counts it.
 *
 * @param inner - The `fetch` that sends the requests. The default is the global `fetch`.
 * @param apiBase - The base of the API. The meter counts only the requests to this base.
 * @param now - The clock of the samples of the rate limit, in ms. The default is `Date.now`.
 */
export function requestMeter(inner?: FetchFn, apiBase: string = GITHUB_API, now: () => number = Date.now): Meter {
  const send: FetchFn = inner ?? ((u, i) => fetch(u, i));
  const counts = new Map<string, RouteCount>();
  const samples: UsedSample[] = [];
  const add = (route: string, status: number | null): void => {
    const row = counts.get(route) ?? { route, count: 0, notModified: 0, failed: 0 };
    row.count += 1;
    if (status === 304) row.notModified += 1;
    else if (status === null || status >= 400) row.failed += 1;
    counts.set(route, row);
  };
  return {
    fetch: async (url, init) => {
      const route = routeTemplate(init?.method ?? "GET", url, apiBase);
      if (route === null || FREE.has(route)) return send(url, init);
      let res: Response;
      try {
        res = await send(url, init);
      } catch (error) {
        add(route, null);
        throw error;
      }
      add(route, res.status);
      const sample = sampleOf(res, now());
      if (sample) samples.push(sample);
      return res;
    },
    outside: () => outsideUse(samples),
    routes: () =>
      [...counts.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => b.count - a.count || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0)),
  };
}

/** This function gives the line of the summary for the outside use. */
export function outsideLine(o: OutsideUse): string {
  if (o.answers === 0) return "GitHub requests outside the meter: no read (no answer had the header x-ratelimit-used).";
  const jumps = o.jumps.map((j) => `${j.size} at ${j.at.slice(11, 19)}Z`).join(", ");
  return `GitHub requests outside the meter: ${o.requests}, from ${o.answers} answers.${jumps ? ` The largest jumps: ${jumps}.` : ""}`;
}

/** This function gives the lines of the summary for the routes: one line with the totals, and a table with the largest count first. */
export function routeLines(routes: readonly RouteCount[]): string[] {
  if (routes.length === 0) return ["GitHub requests by route: none."];
  const sum = (pick: (r: RouteCount) => number): number => routes.reduce((n, r) => n + pick(r), 0);
  return [
    `GitHub requests by route: ${sum((r) => r.count)} in all, ${sum((r) => r.notModified)} with the answer 304, ${sum((r) => r.failed)} failed.`,
    "",
    "| Route | Requests | 304 | Failed |",
    "| --- | ---: | ---: | ---: |",
    ...routes.map((r) => `| ${r.route} | ${r.count} | ${r.notModified} | ${r.failed} |`),
    "",
  ];
}
