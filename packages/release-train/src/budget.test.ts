import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { budgetGate, budgetStep, DEFAULT_NEED, goOnUrgent, RESET_MARGIN_MS } from "./budget.ts";
import type { RateLimitRead } from "./github.ts";
import { UNSETTLED } from "./run-command.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const MINUTE = 60_000;
const MAX_WAIT = 20 * MINUTE;

/** This function gives a read of the rate limit with a reset after the given minutes. */
const readOf = (remaining: number, resetInMinutes: number, limit = 10_200): RateLimitRead => ({
  limit,
  used: limit - remaining,
  remaining,
  reset: new Date(NOW + resetInMinutes * MINUTE).toISOString(),
});

/** A fake time: `sleep` only moves the time and records the wait, so the tests do not wait. */
function fakeTime(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let t = NOW;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

/** This function gives a read function that gives the reads in turn, and counts the reads. */
function reads(...list: (RateLimitRead | null)[]): { read: () => Promise<RateLimitRead | null>; count: () => number } {
  let n = 0;
  return {
    read: async () => list[Math.min(n++, list.length - 1)] ?? null,
    count: () => n,
  };
}

describe("budgetStep", () => {
  it("goes on when enough requests are left", () => {
    expect(budgetStep(readOf(6000, 50), 6000, NOW, MAX_WAIT)).toEqual({ action: "go" });
  });

  it("waits until the reset plus the margin when the reset comes before the longest wait", () => {
    expect(budgetStep(readOf(100, 12), 6000, NOW, MAX_WAIT)).toEqual({ action: "wait", ms: 12 * MINUTE + RESET_MARGIN_MS });
    expect(budgetStep(readOf(100, 20), 6000, NOW, MAX_WAIT, 0)).toEqual({ action: "wait", ms: 20 * MINUTE });
  });

  it("stops when the reset comes after the longest wait", () => {
    expect(budgetStep(readOf(100, 45), 6000, NOW, MAX_WAIT)).toEqual({ action: "stop", ms: 45 * MINUTE });
    expect(budgetStep(readOf(100, 1), 6000, NOW, 0)).toEqual({ action: "stop", ms: MINUTE });
  });

  it("waits only the margin for a reset in the past", () => {
    expect(budgetStep(readOf(0, -2), 6000, NOW, MAX_WAIT)).toEqual({ action: "wait", ms: RESET_MARGIN_MS });
  });

  it("takes the limit of the token as the need when the need is larger, and 0 as no gate", () => {
    expect(budgetStep(readOf(5000, 50, 5000), DEFAULT_NEED, NOW, MAX_WAIT)).toEqual({ action: "go" });
    expect(budgetStep(readOf(4999, 50, 5000), DEFAULT_NEED, NOW, MAX_WAIT)).toEqual({ action: "stop", ms: 50 * MINUTE });
    expect(budgetStep(readOf(0, 50), 0, NOW, MAX_WAIT)).toEqual({ action: "go" });
  });
});

describe("budgetGate", () => {
  it("goes on with no wait and one read when enough requests are left", async () => {
    const time = fakeTime();
    const r = reads(readOf(9000, 30));
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: r.read, now: time.now, sleep: time.sleep });
    expect(time.sleeps).toEqual([]);
    expect(r.count()).toBe(1);
    expect(gate.read?.remaining).toBe(9000);
    expect(gate.record).toMatchObject({ outcome: "go", need: 6000, left: 9000, waitedMs: 0 });
    expect(gate.record.note).toBe("Rate budget: 9000 requests are left, and a run needs 6000. The run goes on.");
  });

  it("waits once until the reset plus the margin, reads again and goes on, when the reset is near", async () => {
    const time = fakeTime();
    const after = { ...readOf(10_200, 60), used: 0 };
    const r = reads(readOf(40, 8), after);
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: r.read, now: time.now, sleep: time.sleep });
    expect(time.sleeps).toEqual([8 * MINUTE + RESET_MARGIN_MS]);
    expect(r.count()).toBe(2);
    expect(gate.read).toEqual(after);
    expect(gate.record).toMatchObject({ outcome: "waited", left: 40, reset: readOf(40, 8).reset, waitedMs: 8 * MINUTE + RESET_MARGIN_MS });
    expect(gate.record.note).toContain("The run waited 8.3 minutes");
    expect(gate.record.note).toContain("Now 10200 requests are left, and the run goes on.");
  });

  it("goes on after the wait also when the second read fails", async () => {
    const time = fakeTime();
    const r = reads(readOf(40, 3), null);
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: r.read, now: time.now, sleep: time.sleep });
    expect(time.sleeps).toHaveLength(1);
    expect(gate.read).toBeNull();
    expect(gate.record.outcome).toBe("waited");
    expect(gate.record.note).toContain("The read after the wait failed, and the run goes on.");
  });

  it("stops with a note and no wait when the reset is far", async () => {
    const time = fakeTime();
    const r = reads(readOf(40, 45));
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: r.read, now: time.now, sleep: time.sleep });
    expect(time.sleeps).toEqual([]);
    expect(r.count()).toBe(1);
    expect(gate.record).toMatchObject({ outcome: "stop", need: 6000, left: 40, waitedMs: 0 });
    expect(gate.record.note).toBe(
      `Rate budget: 40 requests are left, and a run needs 6000. The reset at ${readOf(40, 45).reset} is 45.0 minutes away, after the longest wait of 20.0 minutes. The run stops, and a later run does the work.`,
    );
  });

  it("goes on with no wait when the read fails", async () => {
    const time = fakeTime();
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: reads(null).read, now: time.now, sleep: time.sleep });
    expect(time.sleeps).toEqual([]);
    expect(gate.read).toBeNull();
    expect(gate.record).toMatchObject({ outcome: "no read", left: null, reset: null });
  });

  it("records the need as the limit of the token when the setting is larger", async () => {
    const time = fakeTime();
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: reads(readOf(5000, 30, 5000)).read, now: time.now, sleep: time.sleep });
    expect(gate.record).toMatchObject({ outcome: "go", need: 5000 });
  });
});

describe("goOnUrgent", () => {
  it("changes a stop to urgent with a new note", async () => {
    const time = fakeTime();
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: reads(readOf(40, 45)).read, now: time.now, sleep: time.sleep });
    const urgent = goOnUrgent(gate.record);
    expect(urgent).toMatchObject({ outcome: "urgent", need: 6000, left: 40, waitedMs: 0 });
    expect(urgent.note).toContain("the run has urgent names, so it goes on.");
  });
});

describe("keepAliveSleep", () => {
  const modules = (name: string): string => pathToFileURL(fileURLToPath(new URL(name, import.meta.url))).href;

  it("keeps the Node process alive during the wait, so runCommand gives the code of the command", () => {
    const script = `
      const { runCommand } = await import(${JSON.stringify(modules("./run-command.ts"))});
      const { keepAliveSleep } = await import(${JSON.stringify(modules("./budget.ts"))});
      runCommand(async () => { await keepAliveSleep(200); console.log("after the wait"); return 0; });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
    expect(result.stderr).not.toContain(UNSETTLED);
    expect(result.stdout).toContain("after the wait");
    expect(result.status).toBe(0);
  });
});
