// The rate budget of a run of apply. Before the run reads a repository, the gate compares the requests that are left with
// the requests that a run needs. When too few are left, the run waits for the reset, or it stops with a note. During the
// run, the guard does the same step before each request, on the live budget of the answers (meter.ts).
import { realClock } from "@mark1russell7/service/clock";
import { resetTime, spentLimit, type FetchFn } from "./collect.ts";
import type { RateLimitRead } from "./github.ts";
import { countedRequest, credentialOf, GITHUB_API, RateStop, type RateTracker } from "./meter.ts";

/**
 * The GitHub requests that one run of `apply` needs at its start. On 2026-11-15, 31 runs used 73 to 9,768 requests each.
 * The median was approximately 2,600, and this value is approximately the 90th percentile. Three runs used the full limit
 * of 10,200, and the run after each one failed. A run with the costs of enough full applies in its state uses
 * `needOfRuns` in place of this value. The option `--rate-need` sets a fixed value, and 0 turns off the gate.
 */
export const DEFAULT_NEED = 6000;

/**
 * The part of the hourly limit of each token that the train uses, from 0 to 1. The rest of each window stays for the
 * other users of the token. These are the runs that a release starts, and the one more read of a decision in the mode
 * one-candidate. The gate and the guard count the need of a run against this part. Thus a run goes only when the used
 * requests of the window and its need stay at or below this part of the limit.
 *
 * On 2026-11-21, four runs in one hour used 8,053 of 10,750 requests (0.75). Each run passed the gate, because each one
 * saw enough requests left for its own need. The option `--rate-part` sets a different value, and 1 gives the whole limit
 * to the train.
 */
export const DEFAULT_PART = 0.5;

/**
 * This function gives the reserve: the requests of a window that the train leaves to the other users of the token.
 * The reserve is the limit less `part` of it, rounded down. A part that is not above 0 and at most 1 throws a RangeError.
 */
export function reserveOf(limit: number, part: number): number {
  if (!(part > 0 && part <= 1)) throw new RangeError(`The part of the rate limit must be above 0 and at most 1, not ${part}.`);
  return limit - Math.floor(limit * part);
}

/**
 * The GitHub requests that the train sent in one window of the rate limit of its home token. The state keeps them from
 * one run to the next (state.ts). The runs of the group `train` do not overlap, so the sum of a window is exact.
 */
export interface SpentWindow {
  /** The reset of the window, in seconds after the epoch. */
  reset: number;
  /** The limit of the window. */
  limit: number;
  /** The requests that GitHub counts: each answer but a 304. */
  requests: number;
}

/** The largest difference in seconds of the reset of two reads of one window (as `WINDOW_SLACK_S` of meter.ts). */
export const SPENT_SLACK_S = 60;

/** The largest count of windows that the state keeps. A window stays only until its reset. */
export const SPENT_MAX = 24;

/** This function tells if a kept window and a read of the rate limit are of one window. */
const sameSpent = (w: SpentWindow, reset: number, limit: number): boolean => w.limit === limit && Math.abs(w.reset - reset) <= SPENT_SLACK_S;

/**
 * This function gives the requests that the runs before this run sent in the window of a read, from the windows of the
 * state. It gives null when the state has no windows: then the gate counts all used requests as the use of the train.
 *
 * On 2026-11-24, the run at 18:54Z found 4,246 requests used, and 2,282 of them were of the run at 18:39Z. The gate
 * counted the 4,246 against the part of the train, so the run stopped with 1,154 requests for a need of 2,700.
 */
export function priorUse(spent: readonly SpentWindow[] | undefined, read: Pick<RateLimitRead, "limit" | "reset">): number | null {
  if (spent === undefined) return null;
  const reset = Date.parse(read.reset);
  if (!Number.isFinite(reset)) return null;
  const s = Math.floor(reset / 1000);
  return spent.filter((w) => sameSpent(w, s, read.limit)).reduce((sum, w) => sum + w.requests, 0);
}

/**
 * This function gives the requests of a window that the train can still use.
 *
 * - With no known use of the train (null), each used request counts against the part of the train.
 * - With a known use of the train, only that use counts against the part. The use of the other users counts against
 *   the reserve. When the others use more than the reserve, the rest comes out of the part. Thus the result is the
 *   smaller of the requests left and the part less the use of the train.
 */
export function freeOf(read: Pick<RateLimitRead, "limit" | "used" | "remaining">, reserve: number, trainUsed: number | null): number {
  if (trainUsed === null) return read.remaining - reserve;
  const own = Math.min(read.used, Math.max(0, trainUsed));
  return Math.min(read.remaining, read.limit - reserve - own);
}

/** One answer of the meter, as `spentOfSamples` needs it. */
interface SpentSample {
  used: number;
  remaining?: number | null;
  reset: number;
  status: number;
  token?: number;
}

/**
 * This function gives the windows of the counted requests of one token in the samples of a run. GitHub does not count
 * an answer 304, so the function does not count it either. A sample with no remaining count has no limit, so it is out.
 */
export function spentOfSamples(samples: readonly SpentSample[], token: number): SpentWindow[] {
  const out: SpentWindow[] = [];
  for (const s of samples) {
    if ((s.token ?? 0) !== token || s.status === 304 || s.remaining == null) continue;
    const limit = s.used + s.remaining;
    const known = out.find((w) => sameSpent(w, s.reset, limit));
    if (known) known.requests += 1;
    else out.push({ reset: s.reset, limit, requests: 1 });
  }
  return out;
}

/**
 * This function adds the windows of a run to the windows of the state. It drops each window whose reset is at or before
 * `now` (in milliseconds), and it keeps the last `SPENT_MAX` windows, with the earliest reset first.
 */
export function addSpent(spent: readonly SpentWindow[], run: readonly SpentWindow[], now: number): SpentWindow[] {
  const out = spent.map((w) => ({ ...w }));
  for (const w of run) {
    const known = out.find((k) => sameSpent(k, w.reset, w.limit));
    if (known) known.requests += w.requests;
    else out.push({ ...w });
  }
  return out
    .filter((w) => w.reset * 1000 > now)
    .sort((a, b) => a.reset - b.reset)
    .slice(-SPENT_MAX);
}

/** The count of the last full applies that the state keeps for the need of a run. */
export const COST_RUNS = 20;

/** The fewest full applies for a need from the runs. With fewer, a run needs `DEFAULT_NEED`. */
export const MIN_COST_RUNS = 5;

/** The need of a run and the line of the log that tells its source. */
export interface RunNeed {
  need: number;
  note: string;
}

/**
 * This function gives the need of a run from the GitHub requests of the last full applies, oldest first. The need is the
 * worst run plus the spread of the runs, up to the next 100. Thus the need follows the growth of the train.
 *
 * With fewer than `MIN_COST_RUNS` runs, the need is `DEFAULT_NEED`. On 2026-11-17, 51 full applies used 2,406 to 2,986
 * requests each. The fixed need of 6,000 then stopped the third run of each hour at once.
 */
export function needOfRuns(costs: readonly number[]): RunNeed {
  const last = costs.slice(-COST_RUNS);
  if (last.length < MIN_COST_RUNS) {
    return { need: DEFAULT_NEED, note: `Rate need: ${DEFAULT_NEED}, the default. The state has ${last.length} of the ${MIN_COST_RUNS} full applies that a need from the runs needs.` };
  }
  const worst = Math.max(...last);
  const spread = worst - Math.min(...last);
  const need = Math.ceil((worst + spread) / 100) * 100;
  return { need, note: `Rate need: ${need}, from the last ${last.length} full applies: the worst used ${worst} requests, and the spread is ${spread}.` };
}

/** This function adds the GitHub requests of one full apply to the costs, and keeps the last `COST_RUNS`. */
export function addCost(costs: readonly number[], requests: number): number[] {
  return [...costs, requests].slice(-COST_RUNS);
}

/**
 * The longest wait for the reset of the rate limit, in minutes. The job of `train.yml` stops after 60 minutes. The
 * longest of 60 runs before 2026-11-15 took 31 minutes, with the wait for a release. Thus a wait of 20 minutes and a
 * run of 31 minutes stay below 60 minutes. The option `--rate-wait` sets a different value.
 */
export const DEFAULT_WAIT_MINUTES = 20;

/**
 * The time after the reset before the next read, in milliseconds. The reset is a whole second, and the clock of the
 * runner and the clock of GitHub can differ by some seconds.
 */
export const RESET_MARGIN_MS = 15_000;

/**
 * The result of the gate.
 *
 * - `go`: enough requests are left.
 * - `waited`: the run waited for the reset.
 * - `stop`: the reset comes after the longest wait, so the run stops.
 * - `urgent`: the reset comes after the longest wait, but the run has urgent names, so it continues.
 * - `no read`: the read of the rate limit failed, so the run continues.
 */
export type GateOutcome = "go" | "waited" | "stop" | "urgent" | "no read";

/** The record of the gate in the report. It has no name, so the report stays public. */
export interface GateRecord {
  outcome: GateOutcome;
  /** The requests that the run needs: the setting, but not more than the part of the limit that the train uses. */
  need: number;
  /** The requests that are left at the first read. Null when the read failed. */
  left: number | null;
  /**
   * The requests of the window that the train leaves to the other users of the token ({@link reserveOf}). The gate counts
   * only the requests left above this count. Absent in the reports of the versions before 0.5.0 and when the read failed.
   */
  reserve?: number;
  /**
   * The requests of the window that the runs before this run sent ({@link priorUse}). Absent when the state has no
   * windows, in the reports of the versions before this field, and when the read failed.
   */
  prior?: number;
  /** The reset time of the first read, as an ISO text. Null when the read failed. */
  reset: string | null;
  /** The time of the wait for the reset, in milliseconds. */
  waitedMs: number;
  /** The text of the decision for the log and the summary. */
  note: string;
}

/** The step of the gate for one read: go, wait for a time, or stop. The time is in milliseconds. */
export type BudgetStep = { action: "go" } | { action: "wait"; ms: number } | { action: "stop"; ms: number };

/**
 * This function gives the step of the gate for one read of the rate limit.
 *
 * @param read - The read of the rate limit.
 * @param need - The requests that the run needs. A need above the part of the limit becomes that part. A need of 0 turns
 *   off the gate.
 * @param now - The current time, in milliseconds after the epoch.
 * @param maxWaitMs - The longest wait for the reset, in milliseconds.
 * @param marginMs - The time after the reset before the next read.
 * @param part - The part of the limit that the train uses ({@link DEFAULT_PART}). The default 1 gives the whole limit to the
 *   train. The requests of the reserve ({@link reserveOf}) do not count as left.
 * @param trainUsed - The requests of the window that the runs before this run sent ({@link priorUse}). Null: not known,
 *   so each used request counts against the part ({@link freeOf}).
 */
export function budgetStep(
  read: RateLimitRead,
  need: number,
  now: number,
  maxWaitMs: number,
  marginMs: number = RESET_MARGIN_MS,
  part: number = 1,
  trainUsed: number | null = null,
): BudgetStep {
  if (need <= 0) return { action: "go" };
  const reserve = reserveOf(read.limit, part);
  if (freeOf(read, reserve, trainUsed) >= Math.min(need, read.limit - reserve)) return { action: "go" };
  const untilReset = Math.max(0, Date.parse(read.reset) - now);
  return untilReset <= maxWaitMs ? { action: "wait", ms: untilReset + marginMs } : { action: "stop", ms: untilReset };
}

/** The options of the gate. */
export interface GateOptions {
  /** The requests that the run needs. */
  need: number;
  /** The longest wait for the reset, in milliseconds. */
  maxWaitMs: number;
  /** The time after the reset before the next read. The default is {@link RESET_MARGIN_MS}. */
  marginMs?: number;
  /**
   * The part of the limit that the train uses ({@link DEFAULT_PART}), above 0 and at most 1. The default is 1: the whole
   * limit. With a need of 0, the gate keeps no reserve.
   */
  part?: number;
  /**
   * The windows of the requests that the runs before this run sent with the token of the gate (state.ts). With them,
   * only the use of the train counts against its part ({@link freeOf}). Absent: each used request counts against it.
   */
  spent?: readonly SpentWindow[];
  /** This function reads the rate limit. A failed read gives null. */
  read: () => Promise<RateLimitRead | null>;
  /**
   * The live budget (meter.ts). The gate adds each read to it and decides on its live value. Thus the read is only a
   * first value: a window of the answers with fewer requests left comes first. Without it, the gate decides on the read.
   */
  tracker?: RateTracker;
  /**
   * The credential of the reads (`credentialOf` of meter.ts): the header `authorization` of their client. The gate adds the
   * reads to the windows of this token, and it decides on the live budget of this token. The default is "": no token.
   */
  credential?: string;
  /** This function gives the current time, in milliseconds after the epoch. The default is `Date.now`. Tests give a fake clock. */
  now?: () => number;
  /** This function waits for a time in milliseconds. The default is {@link keepAliveSleep}. Tests give a wait that only moves a fake clock. */
  sleep?: (ms: number) => Promise<void>;
}

/** The result of the gate: the record, and the read of the rate limit that the run starts with. */
export interface GateResult {
  record: GateRecord;
  /** The last read of the gate. After a wait, it is the read after the reset. */
  read: RateLimitRead | null;
}

/**
 * This function waits on a timer of `realClock` of `@mark1russell7/service`. Since 0.9.0, the timer keeps the Node process
 * alive. A timer with `unref` lets Node end the process during the wait with the exit code 0, and the work of the run stops.
 */
export function keepAliveSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realClock.after(ms, resolve);
  });
}

/** This function gives a time in milliseconds as minutes with one decimal. */
const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

/**
 * This function changes a `stop` of the gate to `urgent`. A run with urgent names goes on, because a stop loses the names.
 * Only the title of a run holds them (urgent.ts). A later run does not take the names of a run that passed.
 */
export function goOnUrgent(record: GateRecord): GateRecord {
  const note = `Rate budget: ${record.left ?? "no read of the"} requests are left, and a run needs ${record.need}. The reset at ${record.reset ?? "an unknown time"} comes after the longest wait, but the run has urgent names, so it goes on.`;
  return { ...record, outcome: "urgent", note };
}

/**
 * This function is the gate of the rate budget at the start of a run.
 *
 * - When enough requests are left, the run goes on.
 * - When the reset comes before the longest wait, the gate waits for the reset and a margin. Then it reads the limit again, and the run goes on.
 * - When the reset comes later, the result is `stop`. The caller ends the run with a note and the exit code 0.
 * - When the read fails, the run goes on.
 */
export async function budgetGate(o: GateOptions): Promise<GateResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? keepAliveSleep;
  const first = await o.read();
  if (first === null) {
    return {
      read: null,
      record: { outcome: "no read", need: o.need, left: null, reset: null, waitedMs: 0, note: "Rate budget: the read of the rate limit failed, so the run goes on." },
    };
  }
  const credential = o.credential ?? "";
  o.tracker?.seed(first, credential);
  const basis = o.tracker?.live(now(), credential) ?? first;
  const part = o.part ?? 1;
  const reserve = o.need > 0 ? reserveOf(basis.limit, part) : 0;
  const need = Math.min(o.need, basis.limit - reserve);
  const prior = o.need > 0 ? priorUse(o.spent, basis) : null;
  const step = budgetStep(basis, o.need, now(), o.maxWaitMs, o.marginMs, part, prior);
  const base = { need, left: basis.remaining, reserve, ...(prior !== null ? { prior } : {}), reset: basis.reset };
  const others = prior === null ? 0 : Math.max(0, basis.used - prior);
  const short =
    reserve > 0 && prior !== null
      ? `Rate budget: ${basis.remaining} requests are left. The runs before this run used ${prior} requests of this window, and the other users of the token used ${others}. The train uses the part ${part} of the limit of ${basis.limit}, so ${Math.max(0, freeOf(basis, reserve, prior))} requests are left to the train, and a run needs ${need}.`
      : reserve > 0
        ? `Rate budget: ${basis.remaining} requests are left, ${reserve} of them stay for the other users of the token (the train uses the part ${part} of the limit of ${basis.limit}), and a run needs ${need}.`
        : `Rate budget: ${basis.remaining} requests are left, and a run needs ${need}.`;
  if (step.action === "go") return { read: first, record: { ...base, outcome: "go", waitedMs: 0, note: `${short} The run goes on.` } };
  if (step.action === "stop") {
    const note = `${short} The reset at ${basis.reset} is ${minutes(step.ms)} minutes away, after the longest wait of ${minutes(o.maxWaitMs)} minutes. The run stops, and a later run does the work.`;
    return { read: first, record: { ...base, outcome: "stop", waitedMs: 0, note } };
  }
  await sleep(step.ms);
  const after = await o.read();
  if (after !== null) o.tracker?.seed(after, credential);
  const left = after === null ? "The read after the wait failed" : `Now ${after.remaining} requests are left`;
  const note = `${short} The run waited ${minutes(step.ms)} minutes for the reset at ${basis.reset}. ${left}, and the run goes on.`;
  return { read: after, record: { ...base, outcome: "waited", waitedMs: step.ms, note } };
}

/** The time after the reset before the guard sends a request again, in milliseconds. */
export const RETRY_MARGIN_MS = 5_000;

/** The options of the guard. */
export interface GuardOptions {
  /** The live budget. The meter of the run adds each answer to it (meter.ts). */
  tracker: RateTracker;
  /**
   * The requests that the run needs at its start. Before each request, the requests left to its token must cover the share
   * of the token in this need. The guard takes away the requests that it sent with the token. With 0, only a spent window
   * holds a request.
   */
  need: number;
  /**
   * This function gives the share of the need for a credential (`credentialOf` of meter.ts), from 0 to 1. Each token has a
   * rate limit of its own, so each token needs only its share (`needShares` of accounts.ts). The default gives each token the
   * full need.
   */
  share?: (credential: string) => number;
  /**
   * The part of the limit that the train uses ({@link DEFAULT_PART}), above 0 and at most 1. The default is 1: the whole
   * limit. A token with a share of the need keeps the reserve of its window ({@link reserveOf}), also after the run sent
   * its share. Thus the part is a ceiling of the train in each window. A token with no share keeps no reserve.
   */
  part?: number;
  /**
   * The windows of the requests that the runs before this run sent with the token `home` (state.ts). With them, only the
   * use of the train counts against its part for that token ({@link freeOf}). That use is the runs before and each
   * request that the guard sent with the token. Absent: each used request counts against the part, for each token.
   */
  spent?: readonly SpentWindow[];
  /** The credential of the token of `spent` (`credentialOf` of meter.ts). The default is "": no token. */
  home?: string;
  /** The longest wait for the reset, in milliseconds. */
  maxWaitMs: number;
  /** True when the run waited one time already, at the gate of its start. Then each shortage stops the run. */
  waited?: boolean;
  /** The time after the reset before the next request. The default is {@link RETRY_MARGIN_MS}. */
  marginMs?: number;
  /** The base of the API. The guard checks only the requests that the rate limit counts (`countedRequest`). */
  apiBase?: string;
  /** This function gives the current time, in milliseconds after the epoch. The default is `Date.now`. */
  now?: () => number;
  /** This function waits for a time in milliseconds. The default is {@link keepAliveSleep}. */
  sleep?: (ms: number) => Promise<void>;
  /** This function writes a line of the log: the wait and the stop. */
  log?: (line: string) => void;
}

/** The record of the guard in the report. It has no name, so the report stays public. */
export interface GuardRecord {
  /** The requests that the guard sent to the API, each new try included. */
  sent: number;
  /** The requests that the guard sent again after a refusal. */
  repeats: number;
  /** The time of the waits of the guard, in milliseconds. */
  waitedMs: number;
  /** The text of the stop, or null when the guard did not stop the run. */
  stop: string | null;
}

/** The guard of the rate budget during a run. */
export interface RateGuard {
  /** This `fetch` checks each request that the rate limit counts, and it gives each other request to the inner `fetch`. */
  readonly fetch: FetchFn;
  /** This function gives the stop of the guard, or null. After a stop, each request that the rate limit counts throws it. */
  stopped(): RateStop | null;
  /** This function gives the record of the guard. */
  record(): GuardRecord;
}

/**
 * This function makes the guard of the rate budget around a `fetch` function. It does the step of the gate for each
 * request of the run, on the live budget of the answers.
 *
 * - Before a request, the requests left to its token must cover the share of the token in the need. The guard takes away
 *   the requests that it sent with the token. When too few are left, the guard waits for the reset, or it stops the run.
 * - GitHub can refuse a request with 403 or 429 and `x-ratelimit-remaining: 0`. Then the guard waits for the reset, and
 *   it sends the request again one time.
 * - The guard waits one time in a run, until the reset plus the margin. A second shortage, or a reset after the longest
 *   wait, stops the run at once with a {@link RateStop} that names the reset.
 * - The requests that wait at the same time share the one wait.
 *
 * @param inner - The `fetch` of the meter of the run, so that the meter counts each try and reads each answer.
 */
export function rateGuard(inner: FetchFn, o: GuardOptions): RateGuard {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? keepAliveSleep;
  const margin = o.marginMs ?? RETRY_MARGIN_MS;
  const apiBase = o.apiBase ?? GITHUB_API;
  const log = o.log ?? (() => {});
  const record = { sent: 0, repeats: 0, waitedMs: 0 };
  let waited = o.waited ?? false;
  let pause: Promise<void> | null = null;
  let stop: RateStop | null = null;

  // The first stop stays: each later request throws it, and the log has it one time.
  const halt = (text: string, reset: number): RateStop => {
    if (stop === null) {
      stop = new RateStop(text, new Date(reset).toISOString());
      log(text);
    }
    return stop;
  };
  const halted = (): void => {
    if (stop !== null) throw stop;
  };

  // A shortage until a reset in milliseconds after the epoch. A reset in the past waits only the margin. Else the run
  // waits its one wait, or it stops.
  const shortage = (reset: number, cause: string): Promise<void> => {
    if (stop !== null) return Promise.reject(stop);
    if (pause !== null) return pause;
    const until = reset - now();
    const at = new Date(reset).toISOString();
    if (until <= 0) {
      return sleep(margin).then(() => {
        record.waitedMs += margin;
      });
    }
    if (waited) return Promise.reject(halt(`${cause} The run waited one time already, so it stops at once. The reset is at ${at}, and a later run does the work.`, reset));
    if (until > o.maxWaitMs) {
      return Promise.reject(halt(`${cause} The reset at ${at} is ${minutes(until)} minutes away, after the longest wait of ${minutes(o.maxWaitMs)} minutes. The run stops at once, and a later run does the work.`, reset));
    }
    waited = true;
    const ms = until + margin;
    log(`${cause} The run waits ${minutes(ms)} minutes for the reset at ${at}, one time, and then goes on.`);
    pause = sleep(ms).then(() => {
      record.waitedMs += ms;
      pause = null;
    });
    return pause;
  };

  // The requests that the guard sent with each credential.
  const sentBy = new Map<string, number>();
  const count = (credential: string): void => {
    record.sent += 1;
    sentBy.set(credential, (sentBy.get(credential) ?? 0) + 1);
  };

  // The step of the gate before a request, on the live budget of the token of the request.
  const before = async (credential: string): Promise<void> => {
    halted();
    if (pause !== null) await pause;
    halted();
    const live = o.tracker.live(now(), credential);
    if (live === null) return;
    const share = Math.min(1, Math.max(0, o.share?.(credential) ?? 1));
    const need = Math.ceil(o.need * share);
    const reserve = need > 0 ? reserveOf(live.limit, o.part ?? 1) : 0;
    const sent = sentBy.get(credential) ?? 0;
    const want = Math.max(1, Math.min(need, live.limit - reserve) - sent);
    const prior = o.spent !== undefined && credential === (o.home ?? "") ? priorUse(o.spent, live) : null;
    const trainUsed = prior === null ? null : prior + sent;
    const free = freeOf(live, reserve, trainUsed);
    if (free >= want) return;
    const many = new Set(o.tracker.windows().map((w) => w.token)).size > 1;
    const kept =
      reserve > 0 && trainUsed !== null
        ? `, ${Math.max(0, free)} of them are left to the train`
        : reserve > 0
          ? `, ${reserve} of them stay for the other users of the token`
          : "";
    const cause = many
      ? `Rate guard: ${live.remaining} requests of token ${o.tracker.token(credential)} are left until ${live.reset}${kept}, and its share of the run needs ${want} more.`
      : `Rate guard: ${live.remaining} requests are left until ${live.reset}${kept}, and the run needs ${want} more.`;
    await shortage(Date.parse(live.reset), cause);
  };

  const send: FetchFn = async (url, init) => {
    if (!countedRequest(url, init, apiBase)) return inner(url, init);
    const credential = credentialOf(init);
    await before(credential);
    count(credential);
    const res = await inner(url, init);
    const reset = spentLimit(res) ? resetTime(res.headers) : null;
    if (reset === null) return res;
    await shortage(reset, `Rate guard: GitHub refused a request, because the rate limit is spent until ${new Date(reset).toISOString()}.`);
    await before(credential);
    count(credential);
    record.repeats += 1;
    const again = await inner(url, init);
    const second = spentLimit(again) ? resetTime(again.headers) : null;
    if (second !== null) {
      throw halt(`Rate guard: GitHub refused a request again after the wait. The rate limit is spent until ${new Date(second).toISOString()}. The run stops at once, and a later run does the work.`, second);
    }
    return again;
  };

  return {
    fetch: send,
    stopped: () => stop,
    record: () => ({ ...record, stop: stop === null ? null : stop.message }),
  };
}

/** This function gives the line of the summary for the guard, or null when the guard did not wait and did not stop. */
export function guardLine(g: GuardRecord): string | null {
  if (g.stop !== null) return g.stop;
  if (g.waitedMs === 0) return null;
  const repeats = g.repeats === 1 ? "1 request went" : `${g.repeats} requests went`;
  return `Rate guard: the run waited ${minutes(g.waitedMs)} minutes for a reset, and ${repeats} again after a refusal.`;
}
