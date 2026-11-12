import { createHash, createHmac } from "node:crypto";
import semver from "semver";
import { candidateReader } from "./candidate-facts.ts";
import type { CandidateTarget } from "./candidate-facts.ts";
import { CANDIDATE_POLICY, bodyAttempt, bodyItems, candidateItems, decide, decideWith, markLines, modeFor, nextAttempt } from "./candidate-policy.ts";
import type { CandidateCode, CandidateDecision, CandidateFacts, CandidateItem, CandidateKind, CandidateMode, CandidatePolicy, CandidateRule, DecideResult } from "./candidate-policy.ts";
import { pool } from "./collect.ts";
import { rateLimitLine } from "./github.ts";
import type { GitHub, RateLimitReport } from "./github.ts";
import { holdsUpdate } from "./holds.ts";
import type { LagHold } from "./holds.ts";
import { adoptWhy, moveSets } from "./plan.ts";
import type { Action, ActionItem, Plan } from "./plan.ts";
import type { DepType, LockKind } from "./types.ts";
import { ownScopes } from "./settings.ts";
import { SYNC_BRANCH, SYNC_KIND, SYNC_RULES, SYNC_TITLE, TEMPLATE_REPO, apiFiles, renovateDays, syncBody, syncNeeds, syncRepo } from "./sync.ts";
import type { RepoFiles, RunFacts, SyncFacts, SyncPush, SyncResult, SyncRule, SyncUpdater, WorkflowsMode } from "./sync.ts";

/** The branch of each pull request of the release train. */
export const TRAIN_BRANCH = "release-train/update";
/** The label of each pull request of the release train. */
export const TRAIN_LABEL = "release-train";
/** The label of a pull request of the release train with a failed CI. */
export const BLOCKED_LABEL = "release-train:blocked";
/**
 * The label of a pull request of another author that only the train merges, for example a Renovate pin of a workflow action.
 * The train merges it on green CI with the holds of its own pull requests. A branch that is behind the default branch
 * waits for a rebase. A change of a workflow file waits while a release run of the default branch is not done.
 */
export const MERGE_LABEL = "train-merge";
/** The kind of the result of a pull request with the label `MERGE_LABEL`. */
export const MERGE_KIND = "train-merge";
/** The unchecked rebase box of a Renovate pull request body. A tick asks Renovate to rebase the branch. */
export const RENOVATE_REBASE_BOX = "- [ ] <!-- rebase-check -->";
/** The last line of each pull request body of the release train. */
export const CLAUDE_LINE = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

const MARK = "<!-- release-train:fingerprint=";
/** The train adds this mark to the body of a pull request that it closes itself, so a closed train pull request is not "declined". */
const CLOSED_MARK = "<!-- release-train:closed-by-train -->";

/**
 * The longest time that a green pull request of the train waits for the workflow runs of other branches, in hours.
 * After it, the train merges, so a repository whose CI is always busy still gets its updates.
 */
export const YIELD_MAX_HOURS = 24;

/** The folder of the workflow files. A merge that changes a file in it waits while a release run of the repository is not done. */
export const WORKFLOWS_DIR = ".github/workflows/";

/** The most files that the compare API of GitHub lists. A list of this length can leave out files. */
export const COMPARE_FILES_MAX = 300;

/** One dependency change of an update. */
export interface UpdateItem {
  path: string;
  dependent: string | null;
  dep: string;
  type: DepType;
  range: string;
  /** The new range of a breaking adoption. It is null for a lockfile update. */
  newRange: string | null;
  /** The version in the lockfile before the update. */
  from: string | null;
  to: string;
  why: string;
}

/** The items of an adoption that stay for a later run. The names are only in the pull request of the repository. */
export interface HeldItems {
  /** The count of the items. */
  items: number;
  /** The packages of the items. */
  deps: string[];
}

/** The combined update of one repository: one branch and one pull request. */
export interface RepoUpdate {
  repo: string;
  private: boolean;
  actionId: string;
  /** "settings" is an update of the pnpm settings only, with no items. */
  kind: "adopt-in-range" | "adopt-breaking" | "settings";
  wave: number;
  why: string;
  lockKind: LockKind;
  /** The git submodules in the folders of the workspace. The train cannot install such a workspace from its clone. */
  submodules?: string[];
  items: UpdateItem[];
  /** The items of the action that stay for a later run. Not set: the update has all items of the action. */
  held?: HeldItems;
  /** The published packages of the repository that release with this update: the train adds their version bump. */
  releases?: ReleaseItem[];
  /** The scopes that the update puts into `minimumReleaseAgeExclude` of pnpm, or null when the settings need no change. */
  ageScopes?: string[] | null;
  /** The packages of the update that a person named as urgent. A young version of such a package does not wait. */
  urgentDeps?: string[];
  fingerprint: string;
}

/** A published package that must release because a dependency range changes in a breaking way. */
export interface ReleaseItem {
  name: string;
  path: string;
  /** The version on npm. */
  from: string;
  /** The changed dependencies of the package and the section of each range. */
  changes: { dep: string; type: string }[];
}

/** A version bump that the updater added: a changeset, or a new version in `package.json`. */
export interface ReleaseDone {
  name: string;
  from: string;
  to: string;
  type: "patch" | "minor" | "major";
  why: string;
  via: "changeset" | "version";
}

/** An adoption with no item that can go. */
export interface WaitingUpdate {
  repo: string;
  private: boolean;
  actionId: string;
  wave: number;
  dependsOn: string[];
  /** When true, an open pull request of the train in this repository does not merge. A release in flight holds its ranges, or a hold names this repository. */
  holdsOpen?: boolean;
}

/** The adoptions of a plan: an adoption with an item that can go is ready, each other adoption waits. */
export interface Selection {
  ready: RepoUpdate[];
  waiting: WaitingUpdate[];
  /** The repositories that have an adoption in the plan. */
  needed: Set<string>;
}

/** The sections of the dependencies that the users of a published package install. */
const RUNTIME = new Set(["dependencies", "peerDependencies", "optionalDependencies"]);

/** This function gives a short fingerprint of the changes of an update. */
export function fingerprint(items: readonly UpdateItem[], ageScopes: readonly string[] | null = null, releases: readonly ReleaseItem[] = []): string {
  const keys = items.map((i) => [i.path, i.type, i.dep, i.newRange ?? "", i.to].join("|")).sort();
  for (const r of releases) keys.push(`release|${r.name}|${r.from}`);
  if (ageScopes && ageScopes.length > 0) keys.push(`settings|minimumReleaseAgeExclude|${ageScopes.join(",")}`);
  return createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 12);
}

function isAdopt(a: Action): a is Action & { kind: "adopt-in-range" | "adopt-breaking" } {
  return a.kind === "adopt-in-range" || a.kind === "adopt-breaking";
}

/**
 * This function gives the packages of an adoption that stay for a later run. These are the packages in `late`, and each
 * package that must move with one of them. `carried` holds the packages that change a published range. They move together.
 */
function heldDeps(items: readonly ActionItem[], late: readonly string[], carried: readonly string[], sets: ReadonlyMap<string, number>): Set<string> {
  const held = new Set(late);
  for (let size = -1; size !== held.size; ) {
    size = held.size;
    const setsOfHeld = new Set([...held].map((d) => sets.get(d)));
    for (const i of items) if (setsOfHeld.has(sets.get(i.dep))) held.add(i.dep);
    if (carried.some((d) => held.has(d))) for (const d of carried) held.add(d);
  }
  return held;
}

/**
 * This function selects the items that the train applies in this run. An item is ready when npm has its target version and
 * nothing holds it (`heldDeps`). The ready items of a repository go, and a later run sends the other items.
 * The plan does not change: its action stays one action with all its items, so the wave order of its waits stays.
 *
 * The set `flying` names the repositories with a release in flight. Main has a new version, and npm does not have it yet.
 * A run publishes the commit that it started on, so a range that changes at this time does not go into that version.
 * The next run of the plan then sees no need for a release. So the item waits, and after the release the cascade raises the version.
 *
 * The list `holds` can name a package and a dependent repository. That package does not go to that repository, and each
 * package that must move with it stays too. The same package goes to each other repository.
 */
export function selectUpdates(p: Plan, only: readonly string[] | null = null, cascade: readonly string[] | "all" = "all", flying: ReadonlySet<string> = new Set(), holds: readonly LagHold[] = []): Selection {
  const latest = new Map(p.nodes.filter((n) => n.kind === "package").map((n) => [n.name, n.npmLatest]));
  const lock = new Map(p.repos.map((r) => [r.name, r.lockKind]));
  const links = new Map(p.repos.filter((r) => r.submodules?.length).map((r) => [r.name, r.submodules ?? []]));
  const scopes = ownScopes(p.owner);
  const ageRule = new Set(p.repos.filter((r) => r.needsAgeRule).map((r) => r.name));
  const ageScopes = (repo: string): string[] | null => (ageRule.has(repo) ? scopes : null);
  const sets = moveSets([...latest.keys()], p.edges);
  // A breaking adoption of a public repository with a cascade release carries the version bump in the same pull request:
  // after the merge, the plan no longer sees the need for the release. A release that waits for something else holds the
  // items that change a published range. A release is one action of a repository, and a repository can fix the versions of
  // its packages together, so these items of all its packages go together or wait together.
  const releaseOf = new Map(p.actions.filter((a) => a.kind === "release" && !a.repoPrivate).map((a) => [a.repo, a]));
  const pick = (repo: string): boolean => !only || only.includes(repo);
  const ready: RepoUpdate[] = [];
  const waiting: WaitingUpdate[] = [];
  const needed = new Set<string>();
  for (const a of p.actions) {
    if (!isAdopt(a)) continue;
    needed.add(a.repo);
    if (!pick(a.repo)) continue;
    const onNpm = (i: ActionItem): boolean => {
      const l = latest.get(i.dep);
      return Boolean(l && semver.valid(l) && semver.valid(i.to) && semver.gte(l, i.to));
    };
    const rel = a.kind === "adopt-breaking" ? releaseOf.get(a.repo) : undefined;
    const cascades = rel?.packages.some((x) => x.bump !== null) ? rel : undefined;
    // A cascade that is not on for the repository (option --cascade) holds the published ranges too.
    const off = cascades && cascade !== "all" && !cascade.includes(a.repo);
    const inFlight = new Set(flying.has(a.repo) ? rel?.packages.filter((x) => x.bump === null).map((x) => x.name) : []);
    const holdsOpen = rel !== undefined && a.items.some((i) => i.dependent !== null && inFlight.has(i.dependent) && i.newRange !== null && RUNTIME.has(i.type));
    const relWaits = [
      ...(cascades ? (off ? [`cascade-off:${cascades.id}`] : cascades.blocked ? [`blocked:${cascades.id}`] : cascades.dependsOn.filter((d) => d !== a.id)) : []),
      ...(holdsOpen ? [`release-in-flight:${rel.id}`] : []),
    ];
    const releasing = new Set(rel?.packages.map((x) => x.name));
    const carried = a.items.filter((i) => i.dependent !== null && releasing.has(i.dependent) && i.newRange && RUNTIME.has(i.type)).map((i) => i.dep);
    const late = a.items.filter((i) => !onNpm(i)).map((i) => i.dep);
    const ruled = [...new Set(a.items.map((i) => i.dep).filter((dep) => holdsUpdate(holds, a.repo, dep)))];
    const held = heldDeps(a.items, [...(relWaits.length > 0 ? [...late, ...carried] : late), ...ruled], carried, sets);
    const going = a.items.filter((i) => !held.has(i.dep));
    if (going.length === 0) {
      waiting.push({ repo: a.repo, private: a.repoPrivate, actionId: a.id, wave: a.wave, dependsOn: [...a.dependsOn, ...relWaits, ...ruled.map((dep) => `hold:${dep}`)], ...(holdsOpen || ruled.length > 0 ? { holdsOpen: true } : {}) });
      continue;
    }
    const carries = relWaits.length === 0 && !carried.some((d) => held.has(d));
    const releases: ReleaseItem[] = (carries ? (cascades?.packages ?? []) : [])
      .filter((x) => x.bump !== null && x.from !== null)
      .map((x) => ({
        name: x.name,
        path: x.path,
        from: x.from as string,
        changes: a.items.filter((i) => i.dependent === x.name && i.newRange && RUNTIME.has(i.type)).map((i) => ({ dep: i.dep, type: i.type })),
      }));
    const items: UpdateItem[] = going.map((i) => ({
      path: i.path,
      dependent: i.dependent,
      dep: i.dep,
      type: i.type,
      range: i.range,
      newRange: i.newRange,
      from: i.resolved,
      to: i.to,
      why: i.why,
    }));
    ready.push({
      repo: a.repo,
      private: a.repoPrivate,
      actionId: a.id,
      kind: items.some((i) => i.newRange) ? "adopt-breaking" : "adopt-in-range",
      // Each item that goes waits for no action, so the update is in wave 0, also when the action is in a later wave.
      wave: 0,
      why: adoptWhy(a.repo, items),
      lockKind: lock.get(a.repo) ?? "none",
      ...(links.has(a.repo) ? { submodules: links.get(a.repo) ?? [] } : {}),
      items,
      ...(held.size > 0 ? { held: { items: a.items.length - items.length, deps: [...held].sort() } } : {}),
      ageScopes: ageScopes(a.repo),
      ...(releases.length > 0 ? { releases } : {}),
      fingerprint: fingerprint(items, ageScopes(a.repo), releases),
    });
  }
  // A repository whose pnpm settings need the scopes of the owner gets them in its pull request. When it has no ready adoption,
  // the train sends the settings alone. Its waiting adoption comes in a later run, with no wait for the release age of pnpm.
  for (const r of p.repos) {
    if (!r.needsAgeRule || !pick(r.name) || ready.some((u) => u.repo === r.name)) continue;
    needed.add(r.name);
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i]?.repo === r.name) waiting.splice(i, 1);
    ready.push({
      repo: r.name,
      private: r.private,
      actionId: `settings:${r.name}`,
      kind: "settings",
      wave: 0,
      why: "The release train updates the packages of the owner, so the release age check of pnpm must not make them wait",
      lockKind: r.lockKind,
      ...(r.submodules?.length ? { submodules: r.submodules } : {}),
      items: [],
      ageScopes: scopes,
      fingerprint: fingerprint([], scopes),
    });
  }
  return { ready, waiting, needed };
}

/** One change of a resolved version in the lockfile. */
export interface LockChange {
  path: string;
  dep: string;
  from: string | null;
  to: string | null;
  /** This value is true when an item of the update asks for this change. */
  intended: boolean;
}

/** A target version that is younger than the minimumReleaseAge of pnpm in the repository. CI refuses it until readyAt. */
export interface YoungItem {
  dep: string;
  version: string;
  readyAt: string;
}

/** The result of the work in a clone of the repository. */
export interface UpdateResult {
  /**
   * `pushed`: the branch has a new commit. `same`: the branch already has these changes.
   * `no-change`: the update changes no file. `unresolved`: the lockfile holds no target version.
   * `young`: each target version is younger than the minimumReleaseAge of pnpm. `failed`: an error.
   */
  status: "pushed" | "same" | "no-change" | "unresolved" | "young" | "failed";
  sha: string | null;
  changes: LockChange[];
  /** The packages that do not have their target version in the lockfile after the update. */
  unresolved: string[];
  /** The packages that wait for the minimumReleaseAge of pnpm. The update leaves them out. */
  young: YoungItem[];
  /** The exact versions that the update puts into `minimumReleaseAgeExclude`, because a person named them as urgent. */
  urgentAge?: string[];
  tool: string | null;
  error: string | null;
  /** The version bumps of the cascade that the update added. */
  releases?: ReleaseDone[];
  /** The files that `conventions fix` of the new version of conventions changed in the same commit. */
  fixed?: string[];
  /** The files of a fix that the train removed, because the typecheck failed with it and passed without it. */
  reverted?: string[];
  /** The first error lines of the typecheck with the removed fix. */
  fixError?: string | null;
  /** The step that failed with the fix, when it is not `typecheck`. */
  fixStep?: string;
  /** The reports that `api-report update` changed, when the update moved that tool. */
  apiReports?: string[];
  /** The first error lines, when a step of that update failed. */
  apiReportError?: string;
  /** The step that failed. */
  apiReportStep?: string;
}

/** The part of the train that changes the files: a clone, the range changes, the lockfile update and the push. */
export interface Updater {
  update(u: RepoUpdate, ctx: { defaultBranch: string; rebuild: boolean }): Promise<UpdateResult>;
}

/** The state of one repository after a run. */
export type RepoState =
  | "planned"
  | "opened"
  | "updated"
  | "unchanged"
  | "merged"
  | "blocked"
  | "closed"
  | "declined"
  | "waiting"
  | "skipped"
  | "error";

/** The CI state of a pull request. */
export type CiState = "none" | "running" | "failed" | "green";

/** The result of one repository. */
export interface RepoResult {
  repo: string;
  private: boolean;
  actionId: string | null;
  kind: string | null;
  wave: number | null;
  state: RepoState;
  items: number;
  pr: { number: number; url: string } | null;
  /** `train`: only the train merges, on green and on the current default branch. The native auto-merge of GitHub stays off. */
  autoMerge: "train" | null;
  ci: CiState | null;
  detail: string;
  /** The problems that a person must correct, and the changes that wait. Only the template sync gives them. */
  needs?: string[];
  /** This value is true when a push waits for a later run: for the limit of pushes, or a sync push for the busy runners. */
  paced?: boolean;
  /** This value is true when the update changes a package of `urgent`. */
  urgent?: boolean;
  /** The count of the items of the repository that stay for a later run. A private repository gives only this count. */
  held?: number;
  /**
   * A merge: the count of the commits of the default branch that were not in the branch at the merge. Null when the train
   * has no read. A count has no name, so the report keeps it also for a private repository.
   */
  mergedBehind?: number | null;
}

/** The result of one run of the train. */
export interface ApplyReport {
  owner: string;
  at: string;
  dryRun: boolean;
  results: RepoResult[];
  /** The public packages whose version on main is not on npm yet. The release workflow of each repository publishes them. */
  inFlight?: { name: string; version: string }[];
  /** The count of the names of `urgent` that change no ready update. The report has only the count, so it stays public. */
  urgentUnused?: number;
  /** The count of the updates whose need had no known start, so their wait started at the start of the run. */
  startFallbacks?: number;
  /** The decisions of the candidate rules, as counts. Absent in the mode `strict`. The report has no names, so it stays public. */
  candidates?: CandidateReport;
  /** The reads of the rate limit of the token at the start and at the end of the run. The command `apply` adds them. */
  rateLimit?: RateLimitReport;
}

/** An action of a train branch: a push, a merge or a wait. */
export type CandidateAction = CandidateDecision["action"];

/** One pair of the mode `shadow`: the action of the strict rule, the action of the candidate rules, their rule, code and count. */
export interface CandidatePair {
  today: CandidateAction;
  next: CandidateAction;
  rule: CandidateRule;
  code: CandidateCode;
  count: number;
}

/**
 * A cause outside the candidate rules that stops a push or a merge. In the mode `shadow`, it stops the action of the strict
 * rule. The mode `one-candidate` has the same causes, so a decision that such a cause holds is not a difference between the rules.
 * In the mode `one-candidate`, it stops the applied decision of the rules.
 * `limit`: the limit of pushes of the run. `busy`: the busy runners stop a sync push. `young`: the target versions are
 * younger than the minimumReleaseAge of pnpm. `release-run`: a merge that changes workflow files waits for the release
 * runs. `skip`: the update or the sync changes no file. `error`: the work in the clone failed.
 * `merge-failed`: GitHub refused the merge of a candidate, and no push follows. Only the mode `one-candidate` gives it.
 */
export type HeldCause = "limit" | "busy" | "young" | "release-run" | "skip" | "error" | "merge-failed";

/**
 * A decision of the candidate rules in a count. `not read`: the run read no fact for the branch. In a held pair, the branch
 * had no candidate. In an applied decision, the read of the facts failed.
 */
export type HeldNext = CandidateAction | "not read";

/** One count of the decisions that a cause outside the candidate rules held, in the mode `shadow`. */
export interface CandidateHeld {
  cause: HeldCause;
  next: HeldNext;
  count: number;
}

/**
 * One count of the decisions that the train applied in the mode `one-candidate`. The key of a count is the five values
 * before `count`.
 */
export interface CandidateActed {
  /** The decision that the run applied. `not read`: the run did not read the facts, so no decision exists. */
  action: HeldNext;
  /** The rule of the decision. Null for `not read`. */
  rule: CandidateRule | null;
  /** The code of the decision. Null for `not read`. */
  code: CandidateCode | null;
  /** The cause outside the candidate rules that stopped the applied decision, or null. */
  held: HeldCause | null;
  /** The state of the result of the repository for the branch in this run. */
  state: RepoState;
  count: number;
}

/**
 * The candidate rules in one run: the mode and the share of the policy, and the GitHub requests of their reads. The report
 * also has the pairs of the mode `shadow` and the applied decisions of the mode `one-candidate`.
 */
export interface CandidateReport {
  mode: CandidateMode;
  /** The share of the policy: the part of the repositories that gets the mode `one-candidate`. */
  share: number;
  /** The pairs where the candidate rules can decide differently from the strict rule. Only the mode `shadow` gives them. */
  pairs: CandidatePair[];
  /** The decisions that a cause outside the candidate rules held in the mode `shadow`. They are not in `pairs`. */
  held: CandidateHeld[];
  /** The decisions that the train applied in the mode `one-candidate`, from the largest count. The list can be empty. */
  acted: CandidateActed[];
  /** The count of the GitHub requests that the readers of the candidate facts made. */
  requests: number;
}

/** The record of one decision of a train branch, in the mode `shadow` or `one-candidate`. */
interface DecisionRecord {
  /** The mode of the candidate rules for the branch. Null until the run reads the decision. */
  mode: CandidateMode | null;
  /**
   * The decision of the candidate rules. In the mode `one-candidate`, it is the last decision that the run applied.
   * `not read`: the run read no fact. In the mode `shadow`, an outside cause held a branch with no candidate. In the mode
   * `one-candidate`, the read of the facts failed.
   */
  d: CandidateDecision | "not read" | null;
  /** The facts of the decision. Null when the run read no fact. */
  facts: CandidateFacts | null;
  /**
   * The cause outside the candidate rules that stopped a push or a merge, or null. In the mode `shadow`, it stopped the
   * action of the strict rule. In the mode `one-candidate`, it stopped the applied decision.
   */
  cause: HeldCause | null;
  /** True when settle merged the default branch into the branch. This is a push of the strict rule. */
  caughtUp: boolean;
}

/** This function gives an empty record of a decision. */
function decisionRecord(): DecisionRecord {
  return { mode: null, d: null, facts: null, cause: null, caughtUp: false };
}

/** The options of `apply`. */
export interface ApplyOptions {
  owner: string;
  plan: Plan;
  gh: GitHub;
  updater: Updater;
  dryRun: boolean;
  only?: readonly string[] | null;
  log?: (line: string) => void;
  /** This function gives the name of a repository for the log. The default hides each private name. */
  label?: (repo: string, isPrivate: boolean) => string;
  concurrency?: number;
  now?: Date;
  /** Start the release workflow of a repository whose release starts only by hand, and merge its green version pull request. */
  releaseDispatch?: boolean;
  /** The repositories whose breaking adoptions carry a cascade release, or "all". The adoptions of other repositories with a release wait. Default: "all". */
  cascade?: readonly string[] | "all";
  /** The valid holds of the file of the holds. A hold with a repository stops the update of its package in that repository. */
  holds?: readonly LagHold[];
  /** The template sync. Absent or null: the run does not sync the template files. */
  sync?: SyncOptions | null;
  /**
   * The most branches that one run pushes. The update branches and the sync branches share this limit. Each push starts
   * the CI of a repository, and all repositories of the account share the runners. The other repositories wait for a
   * later run. Absent: no limit.
   */
  maxPushes?: number;
  /** This function gives the number of jobs that run at this time on the runners of the account, or null when it is not known. */
  runnersBusy?: () => Promise<number | null>;
  /** A sync push waits while `runnersBusy` gives this number of jobs or more. The default is `BUSY_LIMIT`. An update push does not wait. */
  busyLimit?: number;
  /**
   * The names of public packages with a security fix. A person gives them. An update of such a package goes first, does not
   * wait for `maxPushes` and does not use its count. All other checks stay. A private package has no effect here.
   */
  urgent?: readonly string[] | null;
  /**
   * This function gives the time when the need of an update started (see `needStarts`). An update with no open pull
   * request waits from this time. Absent, or undefined: the update waits from the start of the run, and the report counts it.
   */
  needSince?: (u: RepoUpdate) => string | undefined;
  /** The policy of the candidate rules. The default is `CANDIDATE_POLICY`. */
  candidatePolicy?: CandidatePolicy;
}

/** The options of the template sync of `apply`. */
export interface SyncOptions {
  updater: SyncUpdater;
  /** The facts of the run. Null: the template is not readable, so the sync waits. */
  facts: RunFacts | null;
  /** Can the App change workflow files? `auto`: the first push that GitHub refuses tells. */
  workflows: WorkflowsMode;
  rules?: readonly SyncRule[];
}

/**
 * The rule of the runner slots (40 per account): no new heavy start while 30 or more jobs run. Only a sync push waits for
 * this rule. The account has 30 jobs or more for most of a day, and this rule must not stop the update pushes for so long.
 */
export const BUSY_LIMIT = 30;

/**
 * The most branches of one run in the CLI, for the update pushes and the sync pushes together. A push starts approximately
 * 6 jobs (CI, the scans, the reviews), so 5 pushes start approximately 30 jobs.
 */
export const MAX_PUSHES = 5;

/** The time between two scheduled runs of the train. The order of the pushes moves one place in this time. */
export const RUN_MS: number = 30 * 60_000;

/**
 * This function gives a list that starts at place `slot`. The train keeps no state between runs, and a fixed order lets the
 * same repositories push first each time. With this order, each repository of a list of n goes first once in n runs.
 */
export function rotate<T>(list: readonly T[], slot: number): T[] {
  const at = list.length === 0 ? 0 : slot % list.length;
  return [...list.slice(at), ...list.slice(0, at)];
}

/**
 * This function puts first the items whose open pull request had its last push longest ago. The caller gives that time:
 * the train uses the committer date of the head commit, because the train makes a new commit for each push. A pushed
 * pull request goes to the end of the next run. Thus a repository far from the start of the rotation also gets a push.
 * The rotation moves one place in each run, but a run pushes up to `MAX_PUSHES` branches.
 *
 * An item with no open pull request waits from `since`: the time when its need started. For the template sync, that is
 * the date of the template commit. When the caller does not know it, the run gives its own start, so the new item goes
 * after the pull requests that wait already. Without `since`, or with a time that does not parse, an item goes first,
 * in the order of the list.
 */
export function longestWaitFirst<T>(list: readonly T[], pushedOf: (item: T) => string | undefined, since?: string): T[] {
  const at = (x: T): number => {
    const t = pushedOf(x) ?? since;
    const ms = t === undefined ? Number.NaN : Date.parse(t);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  return list.map((x, i) => ({ x, i, t: at(x) })).sort((a, b) => a.t - b.t || a.i - b.i).map((e) => e.x);
}

/** One item of the queue of a run: a push, or a merge of the default branch into a labeled pull request. */
export interface QueueItem {
  /** The key of the item: its effective wait (see `inheritedWait`), in milliseconds. A smaller key goes first. */
  at: number;
  /** The place of the item in the rotation of the run. It orders the items with the same key. */
  tie: number;
}

/**
 * This function gives the order of the queue of a run: the oldest key first, then the place in the rotation. The run
 * pushes the items in this order up to its limit. So the pushed items are always a prefix of this order.
 */
export function queueOrder<T extends QueueItem>(list: readonly T[]): T[] {
  // Two keys of minus infinity give NaN, so the tie orders them.
  return [...list].sort((a, b) => a.at - b.at || a.tie - b.tie);
}

/**
 * This function gives the effective wait of an item. That is the oldest of its own wait and the waits of each action
 * that waits for it, directly or through other actions. `start` holds the ids of the actions of the item. `dependentsOf` gives the
 * ids of the actions that wait directly for an action. `waitOf` gives the wait of an action, or undefined when it is not
 * known. Thus a dependency goes first exactly when something old waits for it.
 *
 * The key only gets older while the item waits, so the item with the oldest key always comes to the front.
 */
export function inheritedWait(own: number, start: readonly string[], dependentsOf: ReadonlyMap<string, readonly string[]>, waitOf: (id: string) => number | undefined): number {
  let at = own;
  const seen = new Set<string>();
  const next = [...start];
  for (let id = next.pop(); id !== undefined; id = next.pop()) {
    for (const d of dependentsOf.get(id) ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      const w = waitOf(d);
      if (w !== undefined && w < at) at = w;
      next.push(d);
    }
  }
  return at;
}

/**
 * This function gives a counter of the jobs that run on the runners of the account. It counts the jobs `in_progress` of
 * each run `in_progress` of the repositories. It keeps a count for `ttlMs`, and gives null for a list that it cannot read.
 */
export function busyRunners(gh: GitHub, owner: string, repos: readonly string[], ttlMs = 60_000, now: () => number = Date.now): () => Promise<number | null> {
  let cached: { at: number; value: number | null } | null = null;
  const count = async (): Promise<number | null> => {
    let jobs = 0;
    for (const repo of repos) {
      const runs = await gh.request<{ workflow_runs: { id: number }[] }>("GET", `/repos/${owner}/${repo}/actions/runs?status=in_progress&per_page=100`);
      if (!runs.data) return null;
      for (const run of runs.data.workflow_runs) {
        const list = await gh.request<{ jobs: { status: string }[] }>("GET", `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        if (!list.data) return null;
        jobs += list.data.jobs.filter((j) => j.status === "in_progress").length;
      }
    }
    return jobs;
  };
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    cached = { at: now(), value: await count() };
    return cached.value;
  };
}

interface Pull {
  number: number;
  html_url: string;
  node_id: string;
  title: string;
  body: string | null;
  state: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  auto_merge?: unknown;
  head: { sha: string; ref: string; repo?: { full_name: string } | null };
  base: { ref: string };
  labels?: { name: string }[];
  draft?: boolean;
}

interface RepoMeta {
  default_branch: string;
  allow_auto_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
}

/** This function gives the merge method of a repository: a merge commit when the repository permits it. */
export function mergeMethod(meta: { allow_merge_commit?: boolean; allow_squash_merge?: boolean } | null): "merge" | "squash" | "rebase" {
  if (!meta || meta.allow_merge_commit !== false) return "merge";
  return meta.allow_squash_merge !== false ? "squash" : "rebase";
}

/** This function gives the title of the pull request of an update. */
export function prTitle(u: RepoUpdate): string {
  if (u.items.length === 0) return "chore(pnpm): no release age wait for the packages of the owner";
  const deps = [...new Set(u.items.map((i) => i.dep))];
  const what = deps.length === 1 ? (deps[0] as string) : `${deps.length} packages`;
  return `chore(deps): release train update of ${what}`;
}

/** This function gives the body of the pull request of an update. */
export function prBody(u: RepoUpdate, r: (Pick<UpdateResult, "changes" | "unresolved" | "tool"> & { young?: YoungItem[]; releases?: ReleaseDone[]; fixed?: string[]; reverted?: string[]; apiReports?: string[]; apiReportError?: string; apiReportStep?: string; fixStep?: string; fixError?: string | null; urgentAge?: string[] }) | null, marks: TrailerMarks | null = null): string {
  const lockOf = new Map((r?.changes ?? []).map((c) => [`${c.path}|${c.dep}`, c]));
  const rows = u.items.map((i) => {
    const c = lockOf.get(`${i.path}|${i.dep}`);
    const range = i.newRange ? `\`${i.range}\` -> \`${i.newRange}\`` : `\`${i.range}\` (no change)`;
    const lock = `${c?.from ?? i.from ?? "none"} -> ${c?.to ?? i.to}`;
    return `| \`${i.dep}\` | \`${i.path || "."}\` | ${i.type} | ${range} | ${lock} |`;
  });
  const other = (r?.changes ?? []).filter((c) => !c.intended);
  const scopes = u.ageScopes ?? [];
  const settings = scopes.length > 0
    ? [
        "## pnpm settings",
        "",
        `\`pnpm-workspace.yaml\` gets ${scopes.map((s) => `\`${s}\``).join(" and ")} in \`minimumReleaseAgeExclude\`. The release train updates these packages, so pnpm installs their new versions at once. The minimumReleaseAge of pnpm stays for all other packages. The change removes each entry that these patterns cover.`,
        "",
      ]
    : [];
  const lines = [
    rows.length > 0
      ? "The release train updates the dependencies of this repository on packages of the owner."
      : "The release train changes the pnpm settings of this repository.",
    "",
    ...(rows.length > 0 ? ["## What changes", "", "| Package | Folder | Section | Range | Lockfile |", "|---|---|---|---|---|", ...rows, ""] : []),
    ...settings,
    "## Why",
    "",
    `${u.why} (plan action \`${u.actionId}\`, kind \`${u.kind}\`, wave ${u.wave}).`,
    "",
  ];
  const done = r?.releases ?? [];
  if (done.length > 0) {
    const via = done[0]?.via === "changeset" ? "a changeset" : "the new version in `package.json`";
    lines.push(
      "## Releases",
      "",
      `A runtime range of a new major version changes, so these packages release. This pull request has ${via}. After the merge, the release workflow of the repository publishes them.`,
      "",
      "| Package | Version | Type | Reason |",
      "|---|---|---|---|",
      ...done.map((x) => `| \`${x.name}\` | ${x.from} -> ${x.to} | ${x.type} | ${x.why} |`),
      "",
    );
  } else if (u.kind === "adopt-breaking") {
    lines.push("A range of a new major version changes. No published package of this repository changes a runtime range, so no release is necessary.", "");
  }
  const fixed = r?.fixed ?? [];
  if (fixed.length > 0) {
    lines.push(
      "## Conventions fix",
      "",
      "The new version of `@mark1russell7/conventions` has fixes for some of its rules. `conventions fix` wrote them in this commit, so these breaks do not block the update. CI checks the result. A break that stays needs a person.",
      "",
      ...fixed.map((file) => `- \`${file}\``),
      "",
    );
  }
  const reverted = r?.reverted ?? [];
  if (reverted.length > 0) {
    lines.push(
      "## Conventions fix removed",
      "",
      r?.fixStep !== undefined
        ? `\`conventions fix\` changed these files, but then ${r.fixStep} failed, so the train removed the fix. The rule stays broken here until a person adds the script and the first report.`
        : "`conventions fix` changed these files, but then `typecheck` failed. Without the fix it passed, so the train removed the fix. The rule stays broken here until the fix of conventions is correct: this is a bug of conventions, not of this repository.",
      "",
      ...reverted.map((file) => `- \`${file}\``),
      "",
      ...(r?.fixError ? ["```text", r.fixError, "```", ""] : []),
    );
  }
  const apiReports = r?.apiReports ?? [];
  if (apiReports.length > 0) {
    lines.push(
      "## API reports",
      "",
      "The update moves `api-report`, so the train started `api-report update`. The default branch passed `check:api`, so a difference here comes from the tool. A difference that is more than a change of form is a finding.",
      "",
      ...apiReports.map((file) => `- \`${file}\``),
      "",
    );
  }
  if (r?.apiReportError) {
    lines.push(
      "## API reports not updated",
      "",
      `The update moves \`api-report\`, but ${r.apiReportStep ?? "a step"} failed. \`check:api\` can fail on this branch until a person starts \`api-report update\`.`,
      "",
      "```text",
      r.apiReportError,
      "```",
      "",
    );
  }
  lines.push("## Other lockfile changes", "");
  if (other.length === 0) lines.push("None.");
  else for (const c of other) lines.push(`- \`${c.dep}\` in \`${c.path || "."}\`: ${c.from ?? "none"} -> ${c.to ?? "removed"}`);
  if (r && r.unresolved.length > 0) {
    lines.push("", `The lockfile does not hold the target version of: ${r.unresolved.map((d) => `\`${d}\``).join(", ")}. A next run tries again.`);
  }
  if (r?.urgentAge && r.urgentAge.length > 0) {
    const list = r.urgentAge.map((e) => `\`${e}\``).join(", ");
    lines.push("", `A person named these versions as urgent, so \`minimumReleaseAgeExclude\` of \`pnpm-workspace.yaml\` gets each exact version: ${list}.`);
  }
  if (r?.young && r.young.length > 0) {
    const list = r.young.map((y) => `\`${y.dep}@${y.version}\` (ready at ${y.readyAt})`).join(", ");
    lines.push("", `These versions are younger than the minimumReleaseAge of pnpm, so a later run adds them: ${list}.`);
  }
  if (u.held) {
    const list = u.held.deps.map((d) => `\`${d}\``).join(", ");
    lines.push("", `These packages wait for a release, or move with a package that waits, so a later run adds them: ${list}.`);
  }
  lines.push("", `The train made the lockfile with \`${r?.tool ?? "the package manager of the repository"}\`. ${prTrailer(u.fingerprint, "It", marks)}`);
  return lines.join("\n");
}

/** The marks of the candidate rules in the body of a pull request of the train. */
export interface TrailerMarks {
  /** The mark lines from `markLines`. The body has them after the fingerprint mark. */
  lines: readonly string[];
  /** The retry label. Present only when the candidate rules act, so the body tells how to ask for a new build. */
  retryLabel?: string;
}

/**
 * This function gives the last lines of each pull request body of the train. They are the merge rule, the fingerprint,
 * the marks of the candidate rules and the last line.
 */
export function prTrailer(fingerprint: string, subject = "It", marks: TrailerMarks | null = null): string {
  const rule = `${subject} merges this pull request when CI is green. When CI fails, it adds the label \`${BLOCKED_LABEL}\` and keeps the pull request open.`;
  const retry = marks?.retryLabel ? ` To get one new build of a red pull request, add the label \`${marks.retryLabel}\`.` : "";
  return [`${rule}${retry}`, "", `${MARK}${fingerprint} -->`, ...(marks?.lines ?? []), CLAUDE_LINE].join("\n");
}

/** This function gives the body of a template sync pull request. */
export function syncPrBody(r: SyncResult, tool: string | null, rules: readonly SyncRule[] = SYNC_RULES, marks: TrailerMarks | null = null): string {
  const tail = tool ? `The train made the lockfile with \`${tool}\`. ${prTrailer(r.fingerprint, "It", marks)}` : prTrailer(r.fingerprint, "The train", marks);
  return `${syncBody(r, rules)}\n\n${tail}`;
}

/**
 * This function gives the published versions on `main` that npm does not have, for each public repository.
 * A blocked release has none. A version in this list is in flight when its release workflow publishes it soon.
 */
export function pendingVersions(p: Plan, only: readonly string[] | null = null): Map<string, { name: string; version: string }[]> {
  const out = new Map<string, { name: string; version: string }[]>();
  for (const a of p.actions) {
    if (a.kind !== "release" || a.repoPrivate || a.blocked || (only && !only.includes(a.repo))) continue;
    const pending = a.packages.filter((x) => x.bump === null && x.to !== null).map((x) => ({ name: x.name, version: x.to as string }));
    if (pending.length > 0) out.set(a.repo, pending);
  }
  return out;
}

/** This function gives the fingerprint in the body of a pull request of the train, if it has one. */
export function bodyFingerprint(body: string | null | undefined): string | null {
  const i = body?.indexOf(MARK) ?? -1;
  if (!body || i < 0) return null;
  return body.slice(i + MARK.length).split(" ")[0] ?? null;
}

interface CheckRun {
  status: string;
  conclusion: string | null;
  check_suite?: { id: number } | null;
}

/** A workflow run of a commit, as far as `latestRuns` reads it. */
interface WorkflowRun {
  workflow_id: number;
  check_suite_id: number;
  created_at: string;
}

/**
 * This function keeps the check runs of the newest workflow run of each workflow. Each workflow run is its own check
 * suite, so the `latest` filter of GitHub keeps the checks of an older run of the same workflow. An example is a run
 * that a new push cancelled, after a later run of the same commit passed. Check runs of other apps stay.
 */
export function latestRuns(runs: readonly CheckRun[], workflowRuns: readonly WorkflowRun[]): CheckRun[] {
  const newest = new Map<number, WorkflowRun>();
  for (const w of workflowRuns) {
    const seen = newest.get(w.workflow_id);
    if (!seen || w.created_at > seen.created_at) newest.set(w.workflow_id, w);
  }
  const keep = new Set([...newest.values()].map((w) => w.check_suite_id));
  const old = new Set(workflowRuns.map((w) => w.check_suite_id).filter((id) => !keep.has(id)));
  return runs.filter((r) => !(r.check_suite && old.has(r.check_suite.id)));
}

/** This function changes the check runs and the commit status of a commit into one CI state. */
export function ciState(runs: readonly CheckRun[], status: { state: string; total_count: number } | null): CiState {
  const failed = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
  const legacy = status && status.total_count > 0 ? status.state : null;
  if (runs.some((r) => r.status === "completed" && r.conclusion !== null && failed.has(r.conclusion))) return "failed";
  if (legacy === "failure" || legacy === "error") return "failed";
  if (runs.length === 0 && legacy === null) return "none";
  if (runs.some((r) => r.status !== "completed") || legacy === "pending") return "running";
  return "green";
}

/** This function gives the name of a private repository as a short hash. Only the holder of the key can match it. */
export function hashName(name: string, key = ""): string {
  return `private-${createHmac("sha256", key).update(name).digest("hex").slice(0, 8)}`;
}

/** This function removes the names, the links and the details of each private repository from a report. */
export function publicReport(r: ApplyReport, key = ""): ApplyReport {
  return {
    ...r,
    results: r.results.map((x) => {
      if (!x.private) return x;
      const { needs, ...rest } = x;
      const count = needs?.length ? ` Needs a hand or waits: ${needs.length}.` : "";
      return { ...rest, repo: hashName(x.repo, key), actionId: null, pr: null, detail: `A private repository: ${x.state}.${count}` };
    }),
  };
}

/** This function gives a text summary of a report: the pull requests by wave and the state of each repository. */
export function applySummary(r: ApplyReport): string {
  const lines = [`Release train apply for ${r.owner} at ${r.at}${r.dryRun ? " (dry run)" : ""}`];
  const prStates = new Set<RepoState>(["planned", "opened", "updated", "unchanged", "merged", "blocked"]);
  const isPr = (x: RepoResult): boolean => prStates.has(x.state) && x.kind !== SYNC_KIND && x.kind !== MERGE_KIND;
  const waves = [...new Set(r.results.filter(isPr).map((x) => x.wave ?? 0))].sort((a, b) => a - b);
  for (const w of waves) {
    const xs = r.results.filter((x) => isPr(x) && (x.wave ?? 0) === w);
    const pub = xs.filter((x) => !x.private).map((x) => x.repo);
    lines.push(`Wave ${w}: ${xs.length} pull requests. Public: ${pub.join(", ") || "none"}. Count of private repositories: ${xs.length - pub.length}.`);
  }
  const sync = r.results.filter((x) => x.kind === SYNC_KIND && prStates.has(x.state));
  if (sync.length > 0) {
    const pub = sync.filter((x) => !x.private).map((x) => x.repo);
    lines.push(`Template sync: ${sync.length} pull requests. Public: ${pub.join(", ") || "none"}. Count of private repositories: ${sync.length - pub.length}.`);
  }
  const labeled = r.results.filter((x) => x.kind === MERGE_KIND);
  if (labeled.length > 0) {
    const pub = labeled.filter((x) => !x.private).map((x) => x.repo);
    const merged = labeled.filter((x) => x.state === "merged").length;
    lines.push(`Label ${MERGE_LABEL}: ${labeled.length} pull requests, ${merged} merged. Public: ${pub.join(", ") || "none"}. Count of private repositories: ${labeled.length - pub.length}.`);
  }
  const wait = r.results.filter((x) => x.state === "waiting" && !x.paced);
  if (wait.length > 0) {
    lines.push(`Waiting for a release: ${wait.length}. Public: ${wait.filter((x) => !x.private).map((x) => x.repo).join(", ") || "none"}. Count of private repositories: ${wait.filter((x) => x.private).length}.`);
  }
  const held = r.results.filter((x) => x.held);
  if (held.length > 0) {
    const count = held.reduce((n, x) => n + (x.held ?? 0), 0);
    lines.push(`Items that wait for a release: ${count} in ${held.length} repositories. Public: ${held.filter((x) => !x.private).map((x) => x.repo).join(", ") || "none"}. Count of private repositories: ${held.filter((x) => x.private).length}.`);
  }
  const paced = r.results.filter((x) => x.paced);
  if (paced.length > 0) {
    lines.push(`Waiting for a later run: ${paced.length}. Public: ${paced.filter((x) => !x.private).map((x) => x.repo).join(", ") || "none"}. Count of private repositories: ${paced.filter((x) => x.private).length}.`);
  }
  const urgent = r.results.filter((x) => x.urgent);
  if (urgent.length > 0) {
    const states = [...new Set(urgent.map((x) => x.state))].map((s) => `${s} ${urgent.filter((x) => x.state === s).length}`).join(", ");
    lines.push(`Urgent: ${urgent.length} (${states}). Public: ${urgent.filter((x) => !x.private).map((x) => x.repo).join(", ") || "none"}. Count of private repositories: ${urgent.filter((x) => x.private).length}.`);
  }
  if (r.urgentUnused) lines.push(`Urgent names with no ready update: ${r.urgentUnused}.`);
  if (r.startFallbacks) lines.push(`Updates with no known start of their need, which wait from the start of this run: ${r.startFallbacks}.`);
  if (r.candidates) {
    const c = r.candidates;
    const total = c.pairs.reduce((n, x) => n + x.count, 0);
    const held = c.held.reduce((n, x) => n + x.count, 0);
    const acted = c.acted.reduce((n, x) => n + x.count, 0);
    lines.push(`Candidate rules (mode ${c.mode}, share ${c.share}): ${acted} decisions applied, ${total} decisions compared, ${held} held by the run before the rules, ${c.requests} GitHub requests for their facts.`);
    if (c.pairs.length > 0) {
      lines.push("", "| Strict rule | Candidate rules | Rule | Code | Count |", "| --- | --- | --- | --- | ---: |");
      for (const x of c.pairs) lines.push(`| ${x.today} | ${x.next} | ${x.rule} | ${x.code} | ${x.count} |`);
      lines.push("");
    }
    if (c.held.length > 0) {
      lines.push("", "Held by the run before the rules:", "", "| Cause | Candidate decision | Count |", "| --- | --- | ---: |");
      for (const x of c.held) lines.push(`| ${x.cause} | ${x.next} | ${x.count} |`);
      lines.push("");
    }
    if (c.acted.length > 0) {
      // An empty value shows as "-", so each row has six cells.
      lines.push("", "Applied decisions:", "", "| Decision | Rule | Code | Held by | Result | Count |", "| --- | --- | --- | --- | --- | ---: |");
      for (const x of c.acted) lines.push(`| ${x.action} | ${x.rule ?? "-"} | ${x.code ?? "-"} | ${x.held ?? "-"} | ${x.state} | ${x.count} |`);
      lines.push("");
    }
  }
  if (r.rateLimit) lines.push(rateLimitLine(r.rateLimit));
  const counts = new Map<RepoState, number>();
  for (const x of r.results) counts.set(x.state, (counts.get(x.state) ?? 0) + 1);
  lines.push(`States: ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`, "");
  for (const x of r.results) {
    const pr = x.pr ? ` ${x.pr.url}` : "";
    const am = x.autoMerge ? ` merge=${x.autoMerge}` : "";
    const ci = x.ci ? ` ci=${x.ci}` : "";
    const kind = x.kind === SYNC_KIND ? " [template sync]" : x.kind === MERGE_KIND ? ` [${MERGE_LABEL}]` : "";
    lines.push(`- ${x.repo}${kind}: ${x.state}${x.wave === null ? "" : ` (wave ${x.wave})`}${pr}${am}${ci}. ${x.detail}`);
  }
  // The problems of the template sync that a person must correct. A private repository gives only a count.
  const hands = r.results.filter((x) => x.needs && x.needs.length > 0);
  const privateHands = r.results.filter((x) => x.private && x.kind === SYNC_KIND && / Needs a hand or waits: \d+\./.test(x.detail)).length;
  if (hands.length > 0 || privateHands > 0) {
    lines.push("", "Needs a hand (template sync):");
    for (const x of hands) {
      if (x.private) {
        lines.push(`- ${x.repo}: ${x.needs?.length ?? 0} items.`);
        continue;
      }
      for (const n of x.needs ?? []) lines.push(`- ${x.repo}: ${n.replaceAll("`", "")}`);
    }
    if (privateHands > 0) lines.push(`- Count of private repositories: ${privateHands}.`);
  }
  return lines.join("\n");
}

/**
 * This function applies the adoptions of the current wave: one branch and one pull request for each repository.
 * It updates an open pull request and closes a pull request that the plan no longer needs.
 * It merges or blocks a pull request from its CI state.
 * It keeps no state between runs: each run reads the state from GitHub again.
 */
export async function apply(o: ApplyOptions): Promise<ApplyReport> {
  const log = o.log ?? (() => {});
  const label = o.label ?? ((repo: string, priv: boolean) => (priv ? hashName(repo) : repo));
  const gh = o.gh;
  const owner = o.owner;
  const base = `/repos/${owner}`;
  /** This function tells if the last run of the release workflow did not fail: a failed run does not publish again by itself. */
  const lastReleaseFlies = async (repo: string): Promise<boolean> => {
    const last = (await gh.request<{ workflow_runs: { status: string; conclusion: string | null }[] }>("GET", `${base}/${repo}/actions/workflows/release.yml/runs?per_page=1`)).data?.workflow_runs?.[0];
    return !last || last.status !== "completed" || last.conclusion === "success";
  };
  // A version that starts by hand is not in flight, so a range can still go into it. An error of a read holds the item for one run.
  const flying = new Set<string>();
  for (const repo of pendingVersions(o.plan, o.only ?? null).keys()) {
    if (!o.plan.actions.some((a) => a.kind === "adopt-breaking" && a.repo === repo)) continue;
    try {
      const wf = await gh.request<{ content?: string }>("GET", `${base}/${repo}/contents/.github/workflows/release.yml`);
      const text = wf.data?.content ? Buffer.from(wf.data.content, "base64").toString("utf8") : "";
      if (text && !dispatchOnly(text) && (await lastReleaseFlies(repo))) flying.add(repo);
    } catch {
      flying.add(repo);
    }
  }
  const sel = selectUpdates(o.plan, o.only ?? null, o.cascade ?? "all", flying, o.holds ?? []);
  const privateOf = new Map(o.plan.repos.map((r) => [r.name, r.private]));
  const scan = o.plan.repos.map((r) => r.name).filter((n) => !o.only || o.only.includes(n));
  const results: RepoResult[] = [];
  const result = (x: Omit<RepoResult, "private"> & { private?: boolean }): RepoResult => {
    const full: RepoResult = { ...x, private: x.private ?? privateOf.get(x.repo) ?? true };
    results.push(full);
    const detail = full.private ? "" : ` ${full.detail}`;
    log(`${label(full.repo, full.private)}: ${full.state}${full.pr && !full.private ? ` ${full.pr.url}` : ""}.${detail}`);
    return full;
  };

  /** This function reads the open pull request of a branch of the train, in each repository of the plan. */
  const openOf = async (branch: string): Promise<Map<string, Pull>> => {
    const found = new Map<string, Pull>();
    await pool(scan, o.concurrency ?? 6, async (repo) => {
      const res = await gh.request<Pull[]>("GET", `${base}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}&per_page=10`);
      const pr = (res.data ?? []).find((p) => p.head.ref === branch);
      if (pr) found.set(repo, pr);
    });
    return found;
  };
  const open = await openOf(TRAIN_BRANCH);

  const ensureLabels = async (repo: string): Promise<void> => {
    const labels: (readonly [string, string, string])[] = [
      [TRAIN_LABEL, "1d76db", "A pull request of the release train."],
      [BLOCKED_LABEL, "b60205", "CI failed on a pull request of the release train."],
    ];
    // Only the mode one-candidate reads the retry label, so only that mode makes it.
    if (modeOf(repo, privateOf.get(repo) ?? true) === "one-candidate") labels.push([policy.retryLabel, "fbca04", "Add this label for one new build of a red pull request of the release train."]);
    for (const [name, color, description] of labels) {
      await gh.request("POST", `${base}/${repo}/labels`, { name, color, description });
    }
  };

  /**
   * This function turns off the native auto-merge of GitHub on a pull request of the train. GitHub merges on green CI of the
   * head, also when the default branch moved after the run. Two lockfile changes then merge with no conflict into a lockfile
   * that does not agree with `package.json`. So only `settle` merges, after it compares the branch with the default branch.
   */
  const disableAutoMerge = async (pr: Pull): Promise<"train"> => {
    if (pr.auto_merge) {
      await gh.graphql("mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }", { id: pr.node_id });
    }
    return "train";
  };

  /**
   * This function gives the number of commits of the default branch that are not in `sha`, or null when GitHub does not
   * answer. A branch that is behind has CI on an old base. A merge then can give a lockfile with no entry for a version.
   */
  const compareOf = async (repo: string, sha: string, defaultBranch: string): Promise<{ behind: number; workflows: boolean } | null> => {
    const res = await gh.request<{ behind_by: number; files?: { filename: string }[] }>("GET", `${base}/${repo}/compare/${encodeURIComponent(defaultBranch)}...${sha}`);
    if (typeof res.data?.behind_by !== "number") return null;
    const files = res.data.files ?? [];
    // GitHub gives at most COMPARE_FILES_MAX files. A longer list can hide a workflow file, so it counts as one.
    return { behind: res.data.behind_by, workflows: files.length >= COMPARE_FILES_MAX || files.some((f) => f.filename.startsWith(WORKFLOWS_DIR)) };
  };
  const behindBy = async (repo: string, sha: string, defaultBranch: string): Promise<number | null> => (await compareOf(repo, sha, defaultBranch))?.behind ?? null;

  /**
   * This function counts the runs of the release workflow on the default branch that are not done (queued, waiting or in
   * progress). It gives null when GitHub does not answer. A repository without a release workflow has none.
   */
  const releaseRunsOpen = async (repo: string, defaultBranch: string): Promise<number | null> => {
    const res = await gh.request<{ workflow_runs: { status: string }[] }>("GET", `${base}/${repo}/actions/workflows/release.yml/runs?branch=${encodeURIComponent(defaultBranch)}&per_page=10`);
    if (res.status === 404) return 0;
    if (!res.ok || !res.data) return null;
    return (res.data.workflow_runs ?? []).filter((r) => r.status !== "completed").length;
  };

  const ciOf = async (repo: string, sha: string): Promise<CiState> => {
    const runs = await gh.request<{ check_runs: CheckRun[] }>("GET", `${base}/${repo}/commits/${sha}/check-runs?per_page=100`);
    const status = await gh.request<{ state: string; total_count: number }>("GET", `${base}/${repo}/commits/${sha}/status`);
    const workflows = await gh.request<{ workflow_runs: WorkflowRun[] }>("GET", `${base}/${repo}/actions/runs?head_sha=${sha}&per_page=100`);
    return ciState(latestRuns(runs.data?.check_runs ?? [], workflows.data?.workflow_runs ?? []), status.data);
  };

  /**
   * This function counts the workflow runs of a repository that are queued or in progress. It counts only the runs on a
   * branch other than `branch` and the default branch: the gates of other changes. A merge into the default branch while
   * such a gate runs makes its result old ("green on the rebased head"), so the gate runs again.
   * Thus the train merges when they are done.
   */
  const otherRuns = async (repo: string, branch: string, meta: RepoMeta | null): Promise<number> => {
    let count = 0;
    for (const status of ["in_progress", "queued"]) {
      const res = await gh.request<{ workflow_runs: { head_branch: string | null }[] }>("GET", `${base}/${repo}/actions/runs?status=${status}&per_page=100`);
      for (const run of res.data?.workflow_runs ?? []) {
        if (run.head_branch !== branch && run.head_branch !== (meta?.default_branch ?? "main")) count++;
      }
    }
    return count;
  };

  const hasLabel = (pr: Pull, name: string): boolean => (pr.labels ?? []).some((l) => l.name === name);

  /**
   * This function merges the default branch into a branch that is behind, with the update-branch API of GitHub. Then CI
   * starts again on the current base. It takes only a branch of the same repository with no conflict. A Renovate branch keeps its
   * rebase box, because Renovate rebases it. The API refuses a change of the head after the read (HTTP 422).
   *
   * The merge starts CI, so it counts as a push in the limit of the run. The queue of the run gives it its place (see
   * `catchUps`). The function gives the text to add to the detail, and `pushed` is true when it merged in this call.
   */
  const catchUp = async (repo: string, pr: Pull, main: string): Promise<{ note: string; pushed: boolean }> => {
    const no = (note: string) => ({ note, pushed: false });
    if ((pr.body ?? "").includes(RENOVATE_REBASE_BOX)) return no("");
    if (pr.head.repo === null || (pr.head.repo !== undefined && pr.head.repo.full_name !== `${owner}/${repo}`)) return no("");
    const conflict = ` The branch has a conflict with ${main}: its author must merge ${main} into it.`;
    const full = (await gh.request<Pull>("GET", `${base}/${repo}/pulls/${pr.number}`)).data;
    if (full?.mergeable === false || full?.mergeable_state === "dirty") return no(conflict);
    // The merge starts CI as a push does, so it counts in the limit of pushes of the run.
    const done = caught.get(`${repo}#${pr.number}`);
    if (done !== undefined) return no(done);
    const wait = limitWait();
    if (wait !== null) return no(` The merge of ${main} into the branch waits: ${wait}`);
    const r = await gh.request("PUT", `${base}/${repo}/pulls/${pr.number}/update-branch`, { expected_head_sha: pr.head.sha });
    if (r.ok) {
      pushes += 1;
      return { note: ` The train merged ${main} into the branch, so CI runs again.`, pushed: true };
    }
    return no(r.status === 422 ? conflict : ` The update of the branch failed (HTTP ${r.status}).`);
  };

  /**
   * This function merges a green pull request, or labels a red one. It gives the new state. It merges only a branch that
   * has each commit of the default branch, so CI ran on the current base. A branch that is behind waits for a new build.
   * `caughtUp` is true when it merged the default branch into the branch: that is a push. `held` names a cause outside
   * the candidate rules that stopped the merge.
   */
  const settle = async (
    repo: string,
    pr: Pull,
    meta: RepoMeta | null,
    branch: string = TRAIN_BRANCH,
    deleteBranch = true,
  ): Promise<{ state: RepoState; ci: CiState; detail: string; behind?: number; caughtUp?: boolean; held?: HeldCause; mergedBehind?: number }> => {
    const ci = await ciOf(repo, pr.head.sha);
    if (ci === "failed") {
      if (!hasLabel(pr, BLOCKED_LABEL)) await gh.request("POST", `${base}/${repo}/issues/${pr.number}/labels`, { labels: [BLOCKED_LABEL] });
      return { state: "blocked", ci, detail: "CI failed. The pull request stays open with the blocked label." };
    }
    if (ci === "green") {
      const ageHours = pr.created_at ? ((o.now ?? new Date()).getTime() - Date.parse(pr.created_at)) / 3_600_000 : 0;
      const others = ageHours < YIELD_MAX_HOURS ? await otherRuns(repo, branch, meta) : 0;
      if (others > 0) {
        return { state: "unchanged", ci, detail: `CI is green, but ${others} workflow run(s) of other branches are not done. The train merges in a later run, so their result stays valid.` };
      }
      const main = meta?.default_branch ?? "main";
      const cmp = await compareOf(repo, pr.head.sha, main);
      if (cmp === null) return { state: "unchanged", ci, detail: `CI is green, but GitHub did not compare the branch with ${main}. The train does not merge it now.` };
      if (cmp.behind > 0) {
        const caught = await catchUp(repo, pr, main);
        return {
          state: "unchanged",
          ci,
          behind: cmp.behind,
          detail: `CI is green, but the branch is ${cmp.behind} commit(s) behind ${main}. The train builds it again from ${main} before a merge.${caught.note}`,
          ...(caught.pushed ? { caughtUp: true } : {}),
        };
      }
      // A release run tags the commit of its version. When a merge changes a workflow file before the tag, GitHub refuses the
      // tag (HTTP 403): the token of a workflow cannot write workflow files. So a change of a workflow file waits for the run.
      if (cmp.workflows) {
        const open = await releaseRunsOpen(repo, main);
        if (open === null) return { state: "unchanged", ci, held: "release-run", detail: `CI is green and the branch changes workflow files, but GitHub did not list the release runs of ${main}. The train does not merge it now.` };
        if (open > 0) {
          return { state: "unchanged", ci, held: "release-run", detail: `CI is green, but the branch changes workflow files and ${open} release run(s) of ${main} are not done. The train merges after the release, so GitHub does not refuse its tag.` };
        }
      }
      const m = await gh.request("PUT", `${base}/${repo}/pulls/${pr.number}/merge`, { merge_method: mergeMethod(meta), sha: pr.head.sha });
      if (m.ok) {
        if (deleteBranch) await gh.request("DELETE", `${base}/${repo}/git/refs/heads/${branch}`);
        return { state: "merged", ci, detail: "CI was green. The train merged the pull request.", mergedBehind: cmp.behind };
      }
      return { state: "unchanged", ci, detail: `CI is green, but the merge failed (HTTP ${m.status}${m.message ? `: ${m.message}` : ""}).` };
    }
    const why = ci === "none" ? "No CI check started yet." : "CI runs.";
    return { state: "unchanged", ci, detail: why };
  };

  /** This function gives the field `mergedBehind` of a result of settle that merged, and no field for another result. */
  const mergedOf = (s: { state: RepoState; mergedBehind?: number }): Pick<RepoResult, "mergedBehind"> => (s.state === "merged" ? { mergedBehind: s.mergedBehind ?? null } : {});

  /** This function closes a pull request of the train with a comment, marks it as closed by the train and deletes the branch. */
  const closeTrainPr = async (repo: string, pr: Pull, why: string, branch: string = TRAIN_BRANCH): Promise<void> => {
    await gh.request("POST", `${base}/${repo}/issues/${pr.number}/comments`, { body: `The release train closes this pull request: ${why}.\n\n${CLAUDE_LINE}` });
    await gh.request("PATCH", `${base}/${repo}/pulls/${pr.number}`, { state: "closed", body: `${pr.body ?? ""}\n${CLOSED_MARK}` });
    await gh.request("DELETE", `${base}/${repo}/git/refs/heads/${branch}`);
  };

  /** This function finds a pull request of a branch that a person closed with the same changes. The train does not open it again. */
  const declinedPr = async (repo: string, branch: string, fp: string): Promise<Pull | undefined> => {
    const closed = await gh.request<Pull[]>("GET", `${base}/${repo}/pulls?state=closed&head=${owner}:${encodeURIComponent(branch)}&per_page=20`);
    return (closed.data ?? []).find((p) => !p.merged_at && !(p.body ?? "").includes(CLOSED_MARK) && bodyFingerprint(p.body) === fp);
  };

  /**
   * This function tells if the branch of an open pull request must start again from the default branch, with a new install.
   * That is so when GitHub cannot merge it, or when it is behind the default branch. A merge of the default branch into the branch is not the fix:
   * it makes the same merge of two lockfiles.
   */
  const needsRebuild = async (repo: string, existing: Pull | null, defaultBranch: string): Promise<boolean> => {
    if (!existing) return false;
    const full = await gh.request<Pull>("GET", `${base}/${repo}/pulls/${existing.number}`);
    if (full.data?.mergeable === false) return true;
    return ((await behindBy(repo, existing.head.sha, defaultBranch)) ?? 0) > 0;
  };

  const prRef = (p: Pull | null) => (p ? { number: p.number, url: p.html_url } : null);

  /**
   * This function opens or updates the pull request of a branch after the work in a clone. It adds the labels, turns on
   * the native auto-merge off, and merges or blocks the pull request from its CI state. The update pull requests and the template sync use it.
   */
  const publish = async (p: {
    common: Pick<RepoResult, "repo" | "private" | "actionId" | "kind" | "wave" | "items" | "needs" | "held">;
    branch: string;
    existing: Pull | null;
    meta: RepoMeta;
    pushed: boolean;
    sha: string | null;
    title: string;
    body: string;
    note: string;
    /** False: the candidate rules decided, so a branch with no push does not go through `settle`. The default is true. */
    settle?: boolean;
    /** A label that the train removes from the pull request after a push: the retry label. */
    removeLabel?: string;
    /**
     * The record of the decision. In the mode `shadow`, settle adds its catch-up push and its held merge. In the mode
     * `one-candidate`, a branch with no new commit gets the cause `skip`.
     */
    record?: DecisionRecord;
  }): Promise<void> => {
    const repo = p.common.repo;
    let pr: Pull;
    let state: RepoState;
    if (p.existing) {
      const existing = p.existing;
      pr = existing;
      state = p.pushed ? "updated" : "unchanged";
      if (p.pushed || existing.body !== p.body || existing.title !== p.title) {
        const upd = await gh.request<Pull>("PATCH", `${base}/${repo}/pulls/${existing.number}`, { title: p.title, body: p.body });
        if (upd.data) pr = { ...upd.data, labels: existing.labels ?? [] };
      }
      if (p.pushed) {
        pr = { ...pr, head: { ...pr.head, sha: p.sha ?? pr.head.sha } };
        if (hasLabel(existing, BLOCKED_LABEL)) {
          await gh.request("DELETE", `${base}/${repo}/issues/${existing.number}/labels/${encodeURIComponent(BLOCKED_LABEL)}`);
          pr = { ...pr, labels: (pr.labels ?? []).filter((l) => l.name !== BLOCKED_LABEL) };
        }
        if (p.removeLabel && hasLabel(existing, p.removeLabel)) {
          await gh.request("DELETE", `${base}/${repo}/issues/${existing.number}/labels/${encodeURIComponent(p.removeLabel)}`);
          const gone = p.removeLabel;
          pr = { ...pr, labels: (pr.labels ?? []).filter((l) => l.name !== gone) };
        }
      }
    } else {
      const made = await gh.request<Pull>("POST", `${base}/${repo}/pulls`, { title: p.title, body: p.body, head: p.branch, base: p.meta.default_branch });
      if (!made.data) throw new Error(`GitHub did not open the pull request (HTTP ${made.status}${made.message ? `: ${made.message}` : ""}).`);
      pr = made.data;
      state = "opened";
    }
    await ensureLabels(repo);
    if (!hasLabel(pr, TRAIN_LABEL)) await gh.request("POST", `${base}/${repo}/issues/${pr.number}/labels`, { labels: [TRAIN_LABEL] });
    const autoMerge = await disableAutoMerge(pr);
    const how = "The train merges it on green in a later run.";
    if (state === "opened" || state === "updated") {
      result({ ...p.common, state, pr: prRef(pr), autoMerge, ci: "none", detail: `${how}${p.note}` });
      return;
    }
    if (p.settle === false) {
      // The candidate rules decided a push, but the run pushed no commit: the update or the sync gave no change.
      if (p.record) p.record.cause = "skip";
      result({ ...p.common, state, pr: prRef(pr), autoMerge, ci: null, detail: `The branch has these changes already. ${how}${p.note}` });
      return;
    }
    const s = await settle(repo, pr, p.meta, p.branch);
    if (p.record) {
      p.record.caughtUp = s.caughtUp === true;
      p.record.cause = s.held ?? null;
    }
    result({ ...p.common, state: s.state, pr: prRef(pr), autoMerge, ci: s.ci, detail: s.state === "merged" ? s.detail : `${s.detail} ${how}`, ...mergedOf(s) });
  };

  // The candidate rules (see candidate-policy.ts). The mode `shadow` acts as `strict` and logs the decision of the rules
  // next to the action of the strict rule. The mode `one-candidate` acts on the decision and logs a record of it. The
  // share of the policy selects the repositories of the mode `one-candidate`. The other repositories stay in `shadow`.
  const policy = o.candidatePolicy ?? CANDIDATE_POLICY;
  const nowMs = (o.now ?? new Date()).getTime();
  const reader = candidateReader(gh, owner, policy, nowMs, [TRAIN_BRANCH, SYNC_BRANCH]);
  const pairs = new Map<string, CandidatePair>();
  const heldPairs = new Map<string, CandidateHeld>();
  const actedCounts = new Map<string, CandidateActed>();
  /** This function gives the mode of the candidate rules for a repository. The share uses the label of the log, so it reads no private name. */
  const modeOf = (repo: string, isPrivate: boolean): CandidateMode => modeFor(policy, label(repo, isPrivate));
  /** This function gives the marks of the candidate rules for the body of a pull request, or null in the mode `strict`. */
  const marksOf = (mode: CandidateMode, attempt: number, items: readonly CandidateItem[] | null): TrailerMarks | null => {
    if (mode === "strict") return null;
    return { lines: markLines(items ? { attempt, items } : { attempt }), ...(mode === "one-candidate" ? { retryLabel: policy.retryLabel } : {}) };
  };
  /**
   * This function gives the `attempt` number for the body after the work of a run. The value `red` is true when the CI of
   * the head before the push failed: only then a push of the same plan counts up.
   */
  const attemptOf = (existing: Pull | null, fp: string, pushed: boolean, act: CandidateDecision | null, red: boolean): number =>
    act && pushed ? (act.attempt ?? 1) : nextAttempt(existing ? { fingerprint: bodyFingerprint(existing.body), attempt: bodyAttempt(existing.body) } : null, fp, pushed, red);
  /**
   * This function reads the facts that the candidate rules need for a branch, and gives their decision. A failed read gives
   * null. With `read` false, it reads no fact: it gives a decision that needs no fact, or `not read`.
   */
  const candidateOf = async (
    kind: CandidateKind,
    t: CandidateTarget & { pr: Pull | null },
    plan: { fingerprint: string; items: CandidateItem[] | null },
    urgent: boolean,
    read = true,
  ): Promise<DecideResult | "not read" | null> => {
    const pr = t.pr;
    const facts: CandidateFacts = {
      kind,
      private: t.private,
      now: nowMs,
      urgent,
      only: o.only?.includes(t.repo) ?? false,
      yieldMaxHours: YIELD_MAX_HOURS,
      plan,
      open: pr
        ? { fingerprint: bodyFingerprint(pr.body), attempt: bodyAttempt(pr.body), items: bodyItems(pr.body), createdAt: pr.created_at ? Date.parse(pr.created_at) : null, retryLabel: hasLabel(pr, policy.retryLabel) }
        : null,
    };
    if (!read) {
      const step = decide(policy, facts);
      return "decision" in step ? { decision: step.decision, facts, needs: [] } : "not read";
    }
    try {
      return await decideWith(policy, facts, (need) => reader.read(need, t));
    } catch (e) {
      log(`${label(t.repo, t.private)}: the candidate rules did not decide${t.private ? "." : `: ${e instanceof Error ? e.message : String(e)}`}`);
      return null;
    }
  };
  /** This function gives the action of the strict rule from the result of a repository, or null for a result with no such action. */
  const strictAction = (x: RepoResult): CandidateAction | null => {
    if (x.state === "opened" || x.state === "updated") return "push";
    if (x.state === "merged") return "merge";
    if (x.state === "unchanged" || x.state === "blocked" || x.state === "waiting") return "wait";
    if (x.state === "planned") return /^The run (opens|updates)/.test(x.detail) ? "push" : "wait";
    return null;
  };
  /**
   * This function counts the pair of the strict action and the decision of the candidate rules, and logs it. The log of a
   * private repository has its label and no reason. A cause outside the rules can hold a decision. That decision goes to
   * the held counts and not to the pairs. A catch-up merge of settle is a push of the strict rule.
   *
   * A record of the mode `one-candidate` goes to `actedOf`. In that mode, the rules act, so it has no pair to compare.
   */
  const pairOf = (repo: string, isPrivate: boolean, kind: CandidateKind, rec: DecisionRecord, added: readonly RepoResult[]): void => {
    if (rec.mode === "one-candidate") {
      actedOf(repo, isPrivate, kind, rec, added);
      return;
    }
    const d = rec.d;
    if (!d) return;
    const why = (x: CandidateDecision): string => ` by ${x.rule} [${x.code}]${isPrivate ? "" : `: ${x.reason}`}`;
    if (rec.cause !== null) {
      const next: HeldNext = d === "not read" ? d : d.action;
      const key = `${rec.cause}|${next}`;
      const held = heldPairs.get(key) ?? { cause: rec.cause, next, count: 0 };
      held.count += 1;
      heldPairs.set(key, held);
      log(`${label(repo, isPrivate)}: candidate rules (${kind}): held by ${rec.cause} before the rules, candidate ${next}${d === "not read" ? "" : why(d)}.`);
      return;
    }
    if (d === "not read") return;
    const last = added[added.length - 1];
    const today = rec.caughtUp ? "push" : last ? strictAction(last) : null;
    if (!today) return;
    const key = `${today}|${d.action}|${d.rule}|${d.code}`;
    const pair = pairs.get(key) ?? { today, next: d.action, rule: d.rule, code: d.code, count: 0 };
    pair.count += 1;
    pairs.set(key, pair);
    log(`${label(repo, isPrivate)}: candidate rules (${kind}): strict ${today}, candidate ${d.action}${why(d)}.`);
  };
  /**
   * This function counts the decision that the run applied in the mode `one-candidate`, and logs it. The result is the
   * state of the last result that the step added. The log of a private repository has its label and no reason.
   */
  const actedOf = (repo: string, isPrivate: boolean, kind: CandidateKind, rec: DecisionRecord, added: readonly RepoResult[]): void => {
    const d = rec.d;
    const last = added[added.length - 1];
    if (!d || !last) return;
    const row: CandidateActed =
      d === "not read"
        ? { action: d, rule: null, code: null, held: null, state: last.state, count: 0 }
        : { action: d.action, rule: d.rule, code: d.code, held: rec.cause, state: last.state, count: 0 };
    const key = `${row.action}|${row.rule}|${row.code}|${row.held}|${row.state}`;
    const count = actedCounts.get(key) ?? row;
    count.count += 1;
    actedCounts.set(key, count);
    const at = `${label(repo, isPrivate)}: candidate rules (${kind}): acted`;
    if (d === "not read") {
      log(`${at} not read, result ${row.state}.`);
      return;
    }
    log(`${at} ${d.action} by ${d.rule} [${d.code}], result ${row.state}${row.held ? `, held by ${row.held}` : ""}${isPrivate ? "" : `: ${d.reason}`}.`);
  };
  type Common = Omit<RepoResult, "state" | "pr" | "autoMerge" | "ci" | "detail">;
  /**
   * This function applies a decision of the candidate rules that is not a push: a wait or a merge. When GitHub refuses the
   * merge of a candidate that is behind, the candidate is stale (R2) in the same run. The function then gives the next
   * decision when it is a push. Else it gives null, and the result of the repository is in the report. The function writes
   * the last decision into `record`, with the cause outside the rules that stopped it.
   */
  const settleCandidate = async (common: Common, t: CandidateTarget & { pr: Pull | null }, meta: RepoMeta, dr: DecideResult, record: DecisionRecord): Promise<CandidateDecision | null> => {
    const repo = common.repo;
    const pr = t.pr;
    const d = dr.decision;
    const ci = dr.facts.ci?.state ?? null;
    if (o.dryRun) {
      const what = !pr ? "The run waits" : d.action === "merge" ? `The run merges PR #${pr.number}` : `The run keeps PR #${pr.number}`;
      result({ ...common, state: "planned", pr: prRef(pr), autoMerge: null, ci, detail: `${what}: ${d.reason}.` });
      return null;
    }
    if (!pr) {
      result({ ...common, state: "waiting", paced: true, pr: null, autoMerge: null, ci: null, detail: `${d.reason}.` });
      return null;
    }
    const autoMerge = await disableAutoMerge(pr);
    if (d.action === "wait") {
      // A red candidate keeps the blocked label, as in the strict rule.
      const failed = ci === "failed";
      if (failed && !hasLabel(pr, BLOCKED_LABEL)) await gh.request("POST", `${base}/${repo}/issues/${pr.number}/labels`, { labels: [BLOCKED_LABEL] });
      result({ ...common, state: failed ? "blocked" : "unchanged", pr: prRef(pr), autoMerge, ci, detail: `${d.reason}.` });
      return null;
    }
    // A change of a workflow file waits for the release runs of the default branch, as in settle.
    const main = meta.default_branch;
    const cmp = await reader.compare(repo, pr.head.sha, main);
    if (cmp === null || cmp.cut || cmp.files.some((f) => f.startsWith(WORKFLOWS_DIR))) {
      const runs = await releaseRunsOpen(repo, main);
      if (runs === null || runs > 0) {
        const why = runs === null ? `GitHub did not list the release runs of ${main}` : `${runs} release run(s) of ${main} are not done`;
        record.cause = "release-run";
        result({ ...common, state: "unchanged", pr: prRef(pr), autoMerge, ci, detail: `CI is green, but the branch can change workflow files and ${why}. The train merges after the release, so GitHub does not refuse its tag.` });
        return null;
      }
    }
    const m = await gh.request("PUT", `${base}/${repo}/pulls/${pr.number}/merge`, { merge_method: mergeMethod(meta), sha: pr.head.sha });
    if (m.ok) {
      await gh.request("DELETE", `${base}/${repo}/git/refs/heads/${t.branch}`);
      result({ ...common, state: "merged", pr: prRef(pr), autoMerge, ci, detail: `The train merged the pull request: ${d.reason}.`, mergedBehind: dr.facts.behind ?? null });
      return null;
    }
    const failed = `the merge failed (HTTP ${m.status}${m.message ? `: ${m.message}` : ""})`;
    if (dr.facts.behind === null || (dr.facts.behind ?? 0) > 0) {
      try {
        const next = await decideWith(policy, { ...dr.facts, mergeRefused: true }, (need) => reader.read(need, t));
        // The record has the second decision: the decision that counts is the last one of the run.
        record.d = next.decision;
        record.facts = next.facts;
        if (next.decision.action === "push") return next.decision;
        record.cause = "merge-failed";
        result({ ...common, state: "unchanged", pr: prRef(pr), autoMerge, ci, detail: `CI is green, but ${failed}. ${next.decision.reason}.` });
        return null;
      } catch {
        // The result below tells the failed merge.
      }
    }
    record.cause = "merge-failed";
    result({ ...common, state: "unchanged", pr: prRef(pr), autoMerge, ci, detail: `CI is green, but ${failed}.` });
    return null;
  };
  /**
   * This function reads the decision of the candidate rules for a branch in the modes `shadow` and `one-candidate`. In the
   * mode `one-candidate`, it applies a wait or a merge, and gives a push for the caller. The value `done` is true when the
   * result of the repository is in the report. In the mode `shadow`, `held` names a cause outside the rules that holds a
   * branch with no candidate. Then the run reads no fact for the branch.
   *
   * In both modes, `record` gets the mode and the decision. In the mode `one-candidate`, a failed read gives the decision
   * `not read`.
   */
  const candidateStep = async (
    mode: CandidateMode,
    kind: CandidateKind,
    common: Common,
    t: CandidateTarget & { pr: Pull | null },
    meta: RepoMeta,
    plan: { fingerprint: string; items: CandidateItem[] | null },
    urgent: boolean,
    record: DecisionRecord,
    held: HeldCause | null = null,
  ): Promise<{ act: CandidateDecision | null; done: boolean }> => {
    if (mode === "strict") return { act: null, done: false };
    record.mode = mode;
    if (mode === "shadow") {
      const decided = await candidateOf(kind, t, plan, urgent, !(held !== null && t.pr === null));
      record.d = decided === "not read" ? decided : (decided?.decision ?? null);
      record.facts = decided === "not read" ? null : (decided?.facts ?? null);
      return { act: null, done: false };
    }
    const decided = await candidateOf(kind, t, plan, urgent);
    if (decided === "not read" || !decided) {
      record.d = "not read";
      result({ ...common, state: "error", pr: prRef(t.pr), autoMerge: null, ci: null, detail: "The candidate rules did not read their facts. A later run tries again." });
      return { act: null, done: true };
    }
    record.d = decided.decision;
    record.facts = decided.facts;
    const act = decided.decision.action === "push" ? decided.decision : await settleCandidate(common, t, meta, decided, record);
    return { act, done: act === null };
  };

  const pacing = o.maxPushes !== undefined || o.runnersBusy !== undefined;
  /** A queue item of the run, with the work that it does in its turn. */
  type Turn = QueueItem & { run: () => Promise<void> };
  /**
   * This function gives the time of the last push of each open pull request of the train. That time is the committer date
   * of its head commit. A label, a comment or a body edit changes `updated_at` but not this time. Thus an edit with no push
   * keeps the place of the pull request in the order. When the commit is not readable, the time is `updated_at`.
   */
  /** This function gives the committer date of a commit, or undefined when the commit is not readable. */
  const commitDate = async (repo: string, sha: string): Promise<string | undefined> => {
    const res = await gh.request<{ commit?: { committer?: { date?: string } } }>("GET", `${base}/${repo}/commits/${sha}`);
    return res.data?.commit?.committer?.date;
  };
  /** This function gives the time of the last push of a pull request: the committer date of its head, else `updated_at`. */
  const pushTime = async (repo: string, pr: Pull): Promise<string | undefined> => (await commitDate(repo, pr.head.sha)) ?? pr.updated_at;
  const pushedAt = async (prs: Map<string, Pull>): Promise<Map<string, string | undefined>> => {
    const times = new Map<string, string | undefined>();
    await pool([...prs], o.concurrency ?? 6, async ([repo, pr]) => {
      times.set(repo, await pushTime(repo, pr));
    });
    return times;
  };
  /** This function gives a time in milliseconds, as `longestWaitFirst` orders it: no time, or one that does not parse, goes first. */
  const waitMs = (t: string | undefined): number => {
    const ms = t === undefined ? Number.NaN : Date.parse(t);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  /** The start of the run. A new item with no known start of its need waits from it. */
  const runStart = (o.now ?? new Date()).toISOString();
  const slot = Math.floor((o.now ?? new Date()).getTime() / RUN_MS);
  let pushes = 0;
  /** This function gives the reason why a push waits for the limit of pushes, or null when it can push. */
  const limitWait = (): string | null =>
    o.maxPushes !== undefined && pushes >= o.maxPushes ? `This run pushed ${pushes} branches, the most of one run, because the runners are shared. A later run pushes this one.` : null;
  /**
   * This map holds the merges of the default branch into labeled pull requests in the queue of this run. The key is
   * `repo#number`, and the value is the text for the detail. The function catchUp gives this text later, with no second merge.
   */
  const caught = new Map<string, string>();
  let startFallbacks = 0;
  /** This function gives the reason why a sync push waits for the busy runners, or null when it can push. */
  const busyWait = async (): Promise<string | null> => {
    if (!o.runnersBusy) return null;
    const busy = await o.runnersBusy();
    const limit = o.busyLimit ?? BUSY_LIMIT;
    return busy !== null && busy >= limit ? `${busy} jobs run on the runners of the account, and a sync push waits at ${limit} or more. A later run pushes this one.` : null;
  };
  // Only a public name counts: GitHub shows the input of a run, so a private name must not change what a run does.
  const publicPackages = new Set(o.plan.nodes.filter((n) => n.kind === "package" && !n.repoPrivate).map((n) => n.name));
  const urgentNames = new Set((o.urgent ?? []).filter((n) => publicPackages.has(n)));
  const isUrgent = (u: RepoUpdate): boolean => u.items.some((i) => urgentNames.has(i.dep));

  /**
   * This function merges each open pull request with the label MERGE_LABEL in a repository of the plan, through settle.
   * It takes only a branch of the same repository on the default branch. It does not delete the branch, because the
   * branch is not of the train. A Renovate branch that is behind gets a tick in its rebase box, so Renovate rebases it and CI runs again.
 * Another branch that is behind gets the default branch merged in by settle.
   */
  const mergeLabeled = async (): Promise<void> => {
    const items = await findLabeled();
    if (items === null) return;
    for (const { repo, number } of items) {
      const base0 = { repo, actionId: `merge:${repo}#${number}`, kind: MERGE_KIND, wave: null, items: 0, autoMerge: "train" as const };
      try {
        const meta = await metaOf(repo);
        const pr = (await gh.request<Pull>("GET", `${base}/${repo}/pulls/${number}`)).data;
        if (!pr || pr.state !== "open") continue;
        const main = meta?.default_branch ?? "main";
        // A branch of a fork has a name that can match a branch of this repository, and a merge into another base is not a release path.
        if (pr.head.repo?.full_name !== `${owner}/${repo}` || pr.base.ref !== main || pr.draft) {
          result({ ...base0, state: "skipped", pr: prRef(pr), ci: null, detail: `The train merges only a branch of this repository into ${main}, and not a draft.` });
          continue;
        }
        if (o.dryRun) {
          result({ ...base0, state: "planned", pr: prRef(pr), ci: null, detail: "The run merges the pull request when CI is green." });
          continue;
        }
        await disableAutoMerge(pr);
        const s = await settle(repo, pr, meta, pr.head.ref, false);
        let detail = s.detail;
        if ((s.behind ?? 0) > 0) {
          const body = pr.body ?? "";
          // settle merges the default branch into a branch with no rebase box.
          if (body.includes(RENOVATE_REBASE_BOX)) {
            const r = await gh.request("PATCH", `${base}/${repo}/pulls/${pr.number}`, { body: body.replace(RENOVATE_REBASE_BOX, "- [x] <!-- rebase-check -->") });
            detail += r.ok ? " The train ticked the rebase box, so Renovate rebases the branch." : ` The tick of the rebase box failed (HTTP ${r.status}).`;
          }
        }
        result({ ...base0, state: s.state, pr: prRef(pr), ci: s.ci, detail, ...mergedOf(s) });
      } catch (e) {
        result({ ...base0, state: "error", pr: null, ci: null, detail: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  /** This function finds the open pull requests with the label MERGE_LABEL in the repositories of the plan. It searches one time in a run. */
  let labeled: Promise<{ repo: string; number: number }[] | null> | undefined;
  const findLabeled = (): Promise<{ repo: string; number: number }[] | null> =>
    (labeled ??= (async () => {
      const q = `user:${owner} is:pr is:open label:${MERGE_LABEL}`;
      const found = await gh.request<{ items?: { number: number; repository_url: string }[] }>("GET", `/search/issues?per_page=100&q=${encodeURIComponent(q)}`);
      if (!found.ok || !found.data) {
        log(`GitHub did not search the pull requests with the label ${MERGE_LABEL} (HTTP ${found.status}).`);
        return null;
      }
      const inScan = new Set(scan);
      return (found.data.items ?? []).map((i) => ({ repo: i.repository_url.split("/").pop() ?? "", number: i.number })).filter((i) => inScan.has(i.repo));
    })());
  const metas = new Map<string, RepoMeta | null>();
  const metaOf = async (repo: string): Promise<RepoMeta | null> => {
    if (!metas.has(repo)) metas.set(repo, (await gh.request<RepoMeta>("GET", `${base}/${repo}`)).data);
    return metas.get(repo) ?? null;
  };

  /**
   * This function gives a queue item for each labeled pull request that settle merges `main` into in this run. It reads
   * the same facts as mergeLabeled, settle and catchUp. The branch is green and behind the default branch, and it is of
   * the same repository. It has no Renovate rebase box and no conflict, and no run of another branch is open. Its key is
   * the time of the last push of the head. It inherits the waits of the actions that wait for the release of its repository. An item that the run does not use (the facts changed) costs at most one push.
   */
  const catchUps = async (tie0: number, inherit: (own: number, start: readonly string[]) => number): Promise<Turn[]> => {
    if (o.maxPushes === undefined || o.dryRun) return [];
    const items: Turn[] = [];
    for (const { repo, number } of (await findLabeled()) ?? []) {
      const meta = await metaOf(repo);
      const main = meta?.default_branch ?? "main";
      const pr = (await gh.request<Pull>("GET", `${base}/${repo}/pulls/${number}`)).data;
      if (!pr || pr.state !== "open" || pr.draft || pr.base.ref !== main || pr.head.repo?.full_name !== `${owner}/${repo}`) continue;
      if ((pr.body ?? "").includes(RENOVATE_REBASE_BOX) || pr.mergeable === false || pr.mergeable_state === "dirty") continue;
      if ((await ciOf(repo, pr.head.sha)) !== "green") continue;
      const ageHours = pr.created_at ? ((o.now ?? new Date()).getTime() - Date.parse(pr.created_at)) / 3_600_000 : 0;
      if (ageHours < YIELD_MAX_HOURS && (await otherRuns(repo, pr.head.ref, meta)) > 0) continue;
      const cmp = await compareOf(repo, pr.head.sha, main);
      if (cmp === null || cmp.behind === 0) continue;
      const releases = o.plan.actions.filter((a) => a.repo === repo && a.kind === "release").map((a) => a.id);
      const key = `${repo}#${number}`;
      items.push({
        at: inherit(waitMs(await pushTime(repo, pr)), releases),
        tie: tie0 + items.length,
        run: async () => void caught.set(key, (await catchUp(repo, pr, main)).note),
      });
    }
    return items;
  };

  // 1. Close each open pull request of the train that the plan no longer needs.
  for (const [repo, pr] of open) {
    if (sel.needed.has(repo)) continue;
    if (o.dryRun) {
      result({ repo, actionId: null, kind: null, wave: null, state: "closed", items: 0, pr: { number: pr.number, url: pr.html_url }, autoMerge: null, ci: null, detail: "The run closes this pull request: the plan has no update for the repository." });
      continue;
    }
    await closeTrainPr(repo, pr, "the plan has no update for this repository now");
    result({ repo, actionId: null, kind: null, wave: null, state: "closed", items: 0, pr: { number: pr.number, url: pr.html_url }, autoMerge: null, ci: null, detail: "The plan has no update for the repository." });
  }

  // 2. The adoptions that wait for a release. An open pull request of the train in such a repository still merges on green,
  // except when a release in flight holds its ranges.
  for (const w of sel.waiting) {
    const pr = open.get(w.repo);
    const base0 = { repo: w.repo, private: w.private, actionId: w.actionId, kind: null, wave: w.wave, items: 0, autoMerge: null };
    if (pr && !o.dryRun && w.holdsOpen !== true) {
      const meta = (await gh.request<RepoMeta>("GET", `${base}/${w.repo}`)).data;
      await disableAutoMerge(pr);
      const s = await settle(w.repo, pr, meta);
      result({ ...base0, state: s.state === "unchanged" ? "waiting" : s.state, pr: { number: pr.number, url: pr.html_url }, ci: s.ci, detail: `${s.detail} The rest of the update waits for ${w.dependsOn.join(", ") || "npm"}.`, ...mergedOf(s) });
      continue;
    }
    result({ ...base0, state: "waiting", pr: pr ? { number: pr.number, url: pr.html_url } : null, ci: null, detail: `It waits for ${w.dependsOn.join(", ") || "the target versions on npm"}.` });
  }

  // 3 and 4. The adoptions of the current wave, the template sync and the merges of main into labeled pull requests. One
  // limit covers all of them, so with a pace they are in one queue with one key: the effective wait (see `inheritedWait`).
  // The wait of an action is the time of the last push of the open pull request of the train in its repository. An urgent
  // update goes first and does not count in the limit.
  const trainPushed = pacing ? await pushedAt(open) : new Map<string, string | undefined>();
  const dependentsOf = new Map<string, string[]>();
  for (const a of o.plan.actions) for (const d of a.dependsOn) dependentsOf.set(d, [...(dependentsOf.get(d) ?? []), a.id]);
  const actionRepo = new Map(o.plan.actions.map((a) => [a.id, a.kind === "release" ? null : a.repo]));
  const waitOf = (id: string): number | undefined => {
    const repo = actionRepo.get(id);
    const t = repo ? trainPushed.get(repo) : undefined;
    const ms = t === undefined ? Number.NaN : Date.parse(t);
    return Number.isNaN(ms) ? undefined : ms;
  };
  const inherit = (own: number, start: readonly string[]): number => inheritedWait(own, start, dependentsOf, waitOf);
  const updates = updateQueue();
  const syncs = o.sync ? await syncQueue(o.sync, updates.length) : [];
  const merges = await catchUps(updates.length + syncs.length, inherit);
  const queue = [...updates, ...syncs, ...merges];
  for (const item of pacing ? queueOrder(queue) : queue) await item.run();

  /**
   * This function gives a queue item for each adoption of the current wave: one branch and one pull request for each
   * repository. With a pace, a repository whose push must wait gets no clone. An open pull request still merges on green,
   * or gets the blocked label.
   */
  function updateQueue(): Turn[] {
    // A ready adoption waits for no action, so it is in wave 0, and the pace cannot put a later wave first. An adoption that
    // another action waits for inherits the wait of that action, so it goes first when the action waited long.
    // An update with no open pull request waits from the start of its need, so its key does not renew in each run.
    const list = pacing ? rotate(sel.ready, slot) : sel.ready;
    return list.map((u, tie) => {
      const need = pacing ? o.needSince?.(u) : undefined;
      const pushed = trainPushed.get(u.repo);
      if (pacing && pushed === undefined && need === undefined && !isUrgent(u)) {
        startFallbacks++;
        log(`${label(u.repo, u.private)}: the start of the need is not known, so the update waits from the start of this run.`);
      }
      return {
        at: isUrgent(u) ? Number.NEGATIVE_INFINITY : inherit(waitMs(pushed ?? need ?? runStart), [u.actionId]),
        tie,
        run: () => updateOne(u),
      };
    });
  }

  /** This function applies one adoption, and counts the pair of the mode `shadow` or the applied decision of the mode `one-candidate`. */
  async function updateOne(u: RepoUpdate): Promise<void> {
    const record = decisionRecord();
    const before = results.length;
    await updateRepo(u, record);
    pairOf(u.repo, u.private, "update", record, results.slice(before));
  }

  /** This function applies one adoption: one branch and one pull request for the repository. */
  async function updateRepo(u: RepoUpdate, record: DecisionRecord): Promise<void> {
    const existing = open.get(u.repo) ?? null;
    const urgent = isUrgent(u);
    const common = { repo: u.repo, private: u.private, actionId: u.actionId, kind: u.kind, wave: u.wave, items: u.items.length, ...(urgent ? { urgent } : {}), ...(u.held ? { held: u.held.items } : {}) };
    if (u.lockKind === "yarn") {
      result({ ...common, state: "skipped", pr: prRef(existing), autoMerge: null, ci: null, detail: "The train cannot update a Yarn lockfile." });
      return;
    }
    if (u.submodules?.length) {
      // Each run would fail the same way: the install in the clone does not find the packages of the submodules
      const detail = `The workspace has git submodules (${u.submodules.join(", ")}). The clone of the train has no submodules, so the install cannot find their packages. Move the package into the repository or publish it.`;
      result({ ...common, state: "skipped", pr: prRef(existing), autoMerge: null, ci: null, detail });
      return;
    }
    try {
      const metaRes = await gh.request<RepoMeta>("GET", `${base}/${u.repo}`);
      if (!metaRes.data) throw new Error(`The repository is not readable (HTTP ${metaRes.status}).`);
      const meta = metaRes.data;
      if (!existing) {
        // A person closed a pull request with the same changes: the train does not open it again.
        const declined = await declinedPr(u.repo, TRAIN_BRANCH, u.fingerprint);
        if (declined) {
          result({ ...common, state: "declined", pr: prRef(declined), autoMerge: null, ci: null, detail: "A closed pull request has the same changes. The train does not open it again." });
          return;
        }
      }
      const mode = modeOf(u.repo, u.private);
      const target = { repo: u.repo, private: u.private, branch: TRAIN_BRANCH, defaultBranch: meta.default_branch, pr: existing };
      // A branch with no candidate always gets a push from the strict rule. When the limit of the run holds that push, it
      // is held before the rules, so the mode shadow reads no fact for it.
      const heldFirst: HeldCause | null = !existing && !urgent && limitWait() !== null ? "limit" : null;
      const step = await candidateStep(mode, "update", common, target, meta, { fingerprint: u.fingerprint, items: candidateItems(u.items) }, urgent, record, heldFirst);
      if (step.done) return;
      const act = step.act;
      const rebuild = act ? act.rebuild === true : await needsRebuild(u.repo, existing, meta.default_branch);
      // A branch with these changes on the current default branch needs no push.
      const due = act !== null || !existing || rebuild || bodyFingerprint(existing.body) !== u.fingerprint;
      const wait = urgent ? null : limitWait();
      if (o.dryRun && (wait === null || !due)) {
        const what = !existing ? "The run opens a pull request" : due ? `The run updates PR #${existing.number}` : `The run keeps PR #${existing.number}`;
        if (due && !urgent) pushes += 1;
        result({ ...common, state: "planned", pr: prRef(existing), autoMerge: null, ci: null, detail: `${what} for ${u.items.length === 0 ? "the pnpm settings" : `${u.items.length} ${u.items.length === 1 ? "change" : "changes"}`}${u.items.length > 0 && u.ageScopes ? " and the pnpm settings" : ""}${u.releases?.length ? `, with the release of ${u.releases.map((x) => x.name).join(", ")}` : ""}.` });
        return;
      }
      if (wait !== null && act) {
        // The candidate rules decided the push, so the branch waits with no settle. The limit of the run holds the push.
        record.cause = "limit";
        if (existing && !o.dryRun) await disableAutoMerge(existing);
        result({ ...common, state: "waiting", paced: true, pr: prRef(existing), autoMerge: existing ? "train" : null, ci: null, detail: `${act.reason}. ${wait}` });
        return;
      }
      if (wait !== null) {
        // No clone: each clone can push. The next run reads the plan again, so it pushes the newest versions.
        if (existing && !o.dryRun) await disableAutoMerge(existing);
        const s = existing && !o.dryRun ? await settle(u.repo, existing, meta) : null;
        const state: RepoState = !s || (due && s.state === "unchanged") ? "waiting" : s.state;
        record.cause = state === "waiting" ? "limit" : (s?.held ?? null);
        record.caughtUp = s?.caughtUp === true;
        const detail = state === "waiting" ? `${s ? `${s.detail} ` : ""}${wait}` : (s?.detail ?? wait);
        result({ ...common, state, ...(state === "waiting" ? { paced: true } : {}), pr: prRef(existing), autoMerge: s ? "train" : null, ci: s?.ci ?? null, detail, ...(s ? mergedOf(s) : {}) });
        return;
      }
      const urgentDeps = [...new Set(u.items.map((i) => i.dep).filter((dep) => urgentNames.has(dep)))];
      const r = await o.updater.update(urgent ? { ...u, urgentDeps } : u, { defaultBranch: meta.default_branch, rebuild });
      if (r.status === "pushed" && !urgent) pushes += 1;
      if (r.status === "failed") {
        record.cause = "error";
        result({ ...common, state: "error", pr: prRef(existing), autoMerge: null, ci: null, detail: `The update failed: ${r.error ?? "unknown error"}` });
        return;
      }
      if (r.status === "young") {
        record.cause = "young";
        // CI refuses a lockfile with a version younger than the minimumReleaseAge of pnpm. The update waits for its age.
        const ready = r.young.map((y) => `${y.dep}@${y.version} at ${y.readyAt}`).join(", ");
        if (existing) await closeTrainPr(u.repo, existing, `its versions are younger than the minimumReleaseAge of pnpm. A later run opens it again (ready: ${ready})`);
        result({ ...common, state: "waiting", pr: prRef(existing), autoMerge: null, ci: null, detail: `It waits for the minimumReleaseAge of pnpm: ${ready}.${existing ? " The train closed the pull request." : ""}` });
        return;
      }
      if ((r.status === "no-change" || r.status === "unresolved") && !existing) {
        const why = r.status === "no-change" ? "The update changes no file." : `The lockfile does not get the target versions (${r.unresolved.join(", ")}).`;
        record.cause = "skip";
        result({ ...common, state: "skipped", pr: null, autoMerge: null, ci: null, detail: why });
        return;
      }
      const shown: RepoUpdate = { ...u, items: u.items.filter((i) => !r.young.some((y) => y.dep === i.dep)) };
      const pushed = r.status === "pushed";
      await publish({
        common,
        branch: TRAIN_BRANCH,
        existing,
        meta,
        pushed,
        sha: r.sha,
        title: prTitle(shown),
        body: prBody(shown, r, marksOf(mode, attemptOf(existing, u.fingerprint, pushed, act, record.facts?.ci?.state === "failed"), candidateItems(shown.items))),
        note: r.unresolved.length > 0 ? ` Unresolved: ${r.unresolved.join(", ")}.` : "",
        settle: act === null,
        ...(act?.removeLabel ? { removeLabel: policy.retryLabel } : {}),
        record,
      });
    } catch (e) {
      record.cause = "error";
      result({ ...common, state: "error", pr: prRef(existing), autoMerge: null, ci: null, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * This function gives a queue item for the template sync of each repository. A rule that changes workflow files waits
   * when the App cannot change them. In mode `auto`, the first push that GitHub refuses turns these rules off for the rest
   * of the run.
   */
  async function syncQueue(s: SyncOptions, tie0: number): Promise<Turn[]> {
    if (!s.facts) {
      log("Template sync: the template is not readable, so the sync waits.");
      return [];
    }
    const rules = s.rules ?? SYNC_RULES;
    // The files of each repository, read one time. The Renovate days need the files of all repositories of the plan.
    const filesCache = new Map<string, Promise<RepoFiles | null>>();
    const filesOf = (repo: string): Promise<RepoFiles | null> => {
      let p = filesCache.get(repo);
      if (!p) {
        p = apiFiles(gh, owner, repo);
        filesCache.set(repo, p);
      }
      return p;
    };
    const facts0: RunFacts = rules.some((r) => r.id === "renovate-day")
      ? {
          ...s.facts,
          renovateDay: await renovateDays(
            await pool(o.plan.repos, o.concurrency ?? 6, async (r) => ({ repo: r.name, files: await filesOf(r.name).catch(() => null) })),
            s.facts,
          ),
        }
      : s.facts;
    const syncOpen = await openOf(SYNC_BRANCH);
    const syncPushed = pacing ? await pushedAt(syncOpen) : new Map<string, string | undefined>();
    // A repository with no open sync pull request waits from the template commit that it needs, not from for ever.
    const syncSince = pacing ? ((await commitDate(TEMPLATE_REPO, s.facts.templateSha)) ?? runStart) : runStart;
    const pending = pendingVersions(o.plan, o.only ?? null);
    const changesets = new Set(o.plan.repos.filter((r) => (r.pendingChangesets ?? 0) > 0).map((r) => r.name));
    let workflows = s.workflows !== "no";
    /** This function syncs the template files of one repository. */
    const syncOne = async (repo: string, record: DecisionRecord): Promise<void> => {
      const isPrivate = privateOf.get(repo) ?? true;
      const existing = syncOpen.get(repo) ?? null;
      const facts: SyncFacts = { ...facts0, repo, releaseInFlight: pending.has(repo) || changesets.has(repo) };
      const commonOf = (r: SyncResult) => ({
        repo,
        private: isPrivate,
        actionId: `sync:${repo}`,
        kind: SYNC_KIND,
        wave: null,
        items: r.outcomes.filter((x) => x.state === "applied").reduce((n, x) => n + x.changes.length, 0),
        needs: syncNeeds(r),
      });
      const fail = (detail: string) => {
        record.cause = "error";
        result({ repo, private: isPrivate, actionId: `sync:${repo}`, kind: SYNC_KIND, wave: null, items: 0, state: "error", pr: prRef(existing), autoMerge: null, ci: null, detail });
      };
      try {
        const files = await filesOf(repo);
        if (!files) return;
        let planned = await syncRepo(files, facts, rules, workflows);
        const applied = (r: SyncResult): string[] => r.outcomes.filter((x) => x.state === "applied").map((x) => x.rule);
        /** This function closes the open sync pull request, or reports the problems of a repository with no change. */
        const nothing = async (r: SyncResult): Promise<void> => {
          const common = commonOf(r);
          if (existing) {
            if (!o.dryRun) await closeTrainPr(repo, existing, "the template files of this repository are in sync now", SYNC_BRANCH);
            result({ ...common, state: "closed", pr: prRef(existing), autoMerge: null, ci: null, detail: `${o.dryRun ? "The run closes this pull request: " : ""}The template files are in sync.` });
          } else if (common.needs.length > 0) {
            result({ ...common, state: "skipped", pr: null, autoMerge: null, ci: null, detail: "No template file changes now." });
          }
        };
        if (applied(planned).length === 0) {
          await nothing(planned);
          return;
        }
        const metaRes = await gh.request<RepoMeta>("GET", `${base}/${repo}`);
        if (!metaRes.data) throw new Error(`The repository is not readable (HTTP ${metaRes.status}).`);
        const meta = metaRes.data;
        if (!existing) {
          const declined = await declinedPr(repo, SYNC_BRANCH, planned.fingerprint);
          if (declined) {
            result({ ...commonOf(planned), state: "declined", pr: prRef(declined), autoMerge: null, ci: null, detail: "A closed pull request has the same changes. The train does not open it again." });
            return;
          }
        }
        const mode = modeOf(repo, isPrivate);
        const target = { repo, private: isPrivate, branch: SYNC_BRANCH, defaultBranch: meta.default_branch, pr: existing };
        // A branch with no candidate always gets a push from the strict rule. When the limit of the run or the busy runners
        // hold that push, it is held before the rules, so the mode shadow reads no fact for it. The wait is read one time.
        const waitOf = async (): Promise<{ wait: string | null; cause: HeldCause | null }> => {
          const limit = limitWait();
          if (limit !== null) return { wait: limit, cause: "limit" };
          const busy = await busyWait();
          return { wait: busy, cause: busy !== null ? "busy" : null };
        };
        const early = mode === "shadow" && !existing ? await waitOf() : null;
        const step = await candidateStep(mode, "sync", commonOf(planned), target, meta, { fingerprint: planned.fingerprint, items: null }, false, record, early?.cause ?? null);
        if (step.done) return;
        const act = step.act;
        const rebuild = act ? act.rebuild === true : await needsRebuild(repo, existing, meta.default_branch);
        const same = act === null && existing !== null && !rebuild && bodyFingerprint(existing.body) === planned.fingerprint;
        const held = same ? { wait: null, cause: null } : (early ?? (await waitOf()));
        const wait = held.wait;
        if (wait !== null) {
          record.cause = held.cause;
          result({ ...commonOf(planned), state: "waiting", paced: true, pr: prRef(existing), autoMerge: null, ci: null, detail: act ? `${act.reason}. ${wait}` : wait });
          return;
        }
        if (o.dryRun) {
          const what = existing ? `The run updates PR #${existing.number}` : "The run opens a pull request";
          if (!same) pushes += 1;
          result({ ...commonOf(planned), state: "planned", pr: prRef(existing), autoMerge: null, ci: null, detail: `${what} for the template sync: ${applied(planned).join(", ")}.` });
          return;
        }
        let r: SyncPush;
        if (existing && same) {
          // The branch has these changes already: no clone and no push.
          r = { status: "same", sha: existing.head.sha, result: planned, tool: null, error: null };
        } else {
          pushes += 1;
          const ctx = { defaultBranch: meta.default_branch, rebuild };
          r = await s.updater.sync({ repo, facts, workflows, rules }, ctx);
          if (r.status === "workflows-denied" && workflows) {
            workflows = false;
            log("Template sync: GitHub refused a workflow change, because the App has no Workflows permission. The rules that change workflow files wait.");
            planned = await syncRepo(files, facts, rules, false);
            r = applied(planned).length > 0 ? await s.updater.sync({ repo, facts, workflows, rules }, ctx) : { status: "no-change", sha: null, result: planned, tool: null, error: null };
          }
        }
        if (r.status === "failed" || r.status === "workflows-denied") {
          fail(`The template sync failed: ${r.error ?? "unknown error"}`);
          return;
        }
        const done = r.result ?? planned;
        if (r.status === "no-change" || applied(done).length === 0) {
          record.cause = "skip";
          await nothing(done);
          return;
        }
        const pushed = r.status === "pushed";
        await publish({
          common: commonOf(done),
          branch: SYNC_BRANCH,
          existing,
          meta,
          pushed,
          sha: r.sha,
          title: SYNC_TITLE,
          // Without a new clone, the body keeps the name of the tool that made the lockfile.
          body: existing && r.status === "same" && r.tool === null && existing.body ? existing.body : syncPrBody(done, r.tool, rules, marksOf(mode, attemptOf(existing, done.fingerprint, pushed, act, record.facts?.ci?.state === "failed"), null)),
          note: "",
          settle: act === null,
          ...(act?.removeLabel ? { removeLabel: policy.retryLabel } : {}),
          record,
        });
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    };
    const list = pacing ? rotate(scan, slot) : scan;
    const syncPaired = async (repo: string): Promise<void> => {
      const record = decisionRecord();
      const before = results.length;
      await syncOne(repo, record);
      pairOf(repo, privateOf.get(repo) ?? true, "sync", record, results.slice(before));
    };
    return list.map((repo, i) => ({ at: waitMs(syncPushed.get(repo) ?? syncSince), tie: tie0 + i, run: () => syncPaired(repo) }));
  }

  // 5. The releases. A public package whose version on main is newer than npm is in flight: its release workflow publishes it.
  // A repository whose release workflow starts only by hand (for example with changesets) needs a dispatch after green CI on main.
  // Only a version that a release workflow publishes soon is in flight: a workflow that starts on a push, a workflow that runs,
  // or a workflow that this run started. A version of a workflow that waits for a start by hand is not in flight.
  const inFlight: { name: string; version: string }[] = [];
  const infoOf = new Map(o.plan.repos.map((r) => [r.name, r]));
  const pendingOf = pendingVersions(o.plan, o.only ?? null);
  const releaseRepos = new Set(pendingOf.keys());
  for (const r of o.plan.repos) if (!r.private && (r.pendingChangesets ?? 0) > 0 && (!o.only || o.only.includes(r.name))) releaseRepos.add(r.name);
  const fly = (repo: string): void => void inFlight.push(...(pendingOf.get(repo) ?? []));
  for (const repo of releaseRepos) {
    const info = infoOf.get(repo);
    const changesets = info?.pendingChangesets ?? 0;
    const base0 = { repo, private: false, actionId: `release:${repo}`, kind: "release", wave: null, items: 0, autoMerge: null };
    try {
      const wf = await gh.request<{ content?: string }>("GET", `${base}/${repo}/contents/.github/workflows/release.yml`);
      const text = wf.data?.content ? Buffer.from(wf.data.content, "base64").toString("utf8") : "";
      if (!text) continue;
      if (!dispatchOnly(text)) {
        // A last release run that failed does not publish again by itself, so its versions are not in flight.
        if (await lastReleaseFlies(repo)) fly(repo);
        continue;
      }
      if (!o.releaseDispatch) continue;
      const metaRes = await gh.request<RepoMeta>("GET", `${base}/${repo}`);
      const meta = metaRes.data;
      if (!meta) throw new Error(`The repository is not readable (HTTP ${metaRes.status}).`);
      // A version pull request of changesets merges on green. Its merge makes the version on main newer than npm.
      const vpr = (await gh.request<Pull[]>("GET", `${base}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(VERSION_BRANCH)}&per_page=5`)).data?.[0];
      if (vpr) {
        if (o.dryRun) {
          result({ ...base0, state: "planned", pr: { number: vpr.number, url: vpr.html_url }, ci: null, detail: "The run merges the version pull request when CI is green." });
          continue;
        }
        const s = await settle(repo, vpr, meta, VERSION_BRANCH);
        result({ ...base0, state: s.state, pr: { number: vpr.number, url: vpr.html_url }, ci: s.ci, detail: `Version pull request: ${s.detail}`, ...mergedOf(s) });
        continue;
      }
      const runs = await gh.request<{ workflow_runs: { status: string }[] }>("GET", `${base}/${repo}/actions/workflows/release.yml/runs?branch=${encodeURIComponent(meta.default_branch)}&per_page=5`);
      if ((runs.data?.workflow_runs ?? []).some((x) => x.status !== "completed")) {
        fly(repo);
        result({ ...base0, state: "waiting", pr: null, ci: null, detail: "The release workflow runs." });
        continue;
      }
      const head = (await gh.request<{ sha: string }>("GET", `${base}/${repo}/commits/${encodeURIComponent(meta.default_branch)}`)).data?.sha;
      const ci = head ? await ciOf(repo, head) : "none";
      if (ci !== "green") {
        result({ ...base0, state: "waiting", pr: null, ci, detail: `The release waits for green CI on ${meta.default_branch}.` });
        continue;
      }
      const what = changesets > 0 ? "the version pull request" : "the publish";
      if (o.dryRun) {
        result({ ...base0, state: "planned", pr: null, ci, detail: `The run starts the release workflow for ${what}.` });
        continue;
      }
      const d = await gh.request("POST", `${base}/${repo}/actions/workflows/release.yml/dispatches`, { ref: meta.default_branch });
      if (!d.ok) {
        const need = d.status === 403 || d.status === 404 ? " The GitHub App needs the permission Actions: write." : "";
        result({ ...base0, state: "error", pr: null, ci, detail: `The dispatch of the release workflow failed (HTTP ${d.status}).${need}` });
        continue;
      }
      fly(repo);
      result({ ...base0, state: "opened", pr: null, ci, detail: `The train started the release workflow for ${what}.` });
    } catch (e) {
      result({ ...base0, state: "error", pr: null, ci: null, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  // 6. The pull requests of other authors with the label MERGE_LABEL, for example the Renovate pins of workflow actions.
  // A merge by Renovate or by the auto-merge of GitHub has no hold for a release run, so GitHub can refuse a tag. The train
  // merges them with the holds of settle. This step comes after the releases, so a release run that this run started holds too.
  await mergeLabeled();

  const changed = new Set(sel.ready.flatMap((u) => u.items.map((i) => i.dep)));
  const urgentUnused = [...new Set(o.urgent ?? [])].filter((n) => !urgentNames.has(n) || !changed.has(n)).length;
  return {
    owner,
    at: (o.now ?? new Date()).toISOString(),
    dryRun: o.dryRun,
    results,
    inFlight,
    ...(urgentUnused > 0 ? { urgentUnused } : {}),
    ...(startFallbacks > 0 ? { startFallbacks } : {}),
    ...(policy.mode !== "strict"
      ? {
          candidates: {
            mode: policy.mode,
            share: policy.share,
            pairs: [...pairs.values()].sort((a, b) => b.count - a.count),
            held: [...heldPairs.values()].sort((a, b) => b.count - a.count),
            acted: [...actedCounts.values()].sort((a, b) => b.count - a.count),
            requests: reader.requests(),
          },
        }
      : {}),
  };
}

/** The branch of the version pull request of changesets. */
export const VERSION_BRANCH = "changeset-release/main";

/** This function tells if a release workflow starts only by hand: it has `workflow_dispatch` and no `push` trigger. */
export function dispatchOnly(workflow: string): boolean {
  const lines = workflow.split("\n").map((l) => l.trim());
  const push = lines.some((l) => l.startsWith("push:") || l === "push" || l === "- push" || l.startsWith("on: push") || (l.startsWith("on: [") && l.includes("push")));
  return !push && lines.some((l) => l.startsWith("workflow_dispatch"));
}
