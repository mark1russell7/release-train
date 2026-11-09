// All repository names in these tests are made up.
import { describe, expect, it } from "vitest";
import {
  RENOVATE_DAYS,
  assignDays,
  configDay,
  dayLoads,
  dayOfSchedule,
  jobCount,
  matrixSize,
  pullRequestJobs,
  startsOnPullRequest,
  usesSharedPreset,
  withSchedule,
} from "./renovate.ts";
import type { DayInput, RenovateDay } from "./renovate.ts";

/** This function gives a seeded list of inputs: mixed weights, some repositories with a day. */
function sample(count: number, seed: number): DayInput[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  return Array.from({ length: count }, (_, i) => {
    const weight = 1 + Math.floor(next() ** 2 * 30);
    const current = next() < 0.3 ? (RENOVATE_DAYS[Math.floor(next() * 7)] as RenovateDay) : null;
    return { repo: `repo-${String(i).padStart(2, "0")}`, weight, current };
  });
}

const spread = (loads: Record<RenovateDay, number>): number => Math.max(...Object.values(loads)) - Math.min(...Object.values(loads));

describe("assignDays", () => {
  it("balances the days: the spread is at most the largest weight", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const inputs = sample(40, seed);
      const days = assignDays(inputs);
      expect(days.size).toBe(40);
      const largest = Math.max(...inputs.map((i) => i.weight));
      expect(spread(dayLoads(inputs, days))).toBeLessThanOrEqual(largest);
    }
  });

  it("balances also when all repositories start on one day", () => {
    const inputs: DayInput[] = Array.from({ length: 14 }, (_, i) => ({ repo: `r${i}`, weight: 1, current: "monday" }));
    const loads = dayLoads(inputs, assignDays(inputs));
    expect(Object.values(loads)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  it("is stable: a second run with the days of the first changes nothing", () => {
    for (const seed of [11, 12, 13]) {
      const inputs = sample(40, seed);
      const first = assignDays(inputs);
      const again = assignDays(inputs.map((i) => ({ ...i, current: first.get(i.repo) ?? null })));
      expect([...again.entries()].sort()).toEqual([...first.entries()].sort());
    }
  });

  it("puts a new repository on the lightest day and moves no other repository", () => {
    const inputs = sample(40, 21);
    const first = assignDays(inputs);
    const loads = dayLoads(inputs, first);
    const light = RENOVATE_DAYS.reduce((b, d) => (loads[d] < loads[b] ? d : b));
    const settled = inputs.map((i) => ({ ...i, current: first.get(i.repo) ?? null }));
    const next = assignDays([...settled, { repo: "new-repo", weight: 1, current: null }]);
    expect(next.get("new-repo")).toBe(light);
    for (const i of inputs) expect(next.get(i.repo)).toBe(first.get(i.repo));
  });

  it("is deterministic: the order of the inputs does not change the result", () => {
    const inputs = sample(40, 31);
    const a = assignDays(inputs);
    const b = assignDays([...inputs].reverse());
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it("does not move a fixed repository", () => {
    const inputs: DayInput[] = [
      { repo: "base", weight: 50, current: "monday", fixed: true },
      ...Array.from({ length: 6 }, (_, i) => ({ repo: `r${i}`, weight: 5, current: "monday" as const })),
    ];
    const days = assignDays(inputs);
    expect(days.get("base")).toBe("monday");
    expect([...days.entries()].filter(([, d]) => d === "monday").map(([r]) => r)).toEqual(["base"]);
  });
});

describe("schedules", () => {
  it("reads and writes the day of a schedule", () => {
    expect(dayOfSchedule("before 6am on Tuesday")).toBe("tuesday");
    expect(dayOfSchedule("after 10pm every weekday")).toBeNull();
    expect(configDay({})).toBeNull();
    expect(configDay({ schedule: ["before 6am on friday"] })).toBe("friday");
    expect(configDay({ schedule: ["before 6am on friday", "before 6am on monday"] })).toBe("own");
    expect(configDay({ schedule: ["every weekend"] })).toBe("own");
  });

  it("puts a new schedule after extends and keeps the other keys", () => {
    const out = withSchedule({ $schema: "s", extends: ["x"], labels: ["a"] }, "sunday");
    expect(Object.keys(out)).toEqual(["$schema", "extends", "schedule", "labels"]);
    expect(out["schedule"]).toEqual(["before 6am on sunday"]);
    expect(Object.keys(withSchedule({ schedule: ["x"], extends: ["y"] }, "monday"))).toEqual(["schedule", "extends"]);
  });

  it("knows the shared preset", () => {
    expect(usesSharedPreset({ extends: ["github>owner-a/template//renovate/default"] }, "owner-a", "template")).toBe(true);
    expect(usesSharedPreset({ extends: ["github>owner-a/template//renovate/base"] }, "owner-a", "template")).toBe(true);
    expect(usesSharedPreset({ extends: ["config:recommended"] }, "owner-a", "template")).toBe(false);
  });
});

describe("job counts", () => {
  it("counts the jobs of a matrix", () => {
    expect(matrixSize({ os: ["a", "b"], node: [1, 2, 3] })).toBe(6);
    expect(matrixSize({ os: ["a", "b"], exclude: [{ os: "a" }] })).toBe(1);
    expect(matrixSize({ include: [{ a: 1 }, { a: 2 }] })).toBe(2);
    expect(matrixSize("${{ fromJSON(needs.a.outputs.m) }}")).toBe(1);
  });

  it("knows the pull request triggers", () => {
    expect(startsOnPullRequest("pull_request")).toBe(true);
    expect(startsOnPullRequest(["push", "pull_request"])).toBe(true);
    expect(startsOnPullRequest({ pull_request_target: null })).toBe(true);
    expect(startsOnPullRequest({ push: { branches: ["main"] } })).toBe(false);
  });

  it("counts the jobs of a workflow, with the called files", async () => {
    const called = "on: workflow_call\njobs:\n  a: {runs-on: x}\n  b: {runs-on: x}\n";
    const text = [
      "on: pull_request",
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      "        os: [a, b, c]",
      "  call:",
      "    uses: ./.github/workflows/called.yml",
      "  remote:",
      "    uses: other/repo/.github/workflows/x.yml@v1",
    ].join("\n");
    const read = async (p: string) => (p === "./.github/workflows/called.yml" ? called : null);
    expect(await jobCount(text, read)).toBe(3 + 2 + 1);
  });

  it("adds only the pull request workflows of a repository", async () => {
    const files: Record<string, string> = {
      ".github/workflows/ci.yml": "on: [pull_request, push]\njobs:\n  a: {}\n  b: {}\n",
      ".github/workflows/nightly.yml": "on: {schedule: [{cron: '0 0 * * *'}]}\njobs:\n  a: {}\n",
      "docs/x.yml": "on: pull_request\njobs:\n  a: {}\n",
    };
    const n = await pullRequestJobs(Object.keys(files), async (p) => files[p] ?? null, async () => null);
    expect(n).toBe(2);
  });
});
