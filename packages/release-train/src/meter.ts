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
 * One answer of the resource `core`, as the report keeps it. On 2026-11-16 the samples gave no outside use, but the two
 * reads of `GET /rate_limit` gave 7,971 (Train 43805901480). The samples let a reader find which measure is wrong.
 */
export interface MeterSample extends UsedSample {
  /** The value of `x-ratelimit-remaining`, or null when the answer does not have it. */
  remaining: number | null;
  /** The status of the answer. */
  status: number;
  /** The route template of the request. It holds no name. */
  route: string;
}

/** The largest count of samples that a meter keeps. A run that has more keeps the first ones and counts the others. */
export const SAMPLE_MAX = 12_000;

/** The answers that refused a request with the status 403 or 429, by cause. */
export interface Refusals {
  /** A spent primary rate limit: `x-ratelimit-remaining: 0`, or a message of a spent rate limit. */
  primary: number;
  /** A secondary rate limit: `retry-after`, or a message that names a secondary rate limit. */
  secondary: number;
  /** A refusal with no sign of a rate limit, for example a permission error. */
  other: number;
  /** The time of the first refusal for a rate limit, primary or secondary, or null. */
  first: string | null;
}

/** The cause of a refusal. */
export type RefusalKind = "primary" | "secondary" | "other";

/**
 * This function gives the cause of a refusal from the status, the headers and the message of the answer, or null for an
 * answer that is not a refusal. GitHub can send a secondary rate limit as a 403 with no `retry-after`. Only its message
 * tells it from a permission error.
 */
export function refusalKind(status: number, headers: Headers, message: string): RefusalKind | null {
  if (status !== 403 && status !== 429) return null;
  if (headers.get("x-ratelimit-remaining")?.trim() === "0") return "primary";
  if (headers.has("retry-after") || /secondary rate limit/i.test(message)) return "secondary";
  if (/rate limit/i.test(message)) return "primary";
  return "other";
}

/**
 * This function gives the outside use from the samples of the answers. A window of the rate limit holds the samples
 * whose reset is in one minute of the reset of the window. The reset of one window can differ by some seconds from one
 * answer to the next. A sample goes to its window also when the samples of two windows alternate.
 */
export function outsideUse(samples: readonly UsedSample[]): OutsideUse {
  const sorted = [...samples].sort((a, b) => a.at - b.at || a.used - b.used);
  const windows: UsedSample[][] = [];
  for (const sample of sorted) {
    const open = windows.find((w) => Math.abs(sample.reset - (w[0]?.reset ?? sample.reset)) <= 60);
    if (open) open.push(sample);
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
function sampleOf(res: Response, at: number, route: string): MeterSample | null {
  const resource = res.headers.get("x-ratelimit-resource");
  if (resource !== null && resource !== "core") return null;
  const used = res.headers.get("x-ratelimit-used");
  const reset = res.headers.get("x-ratelimit-reset");
  if (used === null || reset === null || !/^\d+$/.test(used.trim()) || !/^\d+$/.test(reset.trim())) return null;
  const left = res.headers.get("x-ratelimit-remaining")?.trim() ?? "";
  return { at, used: Number(used), reset: Number(reset), remaining: /^\d+$/.test(left) ? Number(left) : null, status: res.status, route };
}

/** This function gives the message of a refusal from a copy of the answer, so the caller can still read the body. */
async function refusalMessage(res: Response): Promise<string> {
  if (typeof res.clone !== "function") return "";
  try {
    return (await res.clone().text()).slice(0, 500);
  } catch {
    return "";
  }
}

/** A meter of the GitHub requests of a run. */
export interface Meter {
  /** This `fetch` counts each request to the API, and it gives each other request to the inner `fetch` with no count. */
  readonly fetch: FetchFn;
  /** This function gives the count of each route, with the largest count first. */
  routes(): RouteCount[];
  /** This function gives the use of the rate limit that the meter did not send. */
  outside(): OutsideUse;
  /** This function gives the samples of the answers of `core`, in the order of the answers, at most `SAMPLE_MAX`. */
  samples(): MeterSample[];
  /** This function gives the refusals by cause. */
  refusals(): Refusals;
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
  const samples: MeterSample[] = [];
  const refusals: Refusals = { primary: 0, secondary: 0, other: 0, first: null };
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
      const at = now();
      const sample = sampleOf(res, at, route);
      if (sample && samples.length < SAMPLE_MAX) samples.push(sample);
      if (res.status === 403 || res.status === 429) {
        const kind = refusalKind(res.status, res.headers, await refusalMessage(res));
        if (kind) refusals[kind] += 1;
        if (kind !== "other" && refusals.first === null) refusals.first = new Date(at).toISOString();
      }
      return res;
    },
    outside: () => outsideUse(samples),
    samples: () => samples.map((s) => ({ ...s })),
    refusals: () => ({ ...refusals }),
    routes: () =>
      [...counts.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => b.count - a.count || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0)),
  };
}

/** One read of `GET /rate_limit`: the used count and the time of the reset as an ISO text. */
interface UsedRead {
  used: number;
  reset: string;
}

/**
 * This function gives the outside use from the two reads of `GET /rate_limit` at the start and at the end of a run: the
 * rise of the used count, minus each request of the meter that GitHub counts (each request but an answer 304). It gives
 * null when a read failed or when the window of the rate limit changed between the two reads. The value can be below 0.
 */
export function readsOutside(start: UsedRead | null | undefined, end: UsedRead | null | undefined, routes: readonly RouteCount[]): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start.reset);
  const b = Date.parse(end.reset);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > 60_000) return null;
  return end.used - start.used - routes.reduce((n, r) => n + r.count - r.notModified, 0);
}

/** The smallest difference of the two measures that the line calls a disagreement, also when 5 % of the larger is less. */
export const DISAGREE_MIN = 50;

/**
 * This function gives the line of the summary for the outside use. With the measure of the two reads (`readsOutside`),
 * the line gives both measures, and it tells when they disagree. Then the count of the samples is not a read.
 */
export function outsideLine(o: OutsideUse, reads: number | null = null): string {
  const fromReads = reads === null ? "" : ` The two reads of GET /rate_limit give ${reads}.`;
  if (o.answers === 0) return `GitHub requests outside the meter: no read from the answers (no answer had the header x-ratelimit-used).${fromReads}`;
  const jumps = o.jumps.map((j) => `${j.size} at ${j.at.slice(11, 19)}Z`).join(", ");
  const disagree =
    reads !== null && Math.abs(reads - o.requests) > Math.max(DISAGREE_MIN, 0.05 * Math.max(Math.abs(reads), o.requests))
      ? " The two measures disagree, so neither count is a read. The report has each sample (rateLimit.samples)."
      : "";
  return `GitHub requests outside the meter: ${o.requests}, from ${o.answers} answers.${jumps ? ` The largest jumps: ${jumps}.` : ""}${fromReads}${disagree}`;
}

/** This function gives the line of the summary for the refusals, or null when GitHub refused no request. */
export function refusalLine(r: Refusals): string | null {
  const all = r.primary + r.secondary + r.other;
  if (all === 0) return null;
  const first = r.first ? ` The first refusal for a rate limit came at ${r.first.slice(11, 19)}Z.` : "";
  return `GitHub refused ${all} requests with 403 or 429: ${r.primary} for a spent rate limit, ${r.secondary} for a secondary rate limit, ${r.other} with no sign of a rate limit.${first}`;
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
