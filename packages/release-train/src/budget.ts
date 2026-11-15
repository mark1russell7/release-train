// The rate budget of a run of apply. Before the run reads a repository, the gate compares the requests that are left with
// the requests that a run needs. When too few are left, the run waits for the reset, or it stops with a note.
import { platformClock } from "@mark1russell7/service/clock";
import type { RateLimitRead } from "./github.ts";

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

/** The clock of the waits. Its timers keep the Node process alive. */
const waitClock = platformClock({ unref: false });

/**
 * This function waits on a timer of `platformClock` of `@mark1russell7/service`. The timer keeps the Node process alive.
 * A timer with `unref` lets Node end the process during the wait with the exit code 0, and the work of the run stops.
 */
export function keepAliveSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    waitClock.after(ms, resolve);
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
  const need = Math.min(o.need, first.limit);
  const step = budgetStep(first, o.need, now(), o.maxWaitMs, o.marginMs);
  const base = { need, left: first.remaining, reset: first.reset };
  const short = `Rate budget: ${first.remaining} requests are left, and a run needs ${need}.`;
  if (step.action === "go") return { read: first, record: { ...base, outcome: "go", waitedMs: 0, note: `${short} The run goes on.` } };
  if (step.action === "stop") {
    const note = `${short} The reset at ${first.reset} is ${minutes(step.ms)} minutes away, after the longest wait of ${minutes(o.maxWaitMs)} minutes. The run stops, and a later run does the work.`;
    return { read: first, record: { ...base, outcome: "stop", waitedMs: 0, note } };
  }
  await sleep(step.ms);
  const after = await o.read();
  const left = after === null ? "The read after the wait failed" : `Now ${after.remaining} requests are left`;
  const note = `${short} The run waited ${minutes(step.ms)} minutes for the reset at ${first.reset}. ${left}, and the run goes on.`;
  return { read: after, record: { ...base, outcome: "waited", waitedMs: step.ms, note } };
}
