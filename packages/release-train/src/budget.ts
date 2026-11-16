// The rate budget of a run of apply. Before the run reads a repository, the gate compares the requests that are left with
// the requests that a run needs. When too few are left, the run waits for the reset, or it stops with a note. During the
// run, the guard does the same step before each request, on the live budget of the answers (meter.ts).
import { realClock } from "@mark1russell7/service/clock";
import { resetTime, spentLimit, type FetchFn } from "./collect.ts";
import type { RateLimitRead } from "./github.ts";
import { countedRequest, GITHUB_API, RateStop, type RateTracker } from "./meter.ts";

/**
 * The GitHub requests that one run of `apply` needs at its start. On 2026-11-15, 31 runs used 73 to 9,768 requests each.
 * The median was approximately 2,600, and this value is approximately the 90th percentile. Three runs used the full limit
 * of 10,200, and the run after each one failed. The option `--rate-need` sets a different value, and 0 turns off the gate.
 */
export const DEFAULT_NEED = 6000;

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
  /** The requests that the run needs: the setting, but not more than the limit of the token. */
  need: number;
  /** The requests that are left at the first read. Null when the read failed. */
  left: number | null;
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
 * @param need - The requests that the run needs. A need above the limit of the token becomes the limit.
 * @param now - The current time, in milliseconds after the epoch.
 * @param maxWaitMs - The longest wait for the reset, in milliseconds.
 * @param marginMs - The time after the reset before the next read.
 */
export function budgetStep(read: RateLimitRead, need: number, now: number, maxWaitMs: number, marginMs: number = RESET_MARGIN_MS): BudgetStep {
  if (read.remaining >= Math.min(need, read.limit)) return { action: "go" };
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
  /** This function reads the rate limit. A failed read gives null. */
  read: () => Promise<RateLimitRead | null>;
  /**
   * The live budget (meter.ts). The gate adds each read to it and decides on its live value. Thus the read is only a
   * first value: a window of the answers with fewer requests left comes first. Without it, the gate decides on the read.
   */
  tracker?: RateTracker;
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
  o.tracker?.seed(first);
  const basis = o.tracker?.live(now()) ?? first;
  const need = Math.min(o.need, basis.limit);
  const step = budgetStep(basis, o.need, now(), o.maxWaitMs, o.marginMs);
  const base = { need, left: basis.remaining, reset: basis.reset };
  const short = `Rate budget: ${basis.remaining} requests are left, and a run needs ${need}.`;
  if (step.action === "go") return { read: first, record: { ...base, outcome: "go", waitedMs: 0, note: `${short} The run goes on.` } };
  if (step.action === "stop") {
    const note = `${short} The reset at ${basis.reset} is ${minutes(step.ms)} minutes away, after the longest wait of ${minutes(o.maxWaitMs)} minutes. The run stops, and a later run does the work.`;
    return { read: first, record: { ...base, outcome: "stop", waitedMs: 0, note } };
  }
  await sleep(step.ms);
  const after = await o.read();
  if (after !== null) o.tracker?.seed(after);
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
   * The requests that the run needs at its start. Before each request, the requests that are left must cover this need
   * minus the requests that the guard sent. With 0, only a spent window holds a request.
   */
  need: number;
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
 * - Before a request, the requests that are left must cover the need minus the requests that the guard sent. When too
 *   few are left, the guard waits for the reset, or it stops the run.
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

  // The step of the gate before a request, on the live budget.
  const before = async (): Promise<void> => {
    halted();
    if (pause !== null) await pause;
    halted();
    const live = o.tracker.live(now());
    if (live === null) return;
    const want = Math.max(1, Math.min(o.need, live.limit) - record.sent);
    if (live.remaining >= want) return;
    await shortage(Date.parse(live.reset), `Rate guard: ${live.remaining} requests are left until ${live.reset}, and the run needs ${want} more.`);
  };

  const send: FetchFn = async (url, init) => {
    if (!countedRequest(url, init, apiBase)) return inner(url, init);
    await before();
    record.sent += 1;
    const res = await inner(url, init);
    const reset = spentLimit(res) ? resetTime(res.headers) : null;
    if (reset === null) return res;
    await shortage(reset, `Rate guard: GitHub refused a request, because the rate limit is spent until ${new Date(reset).toISOString()}.`);
    await before();
    record.sent += 1;
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
