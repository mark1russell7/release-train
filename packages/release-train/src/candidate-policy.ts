import { createHash } from "node:crypto";
import semver from "semver";
import type { CiState } from "./apply.ts";

/**
 * The mode of the candidate rules. `strict`: the rules of the code before the candidate rules. `shadow`: the train acts as in
 * `strict` and logs the decision of the candidate rules next to its own action. `one-candidate`: the candidate rules act.
 */
export type CandidateMode = "strict" | "shadow" | "one-candidate";

/** The choice for a green candidate when the plan changes: merge it first when the change is monotone, or replace it. */
export type PlanChangeChoice = "merge-first-when-monotone" | "replace";

/** The kind of a train branch: the update branch or the branch of the template sync. */
export type CandidateKind = "update" | "sync";

/** The policy of the candidates of a train branch, as data. The function `decide` reads it. */
export interface CandidatePolicy {
  readonly mode: CandidateMode;
  /** The part of the repositories (0 to 1) that gets the rules of mode `one-candidate`. The other repositories stay in `shadow`. */
  readonly share: number;
  /** The runner minutes in one hour that a public repository can use for the candidates of one branch. */
  readonly ratePublic: number;
  /** The billed minutes in one hour that a private repository can use for the candidates of one branch. */
  readonly ratePrivate: number;
  /** The shortest time between two pushes of one branch, in hours. */
  readonly paceFloorHours: number;
  /** The longest time between two pushes of one branch, in hours. */
  readonly paceCeilHours: number;
  /** The wait before the first new build of a red candidate, in hours. The wait doubles on each try. */
  readonly backoffBaseHours: number;
  /** The longest wait before a new build of a red candidate, in hours. */
  readonly backoffCeilHours: number;
  /** A workflow run that is queued or in progress for more hours than this is stuck. A stuck run is not "building". */
  readonly stuckCiHours: number;
  /** The cost of the last candidate when the train cannot read it, in minutes. */
  readonly costWhenNoReadMinutes: number;
  /** The choice for a green candidate when the plan changes, for each kind of branch. */
  readonly planChangeOnGreen: { readonly update: PlanChangeChoice; readonly sync: PlanChangeChoice };
  /**
   * The count of red train merges in the window at which a repository goes back to the strict rule. Then a green candidate
   * that is behind gets a new build. Null: the rule has no bound, and the train does not read the count.
   */
  readonly redMainBound: number | null;
  /** The days of the window of the count of red train merges. */
  readonly redMainWindowDays: number;
  /** The label that asks for one new build of a candidate. The train removes it after the build. */
  readonly retryLabel: string;
}

/** The policy of the train. This version logs the decisions of the candidate rules and does not act on them. */
export const CANDIDATE_POLICY: CandidatePolicy = {
  mode: "shadow",
  share: 1,
  ratePublic: 5,
  ratePrivate: 1,
  paceFloorHours: 1,
  paceCeilHours: 24,
  backoffBaseHours: 1,
  backoffCeilHours: 24,
  stuckCiHours: 6,
  costWhenNoReadMinutes: 10,
  planChangeOnGreen: { update: "merge-first-when-monotone", sync: "replace" },
  redMainBound: null,
  redMainWindowDays: 30,
  retryLabel: "release-train:retry",
};

/** One item of a candidate: a package and its target version. */
export interface CandidateItem {
  dep: string;
  to: string;
}

/** The CI state of a candidate. `stuck` is true when only runs older than `stuckCiHours` keep the state at `running`. */
export interface CandidateCi {
  state: CiState;
  stuck: boolean;
}

/** The CI result of one commit of the default branch. `no-read`: the commit has no workflow run that tells a result. */
export type CommitHealth = "red" | "green" | "pending" | "no-read";

/**
 * The facts of rule R4 for one candidate. Each value counts only the workflows of the head of the candidate. A workflow
 * that runs only on the default branch, for example a release workflow, does not count.
 */
export interface MainHealth {
  /** The CI result of the head of the default branch, from the workflows of the candidate. */
  head: CommitHealth;
  /**
   * The count of red merge commits of train pull requests in the window of the policy, from the workflows of the
   * candidate. Null when the policy has no bound, or when the train has no read of the workflows of the candidate.
   */
  redMerges: number | null;
}

/** The facts of the open candidate of a branch, from the pull request. */
export interface OpenCandidate {
  /** The fingerprint in the body, or null when the body has none. */
  fingerprint: string | null;
  /** The number of the try in the `attempt` mark of the body. A body with no mark gives 1. */
  attempt: number;
  /** The items in the body, or null when the body has no readable items mark. */
  items: CandidateItem[] | null;
  /** The time when GitHub opened the pull request, in milliseconds, or null when it is not known. */
  createdAt: number | null;
  /** This value is true when the pull request has the retry label of the policy. */
  retryLabel: boolean;
}

/**
 * The facts of one branch of one repository at one run. A field with the value undefined is not read yet. The function
 * `decide` asks for it with a need. The caller reads the fact and uses `decide` again.
 */
export interface CandidateFacts {
  kind: CandidateKind;
  private: boolean;
  /** The time of the run, in milliseconds. */
  now: number;
  /** This value is true when the update changes a package that a person named as urgent. */
  urgent: boolean;
  /** This value is true when the input `only` of the run names the repository. */
  only: boolean;
  /** The longest yield of a green candidate to the runs of other branches, in hours. */
  yieldMaxHours: number;
  /** The plan of this run for the branch, or null when no plan is due. */
  plan: { fingerprint: string; items: CandidateItem[] | null } | null;
  /** The open candidate, or null when the branch has no open pull request. */
  open: OpenCandidate | null;
  ci?: CandidateCi;
  /** False when GitHub cannot merge the candidate. Null when GitHub does not know yet. */
  mergeable?: boolean | null;
  /** The count of commits of the default branch that are not in the candidate. Null when the read failed. */
  behind?: number | null;
  /** True when the default branch changed a file of the surface of the candidate since the merge base. */
  surfaceChanged?: boolean;
  /** True when GitHub cut a list of files of the surface check short. Then `surfaceChanged` is true, and the check has no read. */
  surfaceCut?: boolean;
  /** The count of the workflow runs of other branches that are queued or in progress. A run older than `stuckCiHours` does not count. */
  otherRuns?: number;
  /** The time of the last push of the last candidate, in milliseconds. Null when the branch had no candidate before. */
  lastPushAt?: number | null;
  /** The runner minutes of the workflow jobs of the last candidate. Null when the read failed. */
  costMinutes?: number | null;
  mainHealth?: MainHealth;
  /** True when GitHub refused the merge of the candidate in this run. */
  mergeRefused?: boolean;
}

/** A fact that `decide` needs before it can decide. */
export type CandidateNeed = "ci" | "mergeable" | "behind" | "surface" | "otherRuns" | "lastPush" | "cost" | "mainHealth";

/** The rule that made a decision. */
export type CandidateRule = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "urgent" | "label" | "legacy";

/**
 * The codes of the decisions: a short fixed id for each place in `decide` that makes a decision, in the order of its steps.
 * A code has no name and no number, so the log of a private repository can show it.
 */
export const CANDIDATE_CODES = [
  "no-plan",
  "no-candidate",
  "urgent-plan-changed",
  "urgent-not-current",
  "label-building",
  "label-retry",
  "building",
  "merge-refused",
  "not-mergeable",
  "surface-cut",
  "surface-changed",
  "plan-changed-no-items",
  "plan-changed",
  "yield",
  "main-red",
  "red-merges-bound",
  "green-current",
  "green-behind",
  "no-check-plan-changed",
  "no-check-behind",
  "no-check",
  "red-plan-changed",
  "red-current",
  "red-backoff",
  "red-retry",
  "red-pace-wait",
  "pace-wait",
] as const;

/** The code of a decision. Refer to `CANDIDATE_CODES`. */
export type CandidateCode = (typeof CANDIDATE_CODES)[number];

/** The decision of the candidate rules for one branch. */
export interface CandidateDecision {
  action: "push" | "merge" | "wait";
  rule: CandidateRule;
  /** The code of the place in `decide` that made the decision. The log of a private repository shows it and not the reason. */
  code: CandidateCode;
  reason: string;
  /** A push: the number of the try in the `attempt` mark of the new body. */
  attempt?: number;
  /** A push: true when the train removes the retry label after the push. */
  removeLabel?: boolean;
  /** A push: true when the branch must get a new commit, also with the same files. */
  rebuild?: boolean;
  /** A wait: the time of the next step, in milliseconds, when it is known. */
  until?: number;
}

/** One step of `decide`: a need or a decision. */
export type CandidateStep = { need: CandidateNeed } | { decision: CandidateDecision };

const HOUR_MS = 3_600_000;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** This function gives a time in milliseconds as an ISO text for a reason. */
function at(ms: number): string {
  return new Date(ms).toISOString();
}

/** This function gives the pace of a branch in hours: `clamp(cost / rate, floor, ceil)`. A cost that is not known uses the policy value. */
export function paceHours(p: CandidatePolicy, costMinutes: number | null, isPrivate: boolean): number {
  const cost = costMinutes ?? p.costWhenNoReadMinutes;
  const rate = isPrivate ? p.ratePrivate : p.ratePublic;
  return clamp(cost / rate, p.paceFloorHours, p.paceCeilHours);
}

/** This function gives the wait before a new build of a red candidate, in hours: `clamp(base * 2^(attempt - 1), base, ceil)`. */
export function backoffHours(p: CandidatePolicy, attempt: number): number {
  return clamp(p.backoffBaseHours * 2 ** (Math.max(1, attempt) - 1), p.backoffBaseHours, p.backoffCeilHours);
}

type PaceCheck = { need: CandidateNeed } | { ok: true } | { ok: false; until: number };

/**
 * This function applies rule R3 to a push. The cost is read only when the time since the last push is between the floor
 * and the ceiling. Below the floor, the time of the next push is at least the floor.
 */
function paceCheck(p: CandidatePolicy, f: CandidateFacts): PaceCheck {
  if (f.lastPushAt === undefined) return { need: "lastPush" };
  if (f.lastPushAt === null) return { ok: true };
  const since = f.now - f.lastPushAt;
  if (since >= p.paceCeilHours * HOUR_MS) return { ok: true };
  if (since < p.paceFloorHours * HOUR_MS) return { ok: false, until: f.lastPushAt + p.paceFloorHours * HOUR_MS };
  if (f.costMinutes === undefined) return { need: "cost" };
  const next = f.lastPushAt + paceHours(p, f.costMinutes, f.private) * HOUR_MS;
  return f.now >= next ? { ok: true } : { ok: false, until: next };
}

/** This function gives the push when the pace of rule R3 permits it, and else a wait of rule R3. `urgent` and `only` pass the pace. */
function paced(p: CandidatePolicy, f: CandidateFacts, d: CandidateDecision): CandidateStep {
  if (f.urgent || f.only) return { decision: d };
  const c = paceCheck(p, f);
  if ("need" in c) return c;
  if (c.ok) return { decision: d };
  return { decision: { action: "wait", rule: "R3", code: "pace-wait", reason: `${d.reason}, but the pace of the branch permits the next push at ${at(c.until)}`, until: c.until } };
}

/**
 * This function tells if a change of the plan is monotone. Monotone: each item of the candidate is in the plan with the
 * same version or a newer version. A missing item, a held item or an older version gives false.
 */
export function monotone(candidate: readonly CandidateItem[], plan: readonly CandidateItem[]): boolean {
  return candidate.every((c) => plan.some((x) => x.dep === c.dep && semver.valid(x.to) !== null && semver.valid(c.to) !== null && semver.gte(x.to, c.to)));
}

/**
 * This function gives the decision of the candidate rules for one branch, or the fact that it needs first. It has no I/O
 * and no clock: the time is the fact `now`. The steps follow the decision table of the policy.
 */
export function decide(p: CandidatePolicy, f: CandidateFacts): CandidateStep {
  const done = (d: CandidateDecision): CandidateStep => ({ decision: d });
  if (f.plan === null) return done({ action: "wait", rule: "legacy", code: "no-plan", reason: "no plan is due for the branch" });
  const o = f.open;
  // Step 0: no open pull request.
  if (o === null) return paced(p, f, { action: "push", rule: f.urgent ? "urgent" : "R3", code: "no-candidate", reason: "the branch has no open candidate", attempt: 1, rebuild: false });
  const planChanged = o.fingerprint !== f.plan.fingerprint;
  // Step 1: an urgent update pushes as the strict rule does. Its CI is not read yet, so its new build is attempt 1.
  if (f.urgent) {
    if (planChanged) return done({ action: "push", rule: "urgent", code: "urgent-plan-changed", reason: "an urgent update with a new plan", attempt: 1, rebuild: false });
    if (f.mergeable === undefined) return { need: "mergeable" };
    if (f.behind === undefined) return { need: "behind" };
    if (f.mergeable === false || (f.behind ?? 0) > 0) return done({ action: "push", rule: "urgent", code: "urgent-not-current", reason: "an urgent update that is not on the current default branch", attempt: buildAttempt(o, planChanged, f.ci), rebuild: true });
  }
  if (f.ci === undefined) return { need: "ci" };
  const building = f.ci.state === "running" && !f.ci.stuck;
  const next = buildAttempt(o, planChanged, f.ci);
  // Step 2: the retry label passes R3 and R5, but not R1.
  if (o.retryLabel) {
    if (building) return done({ action: "wait", rule: "R1", code: "label-building", reason: `building: the label ${p.retryLabel} waits for the end of CI` });
    return done({ action: "push", rule: "label", code: "label-retry", reason: `the label ${p.retryLabel} asks for a new build`, attempt: next, removeLabel: true, rebuild: true });
  }
  // Step 3: no push while CI runs.
  if (building) return done({ action: "wait", rule: "R1", code: "building", reason: "building" });
  if (f.ci.state === "green") return green(p, f, o, planChanged, next);
  if (f.ci.state === "none") return noCheck(f, planChanged, next);
  return red(p, f, o, planChanged, next);
}

/**
 * This function gives the number of the try of a new build of a candidate. The number counts the builds of the same
 * plan that follow a red result. A new plan, or a build after a green result or a result that is not known, gives 1.
 */
function buildAttempt(o: OpenCandidate, planChanged: boolean, ci: CandidateCi | undefined): number {
  return !planChanged && ci?.state === "failed" ? o.attempt + 1 : 1;
}

/** Step 4 of the table: a green candidate. */
function green(p: CandidatePolicy, f: CandidateFacts, o: OpenCandidate, planChanged: boolean, next: number): CandidateStep {
  const stale = (code: CandidateCode, reason: string): CandidateStep => paced(p, f, { action: "push", rule: "R2", code, reason, attempt: next, rebuild: true });
  // 4a: R2, exact staleness.
  if (f.mergeRefused) return stale("merge-refused", "GitHub refused the merge of the candidate");
  if (f.mergeable === undefined) return { need: "mergeable" };
  if (f.mergeable === false) return stale("not-mergeable", "GitHub cannot merge the candidate");
  if (f.behind === undefined) return { need: "behind" };
  const behind = f.behind === null || f.behind > 0;
  if (behind) {
    if (f.surfaceChanged === undefined) return { need: "surface" };
    if (f.surfaceChanged && f.surfaceCut) return stale("surface-cut", "GitHub cut a list of files of the surface check at 300 files, so the check has no read and counts a change");
    if (f.surfaceChanged) return stale("surface-changed", "the default branch changed a file of the surface of the candidate");
  }
  // 4b: a change of the plan. A missing or empty items mark gives no read, and no read is not monotone.
  if (planChanged && f.plan) {
    const choice = p.planChangeOnGreen[f.kind];
    if (choice === "merge-first-when-monotone" && (o.items === null || o.items.length === 0)) {
      return paced(p, f, { action: "push", rule: "R3", code: "plan-changed-no-items", reason: "the plan changed, and the candidate has no items mark, so the monotone check has no read", attempt: 1, rebuild: false });
    }
    const first = choice === "merge-first-when-monotone" && o.items !== null && f.plan.items !== null && monotone(o.items, f.plan.items);
    if (!first) return paced(p, f, { action: "push", rule: "R3", code: "plan-changed", reason: "the plan changed, and the candidate goes out of date", attempt: 1, rebuild: false });
  }
  // 4c: R0, the yield.
  const ageHours = o.createdAt === null ? 0 : (f.now - o.createdAt) / HOUR_MS;
  if (ageHours < f.yieldMaxHours) {
    if (f.otherRuns === undefined) return { need: "otherRuns" };
    if (f.otherRuns > 0) return { decision: { action: "wait", rule: "R0", code: "yield", reason: `green, but ${f.otherRuns} workflow run(s) of other branches are not done` } };
  }
  // 4d: R4, the red default branch.
  let note = "";
  if (behind) {
    if (f.mainHealth === undefined) return { need: "mainHealth" };
    const h = f.mainHealth;
    // A red head gives a new build on the default branch, not a wait. R3 paces the push, and R5 holds a red result.
    if (h.head === "red") return paced(p, f, { action: "push", rule: "R4", code: "main-red", reason: "the default branch is red in the checks of the candidate, so the candidate gets a new build on it", attempt: next, rebuild: true });
    if (p.redMainBound !== null && h.redMerges !== null && h.redMerges >= p.redMainBound) {
      return paced(p, f, { action: "push", rule: "R4", code: "red-merges-bound", reason: `${h.redMerges} red train merges in ${p.redMainWindowDays} days, so the strict rule builds a candidate that is behind`, attempt: next, rebuild: true });
    }
    if (h.head === "no-read") note = ", and the default branch has no CI result (no read)";
  }
  // 4e: the merge.
  const where = behind ? `green and ${f.behind ?? "some"} commit(s) behind, with no change of its surface` : "green on the current default branch";
  return { decision: { action: "merge", rule: "R2", code: behind ? "green-behind" : "green-current", reason: `${where}${planChanged ? ", and the plan change is monotone" : ""}${note}` } };
}

/**
 * Step 6 of the table: no check started yet. A changed plan gives a push. A candidate that GitHub cannot merge, or that
 * is behind, gives a push with a new build. Else the candidate waits. In the mode `one-candidate`, a wait keeps the open
 * candidate, and the train does not start the updater for it. So the train does not push a new build of the same plan.
 */
function noCheck(f: CandidateFacts, planChanged: boolean, next: number): CandidateStep {
  if (planChanged) return { decision: { action: "push", rule: "legacy", code: "no-check-plan-changed", reason: "no check started yet, and the plan changed", attempt: 1, rebuild: false } };
  if (f.mergeable === undefined) return { need: "mergeable" };
  if (f.behind === undefined) return { need: "behind" };
  if (f.mergeable === false || (f.behind ?? 0) > 0) return { decision: { action: "push", rule: "legacy", code: "no-check-behind", reason: "no check started yet, and the candidate is not on the current default branch", attempt: next, rebuild: true } };
  return { decision: { action: "wait", rule: "legacy", code: "no-check", reason: "no check started yet" } };
}

/** Step 5 of the table: a red candidate, or a candidate with stuck CI. */
function red(p: CandidatePolicy, f: CandidateFacts, o: OpenCandidate, planChanged: boolean, next: number): CandidateStep {
  const what = f.ci?.stuck ? "CI is stuck" : "red";
  const hint = `or add the label ${p.retryLabel}`;
  // 5a: a new plan.
  if (planChanged) return paced(p, f, { action: "push", rule: "R5", code: "red-plan-changed", reason: `${what}, and the plan changed`, attempt: 1, rebuild: false });
  // 5b: the default branch moved, the backoff passed and the pace permits.
  if (f.behind === undefined) return { need: "behind" };
  if (f.behind === null || f.behind === 0) return { decision: { action: "wait", rule: "R5", code: "red-current", reason: `${what}: the next build comes after the default branch moves, ${hint}` } };
  if (f.lastPushAt === undefined) return { need: "lastPush" };
  const backoffAt = f.lastPushAt === null ? f.now : f.lastPushAt + backoffHours(p, o.attempt) * HOUR_MS;
  if (f.now < backoffAt) return { decision: { action: "wait", rule: "R5", code: "red-backoff", reason: `${what}: next retry at ${at(backoffAt)}, ${hint}`, until: backoffAt } };
  const step = paced(p, f, { action: "push", rule: "R5", code: "red-retry", reason: `${what}, the default branch moved and the wait of attempt ${o.attempt} passed`, attempt: next, rebuild: true });
  if ("decision" in step && step.decision.action === "wait" && step.decision.until !== undefined) {
    return { decision: { action: "wait", rule: "R5", code: "red-pace-wait", reason: `${what}: next retry at ${at(step.decision.until)}, ${hint}`, until: step.decision.until } };
  }
  return step;
}

/** The field of the facts that each need fills. */
const FIELD: Record<CandidateNeed, keyof CandidateFacts> = {
  ci: "ci",
  mergeable: "mergeable",
  behind: "behind",
  surface: "surfaceChanged",
  otherRuns: "otherRuns",
  lastPush: "lastPushAt",
  cost: "costMinutes",
  mainHealth: "mainHealth",
};

/** The result of `decideWith`: the decision, the facts at the end and the needs in the order of their reads. */
export interface DecideResult {
  decision: CandidateDecision;
  facts: CandidateFacts;
  needs: CandidateNeed[];
}

/**
 * This function uses `decide` until it gives a decision. For each need, it uses `read` and adds the fact. A reader that
 * does not give the fact stops the loop with an error.
 */
export async function decideWith(p: CandidatePolicy, facts: CandidateFacts, read: (need: CandidateNeed, f: CandidateFacts) => Promise<Partial<CandidateFacts>>): Promise<DecideResult> {
  let f = facts;
  const needs: CandidateNeed[] = [];
  for (let i = 0; i <= Object.keys(FIELD).length; i++) {
    const step = decide(p, f);
    if ("decision" in step) return { decision: step.decision, facts: f, needs };
    needs.push(step.need);
    const add = await read(step.need, f);
    if (add[FIELD[step.need]] === undefined) throw new Error(`The reader did not give the fact ${step.need}.`);
    f = { ...f, ...add };
  }
  throw new Error(`The candidate rules asked for too many facts: ${needs.join(", ")}.`);
}

/**
 * This function gives the share value of a label: a deterministic number from 0 to 1. The label is the name that the log
 * uses, so a private repository gives its hash and no name.
 */
export function shareOf(label: string): number {
  return Number.parseInt(createHash("sha256").update(label).digest("hex").slice(0, 8), 16) / 2 ** 32;
}

/** This function gives the mode of the candidate rules for a repository, from the policy and the label of the repository. */
export function modeFor(p: CandidatePolicy, label: string): CandidateMode {
  if (p.mode !== "one-candidate") return p.mode;
  return shareOf(label) < p.share ? "one-candidate" : "shadow";
}

const ATTEMPT_MARK = "<!-- release-train:attempt=";
const ITEMS_MARK = "<!-- release-train:items=";
const END = " -->";

/** The marks of a candidate in the body of its pull request. */
export interface CandidateMarks {
  attempt: number;
  /** The items of an update candidate. Absent: the body gets no items mark. */
  items?: readonly CandidateItem[];
}

/** This function gives the items of an update as a sorted list with no duplicates. */
export function candidateItems(items: readonly { dep: string; to: string }[]): CandidateItem[] {
  const keys = [...new Set(items.map((i) => `${i.dep}@${i.to}`))].sort();
  return keys.map((k) => {
    const cut = k.lastIndexOf("@");
    return { dep: k.slice(0, cut), to: k.slice(cut + 1) };
  });
}

/** This function gives the mark lines of a candidate. The train writes them next to the fingerprint mark. */
export function markLines(m: CandidateMarks): string[] {
  const lines = [`${ATTEMPT_MARK}${Math.max(1, Math.floor(m.attempt))}${END}`];
  if (m.items) lines.push(`${ITEMS_MARK}${candidateItems(m.items).map((i) => `${i.dep}@${i.to}`).join(",")}${END}`);
  return lines;
}

/** This function gives the text of a mark, or null when the body has no complete mark. */
function markText(body: string | null | undefined, mark: string): string | null {
  const i = body?.indexOf(mark) ?? -1;
  if (!body || i < 0) return null;
  const rest = body.slice(i + mark.length);
  const end = rest.indexOf(END);
  return end < 0 ? null : rest.slice(0, end);
}

/** This function gives the number of the try in the `attempt` mark of a body. No mark, or a damaged mark, gives 1. */
export function bodyAttempt(body: string | null | undefined): number {
  const text = markText(body, ATTEMPT_MARK);
  if (text === null || !/^[1-9]\d{0,5}$/.test(text)) return 1;
  return Number(text);
}

/** This function gives the items in the body of a pull request, or null when the body has no mark or a damaged mark. */
export function bodyItems(body: string | null | undefined): CandidateItem[] | null {
  const text = markText(body, ITEMS_MARK);
  if (text === null) return null;
  if (text === "") return [];
  const items: CandidateItem[] = [];
  for (const part of text.split(",")) {
    const cut = part.lastIndexOf("@");
    const dep = part.slice(0, cut);
    const to = part.slice(cut + 1);
    if (cut <= 0 || !/^(@[\w.-]+\/)?[\w.-]+$/.test(dep) || semver.valid(to) === null) return null;
    items.push({ dep, to });
  }
  return items;
}

/**
 * This function gives the number of the try for the `attempt` mark of a new body. A new candidate or a new plan gives 1.
 * A push of the same plan after a red result adds 1. A push after a green result or a result that is not known gives 1.
 * A body with no push keeps its number.
 */
export function nextAttempt(open: { fingerprint: string | null; attempt: number } | null, fingerprint: string, pushed: boolean, red: boolean): number {
  if (!open || open.fingerprint !== fingerprint) return 1;
  if (!pushed) return open.attempt;
  return red ? open.attempt + 1 : 1;
}

/** One job of a workflow run, as far as the cost reads it. */
export interface JobCost {
  started_at?: string | null;
  completed_at?: string | null;
  labels?: string[];
  runner_name?: string | null;
}

/**
 * This function gives the minutes of one job. A job with no runner, or a job on a self-hosted runner, gives 0. A private
 * repository gives billed minutes: each job is rounded up to a full minute, times 2 on Windows and times 10 on macOS.
 */
export function jobMinutes(job: JobCost, isPrivate: boolean, now: number): number {
  if (!job.runner_name || !job.started_at) return 0;
  const labels = (job.labels ?? []).map((l) => l.toLowerCase());
  if (labels.includes("self-hosted")) return 0;
  const end = job.completed_at ? Date.parse(job.completed_at) : now;
  const minutes = Math.max(0, end - Date.parse(job.started_at)) / 60_000;
  if (Number.isNaN(minutes)) return 0;
  // A job of zero length got no runner time, so GitHub bills nothing for it. Thus it stays at 0, also after the round up below.
  if (!isPrivate) return minutes;
  const factor = labels.some((l) => l.startsWith("macos")) ? 10 : labels.some((l) => l.startsWith("windows")) ? 2 : 1;
  return Math.ceil(minutes) * factor;
}

/** A workflow run of a commit, as far as `commitHealth` reads it. */
export interface RunHealth {
  workflow_id: number;
  created_at: string;
  status?: string;
  conclusion?: string | null;
}

/**
 * This function gives the CI result of a commit from the newest run of each workflow. A failure, a time out or a failed
 * start gives `red`. A cancelled run tells no result, because a newer push of a busy branch cancels runs.
 */
export function commitHealth(runs: readonly RunHealth[] | null | undefined): CommitHealth {
  const newest = new Map<number, RunHealth>();
  for (const r of runs ?? []) {
    const seen = newest.get(r.workflow_id);
    if (!seen || r.created_at > seen.created_at) newest.set(r.workflow_id, r);
  }
  const list = [...newest.values()];
  if (list.some((r) => r.status === "completed" && ["failure", "timed_out", "startup_failure"].includes(r.conclusion ?? ""))) return "red";
  if (list.some((r) => r.status !== "completed")) return "pending";
  return list.some((r) => r.conclusion === "success") ? "green" : "no-read";
}

/** The lockfile of pnpm, and the files that change how pnpm reads it. */
const LOCK_FILES = ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"];

/**
 * This function tells if the default branch changed a file of the surface of a candidate. The surface is the files of the
 * candidate, and the files of pnpm when the candidate changes the lockfile. A list that GitHub cut short counts as a change.
 */
export function surfaceChanged(candidate: { files: readonly string[]; cut: boolean }, main: { files: readonly string[]; cut: boolean }): boolean {
  if (candidate.cut || main.cut) return true;
  const surface = new Set(candidate.files);
  if (candidate.files.some((f) => f === "pnpm-lock.yaml" || f.endsWith("/pnpm-lock.yaml"))) for (const f of LOCK_FILES) surface.add(f);
  return main.files.some((f) => surface.has(f));
}
