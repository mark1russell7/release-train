import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { addCost, budgetGate, budgetStep, COST_RUNS, DEFAULT_NEED, DEFAULT_PART, goOnUrgent, guardLine, MIN_COST_RUNS, needOfRuns, RESET_MARGIN_MS, RETRY_MARGIN_MS, rateGuard, reserveOf } from "./budget.ts";
import type { FetchFn } from "./collect.ts";
import type { RateLimitRead } from "./github.ts";
import { credentialOf, RateStop, rateTracker, requestMeter } from "./meter.ts";
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

describe("the part of the limit that the train uses", () => {
  it("leaves the limit less the part, rounded down, and refuses a part that is not above 0 and at most 1", () => {
    expect(DEFAULT_PART).toBe(0.5);
    expect(reserveOf(10_750, 0.5)).toBe(5375);
    expect(reserveOf(10_201, 0.5)).toBe(5101);
    expect(reserveOf(10_200, 1)).toBe(0);
    for (const part of [0, -0.5, 1.5, Number.NaN]) expect(() => reserveOf(10_200, part)).toThrow(RangeError);
  });

  it("counts only the requests above the reserve as left, and takes the part as the largest need", () => {
    // The reserve of 10,200 at the part 0.5 is 5,100.
    expect(budgetStep(readOf(8700, 50), 3600, NOW, MAX_WAIT, RESET_MARGIN_MS, 0.5)).toEqual({ action: "go" });
    expect(budgetStep(readOf(8699, 50), 3600, NOW, MAX_WAIT, RESET_MARGIN_MS, 0.5)).toEqual({ action: "stop", ms: 50 * MINUTE });
    expect(budgetStep(readOf(8699, 12), 3600, NOW, MAX_WAIT, RESET_MARGIN_MS, 0.5)).toEqual({ action: "wait", ms: 12 * MINUTE + RESET_MARGIN_MS });
    // A need above the part becomes the part, so a run goes in a new window.
    expect(budgetStep(readOf(10_200, 60), DEFAULT_NEED, NOW, MAX_WAIT, RESET_MARGIN_MS, 0.5)).toEqual({ action: "go" });
    // A need of 0 turns off the gate, also with a part.
    expect(budgetStep(readOf(0, 50), 0, NOW, MAX_WAIT, RESET_MARGIN_MS, 0.5)).toEqual({ action: "go" });
  });

  it("holds the second run of a window, so four runs of 2,700 requests do not use 0.75 of the limit in one hour", () => {
    // 2026-11-21: four runs in one hour used 8,053 of 10,750 requests. With the part 0.5, the run after the first one waits.
    const limit = 10_750;
    expect(budgetStep(readOf(limit, 55, limit), 2700, NOW, MAX_WAIT, RESET_MARGIN_MS, 0.5)).toEqual({ action: "go" });
    expect(budgetStep(readOf(limit - 2700, 40, limit), 2700, NOW, MAX_WAIT, RESET_MARGIN_MS, 0.5)).toEqual({ action: "stop", ms: 40 * MINUTE });
    expect(budgetStep(readOf(limit - 2700, 40, limit), 2700, NOW, MAX_WAIT)).toEqual({ action: "go" });
  });
});

describe("the need of a run from the runs before it", () => {
  it("is the default with fewer than the fewest runs", () => {
    expect(needOfRuns([]).need).toBe(DEFAULT_NEED);
    expect(needOfRuns(Array.from({ length: MIN_COST_RUNS - 1 }, () => 2600))).toEqual({
      need: DEFAULT_NEED,
      note: `Rate need: ${DEFAULT_NEED}, the default. The state has ${MIN_COST_RUNS - 1} of the ${MIN_COST_RUNS} full applies that a need from the runs needs.`,
    });
  });

  it("is the worst run plus the spread, up to the next 100", () => {
    // The full applies of 2026-11-17: the worst used 2,986 requests, and the best 2,406.
    expect(needOfRuns([2406, 2608, 2986, 2733, 2923])).toEqual({
      need: 3600,
      note: "Rate need: 3600, from the last 5 full applies: the worst used 2986 requests, and the spread is 580.",
    });
    expect(needOfRuns([2000, 2000, 2000, 2000, 2000]).need).toBe(2000);
    expect(needOfRuns([2000, 2000, 2000, 2000, 2001]).need).toBe(2100);
  });

  it("follows a train that grows, and forgets the runs before the last ones", () => {
    const old = Array.from({ length: COST_RUNS }, () => 9000);
    const grown = Array.from({ length: COST_RUNS }, () => 4000);
    expect(needOfRuns([...old, ...grown]).need).toBe(4000);
    expect(needOfRuns([...grown, 7000]).need).toBe(10_000);
  });

  it("keeps the last runs in the state", () => {
    expect(addCost([], 2600)).toEqual([2600]);
    const full = Array.from({ length: COST_RUNS }, (_, i) => 1000 + i);
    const next = addCost(full, 5000);
    expect(next).toHaveLength(COST_RUNS);
    expect(next[0]).toBe(1001);
    expect(next.at(-1)).toBe(5000);
    expect(full).toHaveLength(COST_RUNS);
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

  it("keeps the reserve of the part, and tells it in the note", async () => {
    const time = fakeTime();
    const go = await budgetGate({ need: 3600, part: 0.5, maxWaitMs: MAX_WAIT, read: reads(readOf(9000, 30)).read, now: time.now, sleep: time.sleep });
    expect(go.record).toMatchObject({ outcome: "go", need: 3600, left: 9000, reserve: 5100, waitedMs: 0 });
    expect(go.record.note).toBe(
      "Rate budget: 9000 requests are left, 5100 of them stay for the other users of the token (the train uses the part 0.5 of the limit of 10200), and a run needs 3600. The run goes on.",
    );
    const stop = await budgetGate({ need: 3600, part: 0.5, maxWaitMs: MAX_WAIT, read: reads(readOf(8000, 45)).read, now: time.now, sleep: time.sleep });
    expect(stop.record).toMatchObject({ outcome: "stop", reserve: 5100 });
    const off = await budgetGate({ need: 0, part: 0.5, maxWaitMs: MAX_WAIT, read: reads(readOf(10, 45)).read, now: time.now, sleep: time.sleep });
    expect(off.record).toMatchObject({ outcome: "go", need: 0, reserve: 0 });
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

describe("budgetGate on a live budget", () => {
  it("decides on the window of the tracker with the fewest requests left, and the read is only a first value", async () => {
    const time = fakeTime();
    const tracker = rateTracker();
    tracker.observe({ used: 10_000, remaining: 250, reset: (NOW + 10 * MINUTE) / 1000 });
    const start = readOf(9974, 34, LIMIT);
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: reads(start, start).read, tracker, now: time.now, sleep: time.sleep });
    expect(gate.record).toMatchObject({ outcome: "waited", left: 250, reset: "2026-11-15T12:10:00.000Z", waitedMs: 10 * MINUTE + RESET_MARGIN_MS });
    expect(time.sleeps).toEqual([10 * MINUTE + RESET_MARGIN_MS]);
    expect(tracker.windows()).toHaveLength(2);
  });

  it("decides on the windows of its credential only: a short window of another token does not hold the run", async () => {
    const time = fakeTime();
    const tracker = rateTracker();
    tracker.observe({ used: 4990, remaining: 10, reset: (NOW + 10 * MINUTE) / 1000 }, "Bearer other-token");
    const start = readOf(9000, 34, LIMIT);
    const gate = await budgetGate({ need: 6000, maxWaitMs: MAX_WAIT, read: reads(start).read, tracker, credential: "Bearer home-token", now: time.now, sleep: time.sleep });
    expect(gate.record).toMatchObject({ outcome: "go", left: 9000 });
    expect(time.sleeps).toEqual([]);
    expect(tracker.live(NOW, "Bearer home-token")?.remaining).toBe(9000);
  });
});

const API = "https://api.github.com";
const LIMIT = 10_250;
const PULL = (n: number): string => `${API}/repos/example-owner/example-repo/pulls/${n}`;

/** An answer of the API with the headers of the rate limit. The reset is in minutes after `NOW`. */
const answerOf = (used: number, resetInMinutes: number, status = 200): Response =>
  new Response("{}", {
    status,
    headers: {
      "x-ratelimit-used": String(used),
      "x-ratelimit-remaining": String(Math.max(0, LIMIT - used)),
      "x-ratelimit-reset": String(Math.floor((NOW + resetInMinutes * MINUTE) / 1000)),
    },
  });

/** A fetch that gives the answers in turn, and counts the requests. */
function answers(...list: Response[]): { fetch: FetchFn; count: () => number } {
  let n = 0;
  return {
    fetch: async () => {
      n++;
      return list.shift() ?? new Response("{}", { status: 200 });
    },
    count: () => n,
  };
}

/** The guard of a run on a meter, with a fake time and a log. */
function guarded(f: FetchFn, o: { need: number; seed?: RateLimitRead; waited?: boolean; part?: number }) {
  const time = fakeTime();
  const lines: string[] = [];
  const meter = requestMeter(f, API, time.now);
  if (o.seed) meter.rate.seed(o.seed);
  const guard = rateGuard(meter.fetch, {
    tracker: meter.rate,
    need: o.need,
    maxWaitMs: MAX_WAIT,
    now: time.now,
    sleep: time.sleep,
    log: (line) => lines.push(line),
    ...(o.waited ? { waited: true } : {}),
    ...(o.part !== undefined ? { part: o.part } : {}),
  });
  return { guard, time, lines, meter };
}

/** This function gives the error of a promise that rejects. */
const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => new Error("no rejection"), (e: unknown) => e);

describe("rateGuard", () => {
  it("keeps the reserve of the part after the run sent its need, so the part is a ceiling of the window", async () => {
    // The reserve of 10,250 at the part 0.5 is 5,125. The run needs 2, and its window has 5,128 left.
    const api = answers(answerOf(LIMIT - 5127, 30), answerOf(LIMIT - 5126, 30), answerOf(LIMIT - 5125, 30));
    const { guard, lines } = guarded(api.fetch, { need: 2, part: 0.5, seed: readOf(5128, 30, LIMIT) });
    for (let i = 1; i <= 3; i++) expect((await guard.fetch(PULL(i))).status).toBe(200);
    const error = await rejection(guard.fetch(PULL(4)));
    expect(error).toBeInstanceOf(RateStop);
    expect((error as RateStop).message).toContain("5125 requests are left until");
    expect((error as RateStop).message).toContain("5125 of them stay for the other users of the token, and the run needs 1 more.");
    expect(api.count()).toBe(3);
    expect(lines).toHaveLength(1);
  });

  it("keeps no reserve for a run with no need", async () => {
    const api = answers(answerOf(LIMIT - 9, 30));
    const { guard } = guarded(api.fetch, { need: 0, part: 0.5, seed: readOf(10, 30, LIMIT) });
    expect((await guard.fetch(PULL(1))).status).toBe(200);
  });

  it("waits one time for the reset after a stale first read and a 403, and sends the request again", async () => {
    const api = answers(answerOf(LIMIT, 12, 403), answerOf(3, 72));
    const { guard, time, lines } = guarded(api.fetch, { need: 6000, seed: readOf(LIMIT - 276, 34, LIMIT) });
    const res = await guard.fetch(PULL(1));
    expect(res.status).toBe(200);
    expect(api.count()).toBe(2);
    expect(time.sleeps).toEqual([12 * MINUTE + RETRY_MARGIN_MS]);
    expect(lines).toEqual([
      "Rate guard: GitHub refused a request, because the rate limit is spent until 2026-11-15T12:12:00.000Z. The run waits 12.1 minutes for the reset at 2026-11-15T12:12:00.000Z, one time, and then goes on.",
    ]);
    expect(guard.record()).toEqual({ sent: 2, repeats: 1, waitedMs: 12 * MINUTE + RETRY_MARGIN_MS, stop: null });
    expect(guardLine(guard.record())).toBe("Rate guard: the run waited 12.1 minutes for a reset, and 1 request went again after a refusal.");
  });

  it("stops at once when the reset of a refusal comes after the longest wait, and names the reset", async () => {
    const api = answers(answerOf(LIMIT, 45, 403));
    const { guard, time, lines } = guarded(api.fetch, { need: 6000 });
    const error = await rejection(guard.fetch(PULL(1)));
    expect(error).toBeInstanceOf(RateStop);
    expect((error as RateStop).reset).toBe("2026-11-15T12:45:00.000Z");
    expect((error as RateStop).message).toBe(
      "Rate guard: GitHub refused a request, because the rate limit is spent until 2026-11-15T12:45:00.000Z. The reset at 2026-11-15T12:45:00.000Z is 45.0 minutes away, after the longest wait of 20.0 minutes. The run stops at once, and a later run does the work.",
    );
    expect(time.sleeps).toEqual([]);
    expect(guard.stopped()).toBe(error);
    // After the stop, each counted request throws the same stop and does not go to GitHub. The log has the stop one time.
    expect(await rejection(guard.fetch(PULL(2)))).toBe(error);
    expect(api.count()).toBe(1);
    expect(lines).toHaveLength(1);
    // GitHub does not count GET /rate_limit, and the registry is not GitHub, so these requests go on.
    await guard.fetch(`${API}/rate_limit`);
    await guard.fetch("https://registry.npmjs.org/@ex%2fcore");
    expect(api.count()).toBe(3);
    expect(guard.record()).toEqual({ sent: 1, repeats: 0, waitedMs: 0, stop: (error as RateStop).message });
    expect(guardLine(guard.record())).toBe((error as RateStop).message);
  });

  it("stops at the second shortage of a run, because the run waits one time only", async () => {
    const api = answers(answerOf(LIMIT, 10, 403), answerOf(1, 25), answerOf(LIMIT, 25, 403));
    const { guard, time } = guarded(api.fetch, { need: 0 });
    expect((await guard.fetch(PULL(1))).status).toBe(200);
    const error = await rejection(guard.fetch(PULL(2)));
    expect(error).toBeInstanceOf(RateStop);
    expect((error as RateStop).message).toContain("The run waited one time already, so it stops at once. The reset is at 2026-11-15T12:25:00.000Z");
    expect(time.sleeps).toEqual([10 * MINUTE + RETRY_MARGIN_MS]);
  });

  it("stops when GitHub refuses the request again after the wait", async () => {
    const api = answers(answerOf(LIMIT, 10, 403), answerOf(LIMIT, 70, 403));
    const { guard } = guarded(api.fetch, { need: 0 });
    const error = await rejection(guard.fetch(PULL(1)));
    expect((error as RateStop).message).toBe(
      "Rate guard: GitHub refused a request again after the wait. The rate limit is spent until 2026-11-15T13:10:00.000Z. The run stops at once, and a later run does the work.",
    );
    expect(guard.record()).toMatchObject({ sent: 2, repeats: 1, waitedMs: 10 * MINUTE + RETRY_MARGIN_MS });
  });

  it("stops at once on a refusal inside the longest wait when the run waited at its gate", async () => {
    const api = answers(answerOf(LIMIT, 5, 403));
    const { guard, time } = guarded(api.fetch, { need: 0, waited: true });
    const error = await rejection(guard.fetch(PULL(1)));
    expect((error as RateStop).message).toContain("The run waited one time already");
    expect(time.sleeps).toEqual([]);
  });

  it("waits only the margin for a reset in the past, and keeps the one wait of the run", async () => {
    const api = answers(answerOf(LIMIT, -1, 403), answerOf(1, 70), answerOf(LIMIT, 10, 403), answerOf(2, 70));
    const { guard, time } = guarded(api.fetch, { need: 0 });
    expect((await guard.fetch(PULL(1))).status).toBe(200);
    expect((await guard.fetch(PULL(2))).status).toBe(200);
    expect(time.sleeps).toEqual([RETRY_MARGIN_MS, 10 * MINUTE]);
    expect(guard.record()).toEqual({ sent: 4, repeats: 2, waitedMs: RETRY_MARGIN_MS + 10 * MINUTE, stop: null });
  });

  it("checks the need before each request, less the requests that the guard sent", async () => {
    const api = answers(answerOf(LIMIT - 2, 10), answerOf(LIMIT - 1, 10), answerOf(LIMIT, 10), answerOf(5, 70));
    const time = fakeTime();
    const lines: string[] = [];
    const sentAtSleep: number[] = [];
    const meter = requestMeter(api.fetch, API, time.now);
    meter.rate.seed(readOf(3, 10, LIMIT));
    const guard = rateGuard(meter.fetch, {
      tracker: meter.rate,
      need: 3,
      maxWaitMs: MAX_WAIT,
      now: time.now,
      sleep: async (ms) => {
        sentAtSleep.push(api.count());
        await time.sleep(ms);
      },
      log: (line) => lines.push(line),
    });
    for (let i = 1; i <= 4; i++) expect((await guard.fetch(PULL(i))).status).toBe(200);
    // Requests 1 to 3 need 3, 2 and 1 requests, and the window has them. Request 4 waits for the reset first.
    expect(sentAtSleep).toEqual([3]);
    expect(lines).toEqual([
      "Rate guard: 0 requests are left until 2026-11-15T12:10:00.000Z, and the run needs 1 more. The run waits 10.1 minutes for the reset at 2026-11-15T12:10:00.000Z, one time, and then goes on.",
    ]);
  });

  it("shares the one wait among the requests that wait at the same time", async () => {
    const api = answers(answerOf(LIMIT, 10, 403), answerOf(LIMIT, 10, 403), answerOf(1, 70), answerOf(2, 70));
    let t = NOW;
    const sleeps: number[] = [];
    let release = (): void => {};
    const meter = requestMeter(api.fetch, API, () => t);
    const guard = rateGuard(meter.fetch, {
      tracker: meter.rate,
      need: 0,
      maxWaitMs: MAX_WAIT,
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        return new Promise<void>((resolve) => {
          release = () => {
            t += ms;
            resolve();
          };
        });
      },
    });
    const both = Promise.all([guard.fetch(PULL(1)), guard.fetch(PULL(2))]);
    // Each answer of 403 goes through the meter, which reads a copy of its body. The loop lets both answers arrive.
    for (let i = 0; i < 50 && sleeps.length + api.count() < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sleeps).toEqual([10 * MINUTE + RETRY_MARGIN_MS]);
    release();
    expect((await both).map((r) => r.status)).toEqual([200, 200]);
    expect(guard.record()).toEqual({ sent: 4, repeats: 2, waitedMs: 10 * MINUTE + RETRY_MARGIN_MS, stop: null });
  });
});

// The numbers of the answers of Train 43920794285 (2026-11-16 17:40Z), as in meter.test.ts. The run of 17:50Z did not
// have the guard, and GitHub refused 258 of its requests.
describe("rateGuard on the answers of Train 43920794285", () => {
  const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
  const START: RateLimitRead = { limit: LIMIT, used: 276, remaining: LIMIT - 276, reset: "2026-11-16T18:14:29.000Z" };
  const STALE = seconds("2026-11-16T18:14:28Z");
  const TRUE = seconds("2026-11-16T18:01:55Z");
  const ANSWER_9 = Date.parse("2026-11-16T17:40:38.514Z");
  const answer = (used: number, reset: number): Response =>
    new Response("{}", { status: 200, headers: { "x-ratelimit-used": String(used), "x-ratelimit-remaining": String(Math.max(0, LIMIT - used)), "x-ratelimit-reset": String(reset) } });
  const train = (need: number, list: Response[]) => {
    const api = answers(...list);
    const meter = requestMeter(api.fetch, API, () => ANSWER_9);
    meter.rate.seed(START);
    const guard = rateGuard(meter.fetch, { tracker: meter.rate, need, maxWaitMs: MAX_WAIT, now: () => ANSWER_9, sleep: async () => {} });
    return { api, meter, guard };
  };

  it("(1) stops before request 10, on the true window from answer 9, with no refusal", async () => {
    const { api, meter, guard } = train(DEFAULT_NEED, [...Array.from({ length: 8 }, (_, i) => answer(277 + i, STALE)), answer(9246, TRUE)]);
    for (let i = 1; i <= 9; i++) await guard.fetch(PULL(i));
    const error = await rejection(guard.fetch(PULL(10)));
    expect(error).toBeInstanceOf(RateStop);
    expect((error as RateStop).message).toBe(
      "Rate guard: 1004 requests are left until 2026-11-16T18:01:55.000Z, and the run needs 5991 more. The reset at 2026-11-16T18:01:55.000Z is 21.3 minutes away, after the longest wait of 20.0 minutes. The run stops at once, and a later run does the work.",
    );
    expect(api.count()).toBe(9);
    expect(meter.refusals()).toMatchObject({ primary: 0, secondary: 0 });
  });

  it("(3) holds a request on a stale answer with a higher used count and a later reset, the conservative side", async () => {
    // An urgent run needs only a window that is not spent. The true window has 1004 requests left, but the stale window has none.
    const { api, guard } = train(0, [answer(9246, TRUE), answer(LIMIT, STALE)]);
    await guard.fetch(PULL(1));
    await guard.fetch(PULL(2));
    const error = await rejection(guard.fetch(PULL(3)));
    expect((error as RateStop).reset).toBe("2026-11-16T18:14:29.000Z");
    expect(api.count()).toBe(2);
  });
});

// The windows of Train 44205603365, a run with two tokens: the home token has 6952 requests left, and the other token has
// 4928. With one window for the answers of both tokens, the guard saw 1652 and stopped the run.
describe("rateGuard on the answers of Train 44205603365", () => {
  const AT = Date.parse("2026-11-18T00:11:18Z");
  const HOME = { authorization: "Bearer home-token" };
  const OTHER = { authorization: "Bearer other-token" };
  const pull = (owner: string, n: number): string => `${API}/repos/${owner}/example-repo/pulls/${n}`;
  const answerOf2 = async (_url: string, init?: RequestInit): Promise<Response> => {
    const [used, limit, reset] = credentialOf(init) === HOME.authorization ? [3348, 10_300, 1_794_963_183] : [72, 5000, 1_794_963_184];
    return new Response("{}", { status: 200, headers: { "x-ratelimit-used": String(used), "x-ratelimit-remaining": String(limit - used), "x-ratelimit-reset": String(reset) } });
  };
  const run = (share?: (credential: string) => number) => {
    const lines: string[] = [];
    const meter = requestMeter(answerOf2, API, () => AT);
    const guard = rateGuard(meter.fetch, {
      tracker: meter.rate,
      need: DEFAULT_NEED,
      maxWaitMs: MAX_WAIT,
      now: () => AT,
      sleep: async () => {},
      log: (line) => lines.push(line),
      ...(share ? { share } : {}),
    });
    return { guard, lines };
  };

  it("goes on when each token covers its share of the need", async () => {
    const { guard, lines } = run((credential) => (credential === HOME.authorization ? 126 / 129 : 3 / 129));
    for (let i = 1; i <= 3; i++) {
      await guard.fetch(pull("home-owner", i), { headers: HOME });
      await guard.fetch(pull("other-owner", i), { headers: OTHER });
    }
    expect(guard.stopped()).toBeNull();
    expect(lines).toEqual([]);
    expect(guard.record()).toMatchObject({ sent: 6, waitedMs: 0, stop: null });
  });

  it("decides on the window of the token of the request, and names the token in a stop", async () => {
    // Each token has the full need: the other token cannot cover it with its limit of 5000.
    const { guard } = run();
    await guard.fetch(pull("home-owner", 1), { headers: HOME });
    await guard.fetch(pull("other-owner", 1), { headers: OTHER });
    await guard.fetch(pull("home-owner", 2), { headers: HOME });
    const error = await rejection(guard.fetch(pull("other-owner", 2), { headers: OTHER }));
    expect(error).toBeInstanceOf(RateStop);
    expect((error as RateStop).message).toBe(
      "Rate guard: 4928 requests of token 1 are left until 2026-11-18T00:53:04.000Z, and its share of the run needs 4999 more. The reset at 2026-11-18T00:53:04.000Z is 41.8 minutes away, after the longest wait of 20.0 minutes. The run stops at once, and a later run does the work.",
    );
    expect(guard.record().sent).toBe(3);
  });
});
