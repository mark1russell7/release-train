// All repository and package names in these tests are made up.
import { describe, expect, it } from "vitest";
import { COMPARE_FILES_MAX } from "./apply.ts";
import {
  CANDIDATE_CODES,
  CANDIDATE_POLICY,
  backoffHours,
  bodyAttempt,
  bodyItems,
  candidateItems,
  commitHealth,
  decide,
  decideWith,
  jobMinutes,
  markLines,
  modeFor,
  monotone,
  nextAttempt,
  paceHours,
  shareOf,
  surfaceChanged,
} from "./candidate-policy.ts";
import type { CandidateCode, CandidateDecision, CandidateFacts, CandidateItem, CandidateNeed, CandidatePolicy, PlanChangeChoice } from "./candidate-policy.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-11-11T12:00:00Z");
const P: CandidatePolicy = { ...CANDIDATE_POLICY, mode: "one-candidate" };
const ITEMS: CandidateItem[] = [{ dep: "@acme/core", to: "1.2.0" }];

/** An open green candidate of a public repository, with each lazy fact read: it merges. */
function facts(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    kind: "update",
    private: false,
    now: NOW,
    urgent: false,
    only: false,
    yieldMaxHours: 24,
    plan: { fingerprint: "fp1", items: ITEMS },
    open: { fingerprint: "fp1", attempt: 1, items: ITEMS, createdAt: NOW - 2 * H, retryLabel: false },
    ci: { state: "green", stuck: false },
    mergeable: true,
    behind: 0,
    surfaceChanged: false,
    otherRuns: 0,
    lastPushAt: NOW - 2 * H,
    costMinutes: 10,
    mainHealth: { head: "green", redMerges: null },
    ...over,
  };
}

/** The decision for facts that have each lazy fact. */
function decision(f: CandidateFacts, p: CandidatePolicy = P): CandidateDecision {
  const step = decide(p, f);
  if (!("decision" in step)) throw new Error(`need ${step.need}`);
  return step.decision;
}

/** The needs and the decision when the lazy facts come from `full` one at a time. */
async function lazy(full: CandidateFacts, p: CandidatePolicy = P): Promise<{ decision: CandidateDecision; needs: CandidateNeed[] }> {
  const start: CandidateFacts = { ...full };
  for (const k of ["ci", "mergeable", "behind", "surfaceChanged", "otherRuns", "lastPushAt", "costMinutes", "mainHealth"] as const) delete start[k];
  const field: Record<CandidateNeed, keyof CandidateFacts> = { ci: "ci", mergeable: "mergeable", behind: "behind", surface: "surfaceChanged", otherRuns: "otherRuns", lastPush: "lastPushAt", cost: "costMinutes", mainHealth: "mainHealth" };
  const r = await decideWith(p, start, async (need) => ({ [field[need]]: full[field[need]] }));
  return { decision: r.decision, needs: r.needs };
}

describe("the policy data", () => {
  it("acts in the mode one-candidate for a share of 0.25 of the repositories", () => {
    // The next step to each repository changes the share in the data and in this one line.
    expect({ mode: CANDIDATE_POLICY.mode, share: CANDIDATE_POLICY.share }).toEqual({ mode: "one-candidate", share: 0.25 });
  });

  it("ships the other values of the design", () => {
    expect(CANDIDATE_POLICY).toMatchObject({
      ratePublic: 5,
      ratePrivate: 1,
      paceFloorHours: 1,
      paceCeilHours: 24,
      backoffBaseHours: 1,
      backoffCeilHours: 24,
      stuckCiHours: 6,
      costWhenNoReadMinutes: 10,
      planChangeOnGreen: { update: "merge-first-when-monotone", sync: "replace" },
      redMainWindowDays: 30,
      retryLabel: "release-train:retry",
    });
  });
});

describe("paceHours and backoffHours", () => {
  it("gives clamp(cost / rate, 1 h, 24 h)", () => {
    expect(paceHours(P, 30, false)).toBe(6);
    expect(paceHours(P, 2, false)).toBe(1);
    expect(paceHours(P, 500, false)).toBe(24);
    expect(paceHours(P, 3, true)).toBe(3);
    expect(paceHours(P, null, false)).toBe(2);
  });

  it("gives clamp(2^(attempt - 1) h, 1 h, 24 h)", () => {
    expect([0, 1, 2, 3, 5, 6, 20].map((a) => backoffHours(P, a))).toEqual([1, 1, 2, 4, 16, 24, 24]);
  });
});

describe("R0, the yield stays", () => {
  it("R0: a young green candidate waits for the runs of other branches", () => {
    expect(decision(facts({ otherRuns: 2 }))).toMatchObject({ action: "wait", rule: "R0" });
  });

  it("R0: the yield ends after yieldMaxHours, and the train does not read the other runs", async () => {
    const r = await lazy(facts({ otherRuns: 2, open: { ...facts().open!, createdAt: NOW - 25 * H } }));
    expect(r.decision).toMatchObject({ action: "merge" });
    expect(r.needs).not.toContain("otherRuns");
  });
});

describe("R1, no preemption", () => {
  it("R1: no push while CI runs, also when the plan changed", async () => {
    const r = await lazy(facts({ ci: { state: "running", stuck: false }, plan: { fingerprint: "fp2", items: ITEMS } }));
    expect(r.decision).toMatchObject({ action: "wait", rule: "R1", reason: "building" });
    expect(r.needs).toEqual(["ci"]);
  });

  it("R1: CI that is stuck does not count as running", () => {
    expect(decision(facts({ ci: { state: "running", stuck: true }, plan: { fingerprint: "fp2", items: ITEMS } }))).toMatchObject({ action: "push", rule: "R5", attempt: 1 });
  });

  it("R1: an urgent update pushes while CI runs", () => {
    expect(decision(facts({ urgent: true, ci: { state: "running", stuck: false }, plan: { fingerprint: "fp2", items: ITEMS } }))).toMatchObject({ action: "push", rule: "urgent" });
  });
});

describe("R2, exact staleness", () => {
  it("R2: a green candidate that is behind merges when its surface did not change", () => {
    expect(decision(facts({ behind: 40 }))).toMatchObject({ action: "merge", rule: "R2" });
  });

  it("R2: a change of the surface makes the candidate stale", () => {
    expect(decision(facts({ behind: 40, surfaceChanged: true }))).toMatchObject({ action: "push", rule: "R2", attempt: 1, rebuild: true });
  });

  it("R2: a list of files that GitHub cut gives its own reason, not the reason of a real change", () => {
    const d = decision(facts({ behind: 40, surfaceChanged: true, surfaceCut: true }));
    // The code tells the two cases apart, so the log of a private repository also tells them apart.
    expect(d).toMatchObject({ action: "push", rule: "R2", code: "surface-list-cut", rebuild: true });
    expect(decision(facts({ behind: 40, surfaceChanged: true }))).toMatchObject({ action: "push", rule: "R2", code: "surface-changed", rebuild: true });
    expect(d.reason).toContain(`cut a list of files of the surface check at ${COMPARE_FILES_MAX} files`);
    expect(d.reason).not.toContain("changed a file of the surface");
    // A real change keeps its reason.
    expect(decision(facts({ behind: 40, surfaceChanged: true })).reason).toBe("the default branch changed a file of the surface of the candidate");
  });

  it("R2: a candidate that GitHub cannot merge is stale", () => {
    expect(decision(facts({ mergeable: false }))).toMatchObject({ action: "push", rule: "R2" });
  });

  it("R2: a merge that GitHub refused makes the candidate stale in the same run", () => {
    expect(decision(facts({ behind: 3, mergeRefused: true }))).toMatchObject({ action: "push", rule: "R2" });
  });

  it("R2: a failed read of behind counts as behind, and the surface decides", async () => {
    const r = await lazy(facts({ behind: null, surfaceChanged: true }));
    expect(r.decision).toMatchObject({ action: "push", rule: "R2" });
    expect(r.needs).toContain("surface");
  });

  it("R2: the train reads the surface only when the candidate is behind", async () => {
    const r = await lazy(facts({ behind: 0, surfaceChanged: true }));
    expect(r.decision).toMatchObject({ action: "merge" });
    expect(r.needs).not.toContain("surface");
  });

  it("R2: a stale candidate waits for the pace", () => {
    expect(decision(facts({ mergeable: false, lastPushAt: NOW - 30 * 60_000 }))).toMatchObject({ action: "wait", rule: "R3", until: NOW + 30 * 60_000 });
  });
});

describe("surfaceChanged", () => {
  it("gives false for files that the candidate does not change", () => {
    expect(surfaceChanged({ files: ["package.json"], cut: false }, { files: ["src/a.ts", "README.md"], cut: false })).toBe(false);
  });

  it("gives true for a file of the candidate", () => {
    expect(surfaceChanged({ files: ["package.json"], cut: false }, { files: ["package.json"], cut: false })).toBe(true);
  });

  it("adds the files of pnpm when the candidate changes the lockfile", () => {
    const c = { files: ["package.json", "pnpm-lock.yaml"], cut: false };
    expect(surfaceChanged(c, { files: ["pnpm-workspace.yaml"], cut: false })).toBe(true);
    expect(surfaceChanged(c, { files: [".npmrc"], cut: false })).toBe(true);
    expect(surfaceChanged({ files: ["package.json"], cut: false }, { files: [".npmrc"], cut: false })).toBe(false);
  });

  it("counts a list that GitHub cut short as a change", () => {
    expect(surfaceChanged({ files: ["a"], cut: true }, { files: [], cut: false })).toBe(true);
    expect(surfaceChanged({ files: ["a"], cut: false }, { files: ["b"], cut: true })).toBe(true);
  });
});

describe("R3, the pace as a budget", () => {
  const none = { open: null, lastPushAt: null };

  it("R3: a branch with no earlier candidate pushes", () => {
    expect(decision(facts(none))).toMatchObject({ action: "push", rule: "R3", attempt: 1 });
  });

  it("R3: no push before the floor of 1 h", async () => {
    const r = await lazy(facts({ open: null, lastPushAt: NOW - 20 * 60_000 }));
    expect(r.decision).toMatchObject({ action: "wait", rule: "R3", until: NOW + 40 * 60_000 });
    expect(r.needs).toEqual(["lastPush"]);
  });

  it("R3: between the floor and the ceiling, the cost of the last candidate decides", () => {
    expect(decision(facts({ open: null, lastPushAt: NOW - 3 * H, costMinutes: 30 }))).toMatchObject({ action: "wait", rule: "R3", until: NOW + 3 * H });
    expect(decision(facts({ open: null, lastPushAt: NOW - 3 * H, costMinutes: 10 }))).toMatchObject({ action: "push" });
  });

  it("R3: the next push uses the clamped budget, so a cost above the ceiling waits until the ceiling", () => {
    // 1000 runner minutes at 5 an hour is 200 h, and the ceiling clamps it to 24 h.
    expect(decision(facts({ open: null, lastPushAt: NOW - 2 * H, costMinutes: 1000 }))).toMatchObject({ action: "wait", rule: "R3", until: NOW + 22 * H });
    // A cost below the floor waits until the floor.
    expect(decision(facts({ open: null, lastPushAt: NOW - 30 * 60_000, costMinutes: 1 }))).toMatchObject({ action: "wait", until: NOW + 30 * 60_000 });
  });

  it("R3: before the floor, the wait is the floor, also for a cost above the ceiling", async () => {
    // Before the floor, the run reads no cost. The floor is the earliest time of the next push, not the exact time.
    const r = await lazy(facts({ open: null, lastPushAt: NOW - 20 * 60_000, costMinutes: 1000 }));
    expect(r.decision).toMatchObject({ action: "wait", until: NOW + 40 * 60_000 });
    expect(r.needs).toEqual(["lastPush"]);
  });

  it("R3: a private repository pays in billed minutes at 1 an hour", () => {
    expect(decision(facts({ open: null, private: true, lastPushAt: NOW - 3 * H, costMinutes: 10 }))).toMatchObject({ action: "wait", until: NOW + 7 * H });
  });

  it("R3: a cost that is not known uses costWhenNoReadMinutes", () => {
    expect(decision(facts({ open: null, lastPushAt: NOW - 90 * 60_000, costMinutes: null }))).toMatchObject({ action: "wait", until: NOW + 30 * 60_000 });
  });

  it("R3: after the ceiling of 24 h the train does not read the cost", async () => {
    const r = await lazy(facts({ open: null, lastPushAt: NOW - 25 * H, costMinutes: 10_000 }));
    expect(r.decision).toMatchObject({ action: "push" });
    expect(r.needs).toEqual(["lastPush"]);
  });

  it("R3: urgent and only pass the pace", async () => {
    for (const over of [{ urgent: true }, { only: true }]) {
      const r = await lazy(facts({ open: null, lastPushAt: NOW - 60_000, ...over }));
      expect(r.decision).toMatchObject({ action: "push" });
      expect(r.needs).toEqual([]);
    }
  });
});

describe("R4, the red default branch", () => {
  const behind = { behind: 12 };
  const health = (head: "red" | "green" | "pending" | "no-read", redMerges: number | null = null) => ({ mainHealth: { head, redMerges } });

  it("R4: a green candidate that is behind gets a new build when the default branch is red in its checks", () => {
    const d = decision(facts({ ...behind, ...health("red") }));
    expect(d).toMatchObject({ action: "push", rule: "R4", code: "main-red", attempt: 1, rebuild: true });
    expect(d.reason).toBe("the default branch is red in the checks of the candidate, so the candidate gets a new build on it");
  });

  it("R4: the push of a red default branch keeps the pace of R3", () => {
    const d = decision(facts({ ...behind, ...health("red"), lastPushAt: NOW - 10 * 60_000 }));
    expect(d).toMatchObject({ action: "wait", rule: "R3", code: "pace-wait", until: NOW + 50 * 60_000 });
  });

  it("R4: a red default branch changes nothing for a candidate that is not behind, and the train does not read it", async () => {
    expect(decision(facts({ behind: 0, ...health("red") }))).toMatchObject({ action: "merge", rule: "R2", code: "green-current" });
    expect((await lazy(facts({ behind: 0, ...health("red") }))).needs).not.toContain("mainHealth");
  });

  it("R4: a candidate that holds the fix gets one new build, and then merges on the current default branch", () => {
    expect(decision(facts({ ...behind, ...health("red") }))).toMatchObject({ action: "push", code: "main-red" });
    // After the new build, the candidate is on the head of the default branch. A red head does not stop the merge.
    expect(decision(facts({ behind: 0, ...health("red"), lastPushAt: NOW - 60_000 }))).toMatchObject({ action: "merge" });
  });

  it("R4: a head that is pending, green or has no read goes on to the merge", () => {
    for (const head of ["pending", "green"] as const) {
      expect(decision(facts({ ...behind, ...health(head) }))).toMatchObject({ action: "merge", rule: "R2", code: "green-behind" });
    }
    // A merge with no read of the default branch has its own code.
    expect(decision(facts({ ...behind, ...health("no-read") }))).toMatchObject({ action: "merge", rule: "R2", code: "green-behind-main-no-read" });
  });

  it("R4: no read of the default branch is not green, and the reason tells it", () => {
    expect(decision(facts({ ...behind, ...health("no-read") })).reason).toContain("no read");
    expect(decision(facts({ ...behind, ...health("green") })).reason).not.toContain("no read");
  });

  it("R4: at the bound, a candidate that is behind gets a new build", () => {
    const p = { ...P, redMainBound: 3 };
    expect(decision(facts({ ...behind, ...health("green", 3) }), p)).toMatchObject({ action: "push", rule: "R4", code: "red-merges-bound", rebuild: true });
    expect(decision(facts({ ...behind, ...health("green", 2) }), p)).toMatchObject({ action: "merge" });
  });

  it("R4: the bound keeps the pace of R3", () => {
    const p = { ...P, redMainBound: 1 };
    expect(decision(facts({ ...behind, lastPushAt: NOW - 10 * 60_000, ...health("green", 5) }), p)).toMatchObject({ action: "wait", rule: "R3" });
  });

  it("R4: the bound does nothing when the count has no read", () => {
    const p = { ...P, redMainBound: 1 };
    expect(decision(facts({ ...behind, ...health("green", null) }), p)).toMatchObject({ action: "merge" });
  });

  it("R4: a null bound does nothing, also with a count", () => {
    expect(decision(facts({ ...behind, ...health("green", 99) }))).toMatchObject({ action: "merge" });
  });

  it("R4: the train reads the health only for a candidate that is behind", async () => {
    expect((await lazy(facts({ behind: 0 }))).needs).not.toContain("mainHealth");
    expect((await lazy(facts({ behind: 2 }))).needs).toContain("mainHealth");
  });
});

describe("R5, a red candidate waits for a reason", () => {
  const red = { ci: { state: "failed" as const, stuck: false } };

  it("R5: a red candidate on the current default branch waits", () => {
    const d = decision(facts({ ...red, behind: 0 }));
    expect(d).toMatchObject({ action: "wait", rule: "R5" });
    expect(d.reason).toContain("release-train:retry");
  });

  it("R5: a new plan builds again with attempt 1", () => {
    expect(decision(facts({ ...red, plan: { fingerprint: "fp2", items: ITEMS } }))).toMatchObject({ action: "push", rule: "R5", attempt: 1 });
  });

  it("R5: the default branch moved, but the backoff of the attempt did not pass", () => {
    const d = decision(facts({ ...red, behind: 5, open: { ...facts().open!, attempt: 3 }, lastPushAt: NOW - 2 * H }));
    expect(d).toMatchObject({ action: "wait", rule: "R5", until: NOW + 2 * H });
    expect(d.reason).toContain("red: next retry at 2026-11-11T14:00:00.000Z, or add the label release-train:retry");
  });

  it("R5: the default branch moved and the backoff passed, so the train builds attempt + 1", () => {
    expect(decision(facts({ ...red, behind: 5, open: { ...facts().open!, attempt: 3 }, lastPushAt: NOW - 5 * H }))).toMatchObject({ action: "push", rule: "R5", attempt: 4, rebuild: true });
  });

  it("R5: CI that is stuck is not a red result, so the new build is attempt 1", () => {
    const stuck = { ci: { state: "running" as const, stuck: true } };
    expect(decision(facts({ ...stuck, behind: 5, open: { ...facts().open!, attempt: 3 }, lastPushAt: NOW - 5 * H }))).toMatchObject({ action: "push", rule: "R5", attempt: 1 });
  });

  it("R5: the pace of R3 holds a retry, and the wait tells the time", () => {
    const d = decision(facts({ ...red, behind: 5, lastPushAt: NOW - 2 * H, costMinutes: 30 }));
    expect(d).toMatchObject({ action: "wait", rule: "R5", until: NOW + 4 * H });
  });
});

describe("the decision table", () => {
  it("row 0: no open pull request pushes attempt 1 when the pace permits", () => {
    expect(decision(facts({ open: null, lastPushAt: NOW - 30 * H }))).toMatchObject({ action: "push", attempt: 1 });
  });

  it("row 0: no plan is due, so the train waits", () => {
    expect(decision(facts({ plan: null }))).toMatchObject({ action: "wait", rule: "legacy" });
  });

  it("row 1: an urgent update that is behind gets a new build", () => {
    expect(decision(facts({ urgent: true, behind: 2 }))).toMatchObject({ action: "push", rule: "urgent", rebuild: true });
  });

  it("row 1: an urgent update on the current default branch goes on to the merge", () => {
    expect(decision(facts({ urgent: true }))).toMatchObject({ action: "merge" });
  });

  it("row 2: the retry label builds once, past R3 and R5, and removes the label", () => {
    const d = decision(facts({ ci: { state: "failed", stuck: false }, open: { ...facts().open!, retryLabel: true, attempt: 2 }, lastPushAt: NOW - 60_000 }));
    expect(d).toMatchObject({ action: "push", rule: "label", attempt: 3, removeLabel: true, rebuild: true });
  });

  it("row 2: the retry label with a new plan gives attempt 1", () => {
    expect(decision(facts({ plan: { fingerprint: "fp2", items: ITEMS }, open: { ...facts().open!, retryLabel: true, attempt: 4 } }))).toMatchObject({ action: "push", attempt: 1 });
  });

  it("row 2: the retry label does not pass R1", () => {
    expect(decision(facts({ ci: { state: "running", stuck: false }, open: { ...facts().open!, retryLabel: true } }))).toMatchObject({ action: "wait", rule: "R1" });
  });

  it("row 3: CI runs, so the train waits", () => {
    expect(decision(facts({ ci: { state: "running", stuck: false } }))).toMatchObject({ action: "wait", rule: "R1" });
  });

  it("row 4a: stale pushes when the pace permits", () => {
    expect(decision(facts({ mergeable: false }))).toMatchObject({ action: "push", rule: "R2" });
  });

  it("row 4b: a monotone change of the plan merges the green candidate first", () => {
    const plan = { fingerprint: "fp2", items: [{ dep: "@acme/core", to: "1.3.0" }, { dep: "@acme/util", to: "2.0.0" }] };
    expect(decision(facts({ plan }))).toMatchObject({ action: "merge" });
  });

  it("row 4b: a change of the plan that is not monotone replaces the candidate", () => {
    const plan = { fingerprint: "fp2", items: [{ dep: "@acme/util", to: "2.0.0" }] };
    expect(decision(facts({ plan }))).toMatchObject({ action: "push", rule: "R3", attempt: 1, rebuild: false });
  });

  it("row 4b: a missing or empty items mark is no read, not monotone, and the reason tells it", () => {
    const plan = { fingerprint: "fp2", items: ITEMS };
    for (const items of [null, []]) {
      const d = decision(facts({ plan, open: { ...facts().open!, items } }));
      expect(d).toMatchObject({ action: "push", rule: "R3", attempt: 1, rebuild: false });
      expect(d.reason).toBe("the plan changed, and the candidate has no items mark, so the monotone check has no read");
    }
  });

  it("the attempt counts only the builds of the same plan after a red result", () => {
    const open = { ...facts().open!, attempt: 3, retryLabel: true };
    expect(decision(facts({ open }))).toMatchObject({ action: "push", rule: "label", attempt: 1 });
    expect(decision(facts({ open, ci: { state: "none", stuck: false } }))).toMatchObject({ action: "push", attempt: 1 });
    expect(decision(facts({ open, ci: { state: "failed", stuck: false } }))).toMatchObject({ action: "push", rule: "label", attempt: 4 });
    expect(decision(facts({ open, ci: { state: "failed", stuck: false }, plan: { fingerprint: "fp2", items: ITEMS } }))).toMatchObject({ action: "push", attempt: 1 });
  });

  it("row 4b: items that the train cannot read replace the candidate", () => {
    expect(decision(facts({ plan: { fingerprint: "fp2", items: ITEMS }, open: { ...facts().open!, items: null } }))).toMatchObject({ action: "push" });
    expect(decision(facts({ plan: { fingerprint: "fp2", items: null } }))).toMatchObject({ action: "push" });
  });

  it("row 4b: a sync replaces the candidate by default", () => {
    expect(decision(facts({ kind: "sync", plan: { fingerprint: "fp2", items: null }, open: { ...facts().open!, items: null } }))).toMatchObject({ action: "push", rule: "R3" });
  });

  it("row 4c: the yield", () => {
    expect(decision(facts({ otherRuns: 1 }))).toMatchObject({ action: "wait", rule: "R0" });
  });

  it("row 4d: a red default branch gives a new build", () => {
    expect(decision(facts({ behind: 1, mainHealth: { head: "red", redMerges: null } }))).toMatchObject({ action: "push", rule: "R4", rebuild: true });
  });

  it("row 4e: merge, behind or not", () => {
    expect(decision(facts({ behind: 0 }))).toMatchObject({ action: "merge" });
    expect(decision(facts({ behind: 500 }))).toMatchObject({ action: "merge" });
  });

  it("row 5: red or stuck, see R5", () => {
    expect(decision(facts({ ci: { state: "failed", stuck: false } }))).toMatchObject({ action: "wait", rule: "R5" });
    expect(decision(facts({ ci: { state: "running", stuck: true } }))).toMatchObject({ action: "wait", rule: "R5" });
    expect(decision(facts({ ci: { state: "running", stuck: true } })).reason).toContain("stuck");
  });

  it("row 6: no check started yet keeps the strict rule", () => {
    const none = { ci: { state: "none" as const, stuck: false } };
    expect(decision(facts(none))).toMatchObject({ action: "wait", rule: "legacy" });
    expect(decision(facts({ ...none, behind: 3 }))).toMatchObject({ action: "push", rule: "legacy", rebuild: true });
    expect(decision(facts({ ...none, plan: { fingerprint: "fp2", items: ITEMS } }))).toMatchObject({ action: "push", rule: "legacy", attempt: 1 });
  });
});

describe("the codes of the decisions", () => {
  const ci = (state: "none" | "failed" | "running") => ({ ci: { state, stuck: false } });
  const plan2 = { plan: { fingerprint: "fp2", items: ITEMS } };
  /** One case for each code: the code, the facts and the policy. */
  const cases: [CandidateCode, CandidateFacts, CandidatePolicy?][] = [
    ["no-plan", facts({ plan: null })],
    ["no-candidate", facts({ open: null, lastPushAt: null })],
    ["urgent-plan-changed", facts({ urgent: true, ...plan2 })],
    ["urgent-not-current", facts({ urgent: true, behind: 2 })],
    ["label-building", facts({ ...ci("running"), open: { ...facts().open!, retryLabel: true } })],
    ["label-retry", facts({ open: { ...facts().open!, retryLabel: true } })],
    ["building", facts(ci("running"))],
    ["merge-refused", facts({ behind: 3, mergeRefused: true })],
    ["not-mergeable", facts({ mergeable: false })],
    ["surface-list-cut", facts({ behind: 40, surfaceChanged: true, surfaceCut: true })],
    ["surface-changed", facts({ behind: 40, surfaceChanged: true })],
    ["plan-changed-no-items", facts({ ...plan2, open: { ...facts().open!, items: null } })],
    ["plan-changed", facts({ plan: { fingerprint: "fp2", items: [{ dep: "@acme/util", to: "2.0.0" }] } })],
    ["yield", facts({ otherRuns: 1 })],
    ["main-red", facts({ behind: 12, mainHealth: { head: "red", redMerges: null } })],
    ["red-merges-bound", facts({ behind: 12, mainHealth: { head: "green", redMerges: 3 } }), { ...P, redMainBound: 3 }],
    ["green-current", facts()],
    ["green-behind", facts({ behind: 40 })],
    ["green-behind-main-no-read", facts({ behind: 40, mainHealth: { head: "no-read", redMerges: null } })],
    ["no-check-plan-changed", facts({ ...ci("none"), ...plan2 })],
    ["no-check-behind", facts({ ...ci("none"), behind: 3 })],
    ["no-check", facts(ci("none"))],
    ["red-plan-changed", facts({ ...ci("failed"), ...plan2 })],
    ["red-current", facts({ ...ci("failed"), behind: 0 })],
    ["red-backoff", facts({ ...ci("failed"), behind: 5, open: { ...facts().open!, attempt: 3 }, lastPushAt: NOW - 2 * H })],
    ["red-retry", facts({ ...ci("failed"), behind: 5, open: { ...facts().open!, attempt: 3 }, lastPushAt: NOW - 5 * H })],
    ["red-pace-wait", facts({ ...ci("failed"), behind: 5, lastPushAt: NOW - 2 * H, costMinutes: 30 })],
    ["pace-wait", facts({ mergeable: false, lastPushAt: NOW - 30 * 60_000 })],
  ];

  it("gives each decision of the table its code", () => {
    for (const [code, f, p] of cases) expect([code, decision(f, p).code]).toEqual([code, code]);
  });

  it("reaches each code, and each code is a fixed id with no name and no number", () => {
    expect(cases.map(([code]) => code)).toEqual([...CANDIDATE_CODES]);
    for (const code of CANDIDATE_CODES) expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});

describe("decideWith", () => {
  it("stops with an error when the reader does not give the fact", async () => {
    const f = facts();
    delete f.ci;
    await expect(decideWith(P, f, async () => ({}))).rejects.toThrow("ci");
  });
});

describe("monotone", () => {
  const c = [{ dep: "a", to: "1.0.0" }, { dep: "@s/b", to: "2.1.0" }];

  it("gives true for the same or newer versions, also with more items", () => {
    expect(monotone(c, c)).toBe(true);
    expect(monotone(c, [{ dep: "a", to: "1.0.1" }, { dep: "@s/b", to: "3.0.0" }, { dep: "z", to: "1.0.0" }])).toBe(true);
  });

  it("gives false for a missing item, an older version or a version that is not valid", () => {
    expect(monotone(c, [{ dep: "a", to: "1.0.0" }])).toBe(false);
    expect(monotone(c, [{ dep: "a", to: "0.9.0" }, { dep: "@s/b", to: "2.1.0" }])).toBe(false);
    expect(monotone(c, [{ dep: "a", to: "latest" }, { dep: "@s/b", to: "2.1.0" }])).toBe(false);
  });
});

describe("the share", () => {
  it("gives the same number from 0 to 1 for the same label", () => {
    expect(shareOf("acme/data-repo")).toBe(shareOf("acme/data-repo"));
    expect(shareOf("acme/data-repo")).toBeGreaterThanOrEqual(0);
    expect(shareOf("acme/data-repo")).toBeLessThan(1);
    expect(shareOf("acme/data-repo")).not.toBe(shareOf("acme/web-repo"));
  });

  it("puts about the share of the repositories in the mode one-candidate", () => {
    const p = { ...P, share: 0.3 };
    const labels = Array.from({ length: 2000 }, (_, i) => `acme/repo-${i}`);
    const count = labels.filter((l) => modeFor(p, l) === "one-candidate").length;
    expect(count).toBeGreaterThan(500);
    expect(count).toBeLessThan(700);
  });

  it("keeps strict and shadow for each repository, and share 0 gives shadow", () => {
    expect(modeFor({ ...P, mode: "strict" }, "acme/x")).toBe("strict");
    expect(modeFor({ ...P, mode: "shadow" }, "acme/x")).toBe("shadow");
    expect(modeFor({ ...P, share: 0 }, "acme/x")).toBe("shadow");
    expect(modeFor({ ...P, share: 1 }, "acme/x")).toBe("one-candidate");
  });
});

describe("the marks", () => {
  it("writes and reads the attempt and the items", () => {
    const body = ["text", ...markLines({ attempt: 3, items: [{ dep: "@acme/core", to: "1.2.0" }, { dep: "left-pad", to: "2.0.0-rc.1" }] })].join("\n");
    expect(body).toContain("<!-- release-train:attempt=3 -->");
    expect(bodyAttempt(body)).toBe(3);
    expect(bodyItems(body)).toEqual([{ dep: "@acme/core", to: "1.2.0" }, { dep: "left-pad", to: "2.0.0-rc.1" }]);
  });

  it("gives attempt 1 and no items when the body has no mark", () => {
    expect(bodyAttempt("no marks")).toBe(1);
    expect(bodyAttempt(null)).toBe(1);
    expect(bodyItems("no marks")).toBeNull();
    expect(markLines({ attempt: 2 })).toHaveLength(1);
  });

  it("gives attempt 1 and no items for a damaged mark", () => {
    for (const b of ["<!-- release-train:attempt=x -->", "<!-- release-train:attempt=0 -->", "<!-- release-train:attempt=4", "<!-- release-train:attempt=-2 -->"]) expect(bodyAttempt(b)).toBe(1);
    for (const b of ["<!-- release-train:items=core -->", "<!-- release-train:items=@1.0.0 -->", "<!-- release-train:items=a@x -->", "<!-- release-train:items=a@1.0.0"]) expect(bodyItems(b)).toBeNull();
  });

  it("gives an empty list for an empty items mark", () => {
    expect(bodyItems("<!-- release-train:items= -->")).toEqual([]);
  });

  it("sorts the items and removes duplicates", () => {
    expect(candidateItems([{ dep: "b", to: "1.0.0" }, { dep: "a", to: "1.0.0" }, { dep: "b", to: "1.0.0" }])).toEqual([{ dep: "a", to: "1.0.0" }, { dep: "b", to: "1.0.0" }]);
  });

  it("gives the next attempt", () => {
    expect(nextAttempt(null, "fp", true, true)).toBe(1);
    expect(nextAttempt({ fingerprint: "old", attempt: 4 }, "fp", true, true)).toBe(1);
    expect(nextAttempt({ fingerprint: "fp", attempt: 4 }, "fp", true, true)).toBe(5);
    expect(nextAttempt({ fingerprint: "fp", attempt: 4 }, "fp", false, true)).toBe(4);
    // A push after a green result or a result that is not known starts at 1 again.
    expect(nextAttempt({ fingerprint: "fp", attempt: 4 }, "fp", true, false)).toBe(1);
  });
});

describe("jobMinutes", () => {
  const job = (seconds: number, labels: string[] = ["ubuntu-latest"]) => ({
    started_at: "2026-11-11T10:00:00Z",
    completed_at: new Date(Date.parse("2026-11-11T10:00:00Z") + seconds * 1000).toISOString(),
    labels,
    runner_name: "GitHub Actions 1",
  });

  it("gives runner minutes for a public repository", () => {
    expect(jobMinutes(job(90), false, NOW)).toBe(1.5);
  });

  it("gives billed minutes for a private repository", () => {
    expect(jobMinutes(job(90), true, NOW)).toBe(2);
    expect(jobMinutes(job(90, ["windows-latest"]), true, NOW)).toBe(4);
    expect(jobMinutes(job(61, ["macos-14"]), true, NOW)).toBe(20);
  });

  it("gives 0 for a job with no runner or a self-hosted runner", () => {
    expect(jobMinutes({ ...job(90), runner_name: null }, true, NOW)).toBe(0);
    expect(jobMinutes(job(90, ["self-hosted", "linux"]), true, NOW)).toBe(0);
  });

  it("gives 0 for a job of zero length, also after the round up of a private repository", () => {
    expect(jobMinutes(job(0), false, NOW)).toBe(0);
    expect(jobMinutes(job(0), true, NOW)).toBe(0);
    expect(jobMinutes(job(0, ["macos-14"]), true, NOW)).toBe(0);
  });

  it("counts a job that runs until now", () => {
    expect(jobMinutes({ ...job(0), completed_at: null }, false, Date.parse("2026-11-11T10:03:00Z"))).toBe(3);
  });
});

describe("commitHealth", () => {
  const run = (workflow_id: number, conclusion: string | null, created_at = "2026-11-11T10:00:00Z", status = "completed") => ({ workflow_id, created_at, status, conclusion });

  it("gives red, green, pending and no-read", () => {
    expect(commitHealth([run(1, "success"), run(2, "failure")])).toBe("red");
    expect(commitHealth([run(1, "success"), run(2, "skipped")])).toBe("green");
    expect(commitHealth([run(1, "success"), run(2, null, undefined, "in_progress")])).toBe("pending");
    expect(commitHealth([])).toBe("no-read");
    expect(commitHealth(null)).toBe("no-read");
    expect(commitHealth([run(1, "cancelled")])).toBe("no-read");
  });

  it("reads only the newest run of each workflow", () => {
    expect(commitHealth([run(1, "failure", "2026-11-11T10:00:00Z"), run(1, "success", "2026-11-11T11:00:00Z")])).toBe("green");
  });
});

/**
 * The replay: a made-up repository whose default branch gets a commit every few minutes, and whose plan changes every 25
 * minutes with newer versions of the same package. CI takes 30 minutes and costs 20 runner minutes, so the pace is 4 h.
 * The train runs every 15 minutes for 2 days.
 */
function replay(choice: PlanChangeChoice): { pushes: number; kept: number; minutes: number; merges: number } {
  const p: CandidatePolicy = { ...P, planChangeOnGreen: { update: choice, sync: choice } };
  const cost = 20;
  type Open = { fingerprint: string; items: CandidateItem[]; createdAt: number; doneAt: number; attempt: number };
  let open = null as Open | null;
  let lastPushAt: number | null = null;
  let mergedVersion = -1;
  let pushes = 0;
  let kept = 0;
  let merges = 0;
  const start = NOW;
  for (let t = start; t < start + 48 * H; t += 15 * 60_000) {
    const version = Math.floor((t - start) / (25 * 60_000));
    const items = [{ dep: "@acme/core", to: `1.${version}.0` }];
    const plan = version > mergedVersion ? { fingerprint: `fp${version}`, items } : null;
    const f: CandidateFacts = {
      kind: "update",
      private: false,
      now: t,
      urgent: false,
      only: false,
      yieldMaxHours: 24,
      plan,
      open: open && { fingerprint: open.fingerprint, attempt: open.attempt, items: open.items, createdAt: open.createdAt, retryLabel: false },
      ci: { state: open && t >= open.doneAt ? "green" : "running", stuck: false },
      mergeable: true,
      behind: Math.floor((t - start) / (4 * 60_000)) + 1,
      surfaceChanged: false,
      otherRuns: 0,
      lastPushAt,
      costMinutes: cost,
      mainHealth: { head: "green", redMerges: null },
    };
    const d = decision(f, p);
    if (d.action === "push" && plan) {
      pushes++;
      open = { fingerprint: plan.fingerprint, items: plan.items, createdAt: open?.createdAt ?? t, doneAt: t + 30 * 60_000, attempt: d.attempt ?? 1 };
      lastPushAt = t;
    } else if (d.action === "merge" && open) {
      merges++;
      kept++;
      mergedVersion = Number(open.fingerprint.slice(2));
      open = null;
    }
  }
  return { pushes, kept, minutes: pushes * cost, merges };
}

describe("the replay of planChangeOnGreen", () => {
  it("merge-first merges each push that it keeps, and replace merges none, for the same runner minutes", () => {
    const first = replay("merge-first-when-monotone");
    const replace = replay("replace");
    expect(first.merges).toBeGreaterThan(replace.merges);
    expect(first.kept / first.pushes).toBeGreaterThan(replace.kept / Math.max(1, replace.pushes));
    // The numbers of the report: the same pushes and runner minutes, but replace never merges, because each new plan
    // arrives while the replacement waits for the pace.
    expect(first).toEqual({ pushes: 12, kept: 12, minutes: 240, merges: 12 });
    expect(replace).toEqual({ pushes: 12, kept: 0, minutes: 240, merges: 0 });
  });
});
