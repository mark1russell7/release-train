import { createHash, createHmac } from "node:crypto";
import semver from "semver";
import { pool } from "./collect.ts";
import type { GitHub } from "./github.ts";
import type { Action, Plan } from "./plan.ts";
import type { DepType, LockKind } from "./types.ts";
import { ownScopes } from "./settings.ts";

/** The branch of each pull request of the release train. */
export const TRAIN_BRANCH = "release-train/update";
/** The label of each pull request of the release train. */
export const TRAIN_LABEL = "release-train";
/** The label of a pull request of the release train with a failed CI. */
export const BLOCKED_LABEL = "release-train:blocked";
/** The last line of each pull request body of the release train. */
export const CLAUDE_LINE = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

const MARK = "<!-- release-train:fingerprint=";
/** The train adds this mark to the body of a pull request that it closes itself, so a closed train pull request is not "declined". */
const CLOSED_MARK = "<!-- release-train:closed-by-train -->";

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
  items: UpdateItem[];
  /** The published packages of the repository that release with this update: the train adds their version bump. */
  releases?: ReleaseItem[];
  /** The scopes that the update puts into `minimumReleaseAgeExclude` of pnpm, or null when the settings need no change. */
  ageScopes?: string[] | null;
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

/** An adoption that waits for a release of a package that it needs. */
export interface WaitingUpdate {
  repo: string;
  private: boolean;
  actionId: string;
  wave: number;
  dependsOn: string[];
}

/** The adoptions of a plan, split into the adoptions of the current wave and the adoptions that wait. */
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
 * This function selects the adoptions that the train applies in this run. An adoption is ready when it waits for no action
 * of the plan and npm has the target version of each of its items. Each other adoption waits for a later run.
 */
export function selectUpdates(p: Plan, only: readonly string[] | null = null): Selection {
  const latest = new Map(p.nodes.filter((n) => n.kind === "package").map((n) => [n.name, n.npmLatest]));
  const lock = new Map(p.repos.map((r) => [r.name, r.lockKind]));
  const scopes = ownScopes(p.owner);
  const ageRule = new Set(p.repos.filter((r) => r.needsAgeRule).map((r) => r.name));
  const ageScopes = (repo: string): string[] | null => (ageRule.has(repo) ? scopes : null);
  // A breaking adoption of a public repository with a cascade release carries the version bump in the same pull request:
  // after the merge, the plan no longer sees the need for the release. A release that waits for something else holds the adoption.
  const releaseOf = new Map(p.actions.filter((a) => a.kind === "release" && !a.repoPrivate && a.packages.some((x) => x.bump !== null)).map((a) => [a.repo, a]));
  const pick = (repo: string): boolean => !only || only.includes(repo);
  const ready: RepoUpdate[] = [];
  const waiting: WaitingUpdate[] = [];
  const needed = new Set<string>();
  for (const a of p.actions) {
    if (!isAdopt(a)) continue;
    needed.add(a.repo);
    if (!pick(a.repo)) continue;
    const onNpm = a.items.every((i) => {
      const l = latest.get(i.dep);
      return Boolean(l && semver.valid(l) && semver.valid(i.to) && semver.gte(l, i.to));
    });
    const rel = a.kind === "adopt-breaking" ? releaseOf.get(a.repo) : undefined;
    const relWaits = rel ? (rel.blocked ? [`blocked:${rel.id}`] : rel.dependsOn.filter((d) => d !== a.id)) : [];
    if (a.dependsOn.length > 0 || !onNpm || relWaits.length > 0) {
      waiting.push({ repo: a.repo, private: a.repoPrivate, actionId: a.id, wave: a.wave, dependsOn: [...a.dependsOn, ...relWaits] });
      continue;
    }
    const releases: ReleaseItem[] = (rel?.packages ?? [])
      .filter((x) => x.bump !== null && x.from !== null)
      .map((x) => ({
        name: x.name,
        path: x.path,
        from: x.from as string,
        changes: a.items.filter((i) => i.dependent === x.name && i.newRange && RUNTIME.has(i.type)).map((i) => ({ dep: i.dep, type: i.type })),
      }));
    const items: UpdateItem[] = a.items.map((i) => ({
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
      kind: a.kind,
      wave: a.wave,
      why: a.why,
      lockKind: lock.get(a.repo) ?? "none",
      items,
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
  tool: string | null;
  error: string | null;
  /** The version bumps of the cascade that the update added. */
  releases?: ReleaseDone[];
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
  /** `native`: GitHub merges on green. `train`: the train merges on green in a later run. */
  autoMerge: "native" | "train" | null;
  ci: CiState | null;
  detail: string;
}

/** The result of one run of the train. */
export interface ApplyReport {
  owner: string;
  at: string;
  dryRun: boolean;
  results: RepoResult[];
  /** The public packages whose version on main is not on npm yet. The release workflow of each repository publishes them. */
  inFlight?: { name: string; version: string }[];
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
}

interface Pull {
  number: number;
  html_url: string;
  node_id: string;
  title: string;
  body: string | null;
  state: string;
  merged_at?: string | null;
  mergeable?: boolean | null;
  auto_merge?: unknown;
  head: { sha: string; ref: string };
  base: { ref: string };
  labels?: { name: string }[];
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
export function prBody(u: RepoUpdate, r: (Pick<UpdateResult, "changes" | "unresolved" | "tool"> & { young?: YoungItem[]; releases?: ReleaseDone[] }) | null): string {
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
  lines.push("## Other lockfile changes", "");
  if (other.length === 0) lines.push("None.");
  else for (const c of other) lines.push(`- \`${c.dep}\` in \`${c.path || "."}\`: ${c.from ?? "none"} -> ${c.to ?? "removed"}`);
  if (r && r.unresolved.length > 0) {
    lines.push("", `The lockfile does not hold the target version of: ${r.unresolved.map((d) => `\`${d}\``).join(", ")}. A next run tries again.`);
  }
  if (r?.young && r.young.length > 0) {
    const list = r.young.map((y) => `\`${y.dep}@${y.version}\` (ready at ${y.readyAt})`).join(", ");
    lines.push("", `These versions are younger than the minimumReleaseAge of pnpm, so a later run adds them: ${list}.`);
  }
  lines.push(
    "",
    `The train made the lockfile with \`${r?.tool ?? "the package manager of the repository"}\`. It merges this pull request when CI is green. When CI fails, it adds the label \`${BLOCKED_LABEL}\` and keeps the pull request open.`,
    "",
    `${MARK}${u.fingerprint} -->`,
    CLAUDE_LINE,
  );
  return lines.join("\n");
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
    results: r.results.map((x) =>
      x.private
        ? { ...x, repo: hashName(x.repo, key), actionId: null, pr: null, detail: `A private repository: ${x.state}.` }
        : x,
    ),
  };
}

/** This function gives a text summary of a report: the pull requests by wave and the state of each repository. */
export function applySummary(r: ApplyReport): string {
  const lines = [`Release train apply for ${r.owner} at ${r.at}${r.dryRun ? " (dry run)" : ""}`];
  const prStates = new Set<RepoState>(["planned", "opened", "updated", "unchanged", "merged", "blocked"]);
  const waves = [...new Set(r.results.filter((x) => prStates.has(x.state)).map((x) => x.wave ?? 0))].sort((a, b) => a - b);
  for (const w of waves) {
    const xs = r.results.filter((x) => prStates.has(x.state) && (x.wave ?? 0) === w);
    const pub = xs.filter((x) => !x.private).map((x) => x.repo);
    lines.push(`Wave ${w}: ${xs.length} pull requests. Public: ${pub.join(", ") || "none"}. Count of private repositories: ${xs.length - pub.length}.`);
  }
  const wait = r.results.filter((x) => x.state === "waiting");
  if (wait.length > 0) {
    lines.push(`Waiting for a release: ${wait.length}. Public: ${wait.filter((x) => !x.private).map((x) => x.repo).join(", ") || "none"}. Count of private repositories: ${wait.filter((x) => x.private).length}.`);
  }
  const counts = new Map<RepoState, number>();
  for (const x of r.results) counts.set(x.state, (counts.get(x.state) ?? 0) + 1);
  lines.push(`States: ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`, "");
  for (const x of r.results) {
    const pr = x.pr ? ` ${x.pr.url}` : "";
    const am = x.autoMerge ? ` merge=${x.autoMerge}` : "";
    const ci = x.ci ? ` ci=${x.ci}` : "";
    lines.push(`- ${x.repo}: ${x.state}${x.wave === null ? "" : ` (wave ${x.wave})`}${pr}${am}${ci}. ${x.detail}`);
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
  const sel = selectUpdates(o.plan, o.only ?? null);
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

  // The open pull requests of the train, in each repository of the plan.
  const open = new Map<string, Pull>();
  await pool(scan, o.concurrency ?? 6, async (repo) => {
    const res = await gh.request<Pull[]>("GET", `${base}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(TRAIN_BRANCH)}&per_page=10`);
    const pr = (res.data ?? []).find((p) => p.head.ref === TRAIN_BRANCH);
    if (pr) open.set(repo, pr);
  });

  const ensureLabels = async (repo: string): Promise<void> => {
    for (const [name, color, description] of [
      [TRAIN_LABEL, "1d76db", "A pull request of the release train."],
      [BLOCKED_LABEL, "b60205", "CI failed on a pull request of the release train."],
    ] as const) {
      await gh.request("POST", `${base}/${repo}/labels`, { name, color, description });
    }
  };

  const enableAutoMerge = async (repo: string, pr: Pull, meta: RepoMeta): Promise<"native" | "train"> => {
    if (pr.auto_merge) return "native";
    const mutation = "mutation($id: ID!, $m: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $m }) { clientMutationId } }";
    const vars = { id: pr.node_id, m: mergeMethod(meta).toUpperCase() };
    let res = await gh.graphql(mutation, vars);
    if (res.errors.length > 0 && !meta.allow_auto_merge && res.errors.some((e) => /auto.?merge is not allowed|not allowed for this repository/i.test(e))) {
      const set = await gh.request("PATCH", `${base}/${repo}`, { allow_auto_merge: true });
      if (set.ok) res = await gh.graphql(mutation, vars);
    }
    return res.errors.length === 0 ? "native" : "train";
  };

  const ciOf = async (repo: string, sha: string): Promise<CiState> => {
    const runs = await gh.request<{ check_runs: CheckRun[] }>("GET", `${base}/${repo}/commits/${sha}/check-runs?per_page=100`);
    const status = await gh.request<{ state: string; total_count: number }>("GET", `${base}/${repo}/commits/${sha}/status`);
    return ciState(runs.data?.check_runs ?? [], status.data);
  };

  const hasLabel = (pr: Pull, name: string): boolean => (pr.labels ?? []).some((l) => l.name === name);

  /** This function merges a green pull request, or labels a red one. It gives the new state. */
  const settle = async (repo: string, pr: Pull, autoMerge: "native" | "train", meta: RepoMeta | null, branch: string = TRAIN_BRANCH): Promise<{ state: RepoState; ci: CiState; detail: string }> => {
    const ci = await ciOf(repo, pr.head.sha);
    if (ci === "failed") {
      if (!hasLabel(pr, BLOCKED_LABEL)) await gh.request("POST", `${base}/${repo}/issues/${pr.number}/labels`, { labels: [BLOCKED_LABEL] });
      return { state: "blocked", ci, detail: "CI failed. The pull request stays open with the blocked label." };
    }
    if (ci === "green" && autoMerge === "train") {
      const m = await gh.request("PUT", `${base}/${repo}/pulls/${pr.number}/merge`, { merge_method: mergeMethod(meta), sha: pr.head.sha });
      if (m.ok) {
        await gh.request("DELETE", `${base}/${repo}/git/refs/heads/${branch}`);
        return { state: "merged", ci, detail: "CI was green. The train merged the pull request." };
      }
      return { state: "unchanged", ci, detail: `CI is green, but the merge failed (HTTP ${m.status}${m.message ? `: ${m.message}` : ""}).` };
    }
    const why = ci === "none" ? "No CI check started yet." : ci === "running" ? "CI runs." : "CI is green. GitHub merges it.";
    return { state: "unchanged", ci, detail: why };
  };

  /** This function closes a pull request of the train with a comment, marks it as closed by the train and deletes the branch. */
  const closeTrainPr = async (repo: string, pr: Pull, why: string): Promise<void> => {
    await gh.request("POST", `${base}/${repo}/issues/${pr.number}/comments`, { body: `The release train closes this pull request: ${why}.\n\n${CLAUDE_LINE}` });
    await gh.request("PATCH", `${base}/${repo}/pulls/${pr.number}`, { state: "closed", body: `${pr.body ?? ""}\n${CLOSED_MARK}` });
    await gh.request("DELETE", `${base}/${repo}/git/refs/heads/${TRAIN_BRANCH}`);
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

  // 2. The adoptions that wait for a release. An open pull request of the train in such a repository still merges on green.
  for (const w of sel.waiting) {
    const pr = open.get(w.repo);
    const base0 = { repo: w.repo, private: w.private, actionId: w.actionId, kind: null, wave: w.wave, items: 0, autoMerge: null };
    if (pr && !o.dryRun) {
      const meta = (await gh.request<RepoMeta>("GET", `${base}/${w.repo}`)).data;
      const s = await settle(w.repo, pr, pr.auto_merge ? "native" : "train", meta);
      result({ ...base0, state: s.state === "unchanged" ? "waiting" : s.state, pr: { number: pr.number, url: pr.html_url }, ci: s.ci, detail: `${s.detail} The rest of the update waits for ${w.dependsOn.join(", ") || "npm"}.` });
      continue;
    }
    result({ ...base0, state: "waiting", pr: pr ? { number: pr.number, url: pr.html_url } : null, ci: null, detail: `It waits for ${w.dependsOn.join(", ") || "the target versions on npm"}.` });
  }

  // 3. The adoptions of the current wave.
  for (const u of sel.ready) {
    const existing = open.get(u.repo) ?? null;
    const common = { repo: u.repo, private: u.private, actionId: u.actionId, kind: u.kind, wave: u.wave, items: u.items.length };
    const prRef = (p: Pull | null) => (p ? { number: p.number, url: p.html_url } : null);
    if (u.lockKind === "yarn") {
      result({ ...common, state: "skipped", pr: prRef(existing), autoMerge: null, ci: null, detail: "The train cannot update a Yarn lockfile." });
      continue;
    }
    if (o.dryRun) {
      const what = existing ? `The run updates PR #${existing.number}` : "The run opens a pull request";
      result({ ...common, state: "planned", pr: prRef(existing), autoMerge: null, ci: null, detail: `${what} for ${u.items.length === 0 ? "the pnpm settings" : `${u.items.length} ${u.items.length === 1 ? "change" : "changes"}`}${u.items.length > 0 && u.ageScopes ? " and the pnpm settings" : ""}.` });
      continue;
    }
    try {
      const metaRes = await gh.request<RepoMeta>("GET", `${base}/${u.repo}`);
      if (!metaRes.data) throw new Error(`The repository is not readable (HTTP ${metaRes.status}).`);
      const meta = metaRes.data;
      if (!existing) {
        // A person closed a pull request with the same changes: the train does not open it again.
        const closed = await gh.request<Pull[]>("GET", `${base}/${u.repo}/pulls?state=closed&head=${owner}:${encodeURIComponent(TRAIN_BRANCH)}&per_page=20`);
        const declined = (closed.data ?? []).find((p) => !p.merged_at && !(p.body ?? "").includes(CLOSED_MARK) && bodyFingerprint(p.body) === u.fingerprint);
        if (declined) {
          result({ ...common, state: "declined", pr: prRef(declined), autoMerge: null, ci: null, detail: "A closed pull request has the same changes. The train does not open it again." });
          continue;
        }
      }
      let rebuild = false;
      if (existing) {
        const full = await gh.request<Pull>("GET", `${base}/${u.repo}/pulls/${existing.number}`);
        rebuild = full.data?.mergeable === false;
      }
      const r = await o.updater.update(u, { defaultBranch: meta.default_branch, rebuild });
      if (r.status === "failed") {
        result({ ...common, state: "error", pr: prRef(existing), autoMerge: null, ci: null, detail: `The update failed: ${r.error ?? "unknown error"}` });
        continue;
      }
      if (r.status === "young") {
        // CI refuses a lockfile with a version younger than the minimumReleaseAge of pnpm. The update waits for its age.
        const ready = r.young.map((y) => `${y.dep}@${y.version} at ${y.readyAt}`).join(", ");
        if (existing) await closeTrainPr(u.repo, existing, `its versions are younger than the minimumReleaseAge of pnpm. A later run opens it again (ready: ${ready})`);
        result({ ...common, state: "waiting", pr: prRef(existing), autoMerge: null, ci: null, detail: `It waits for the minimumReleaseAge of pnpm: ${ready}.${existing ? " The train closed the pull request." : ""}` });
        continue;
      }
      if ((r.status === "no-change" || r.status === "unresolved") && !existing) {
        const why = r.status === "no-change" ? "The update changes no file." : `The lockfile does not get the target versions (${r.unresolved.join(", ")}).`;
        result({ ...common, state: "skipped", pr: null, autoMerge: null, ci: null, detail: why });
        continue;
      }
      const shown: RepoUpdate = { ...u, items: u.items.filter((i) => !r.young.some((y) => y.dep === i.dep)) };
      const title = prTitle(shown);
      const body = prBody(shown, r);
      let pr: Pull;
      let state: RepoState;
      if (existing) {
        pr = existing;
        state = r.status === "pushed" ? "updated" : "unchanged";
        if (r.status === "pushed" || existing.body !== body || existing.title !== title) {
          const upd = await gh.request<Pull>("PATCH", `${base}/${u.repo}/pulls/${existing.number}`, { title, body });
          if (upd.data) pr = { ...upd.data, labels: existing.labels ?? [] };
        }
        if (r.status === "pushed") {
          pr = { ...pr, head: { ...pr.head, sha: r.sha ?? pr.head.sha } };
          if (hasLabel(existing, BLOCKED_LABEL)) {
            await gh.request("DELETE", `${base}/${u.repo}/issues/${existing.number}/labels/${encodeURIComponent(BLOCKED_LABEL)}`);
            pr = { ...pr, labels: (pr.labels ?? []).filter((l) => l.name !== BLOCKED_LABEL) };
          }
        }
      } else {
        const made = await gh.request<Pull>("POST", `${base}/${u.repo}/pulls`, { title, body, head: TRAIN_BRANCH, base: meta.default_branch });
        if (!made.data) throw new Error(`GitHub did not open the pull request (HTTP ${made.status}${made.message ? `: ${made.message}` : ""}).`);
        pr = made.data;
        state = "opened";
      }
      await ensureLabels(u.repo);
      if (!hasLabel(pr, TRAIN_LABEL)) await gh.request("POST", `${base}/${u.repo}/issues/${pr.number}/labels`, { labels: [TRAIN_LABEL] });
      const autoMerge = await enableAutoMerge(u.repo, pr, meta);
      const how = autoMerge === "native" ? "GitHub auto-merge is on." : "The train merges it on green in a later run.";
      if (state === "opened" || state === "updated") {
        result({ ...common, state, pr: prRef(pr), autoMerge, ci: "none", detail: `${how}${r.unresolved.length > 0 ? ` Unresolved: ${r.unresolved.join(", ")}.` : ""}` });
        continue;
      }
      const s = await settle(u.repo, pr, autoMerge, meta);
      result({ ...common, state: s.state, pr: prRef(pr), autoMerge, ci: s.ci, detail: `${s.detail} ${how}` });
    } catch (e) {
      result({ ...common, state: "error", pr: prRef(existing), autoMerge: null, ci: null, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  // 4. The releases. A public package whose version on main is newer than npm is in flight: its release workflow publishes it.
  // A repository whose release workflow starts only by hand (for example with changesets) needs a dispatch after green CI on main.
  const inFlight: { name: string; version: string }[] = [];
  const infoOf = new Map(o.plan.repos.map((r) => [r.name, r]));
  const releaseRepos = new Set<string>();
  for (const a of o.plan.actions) {
    if (a.kind !== "release" || a.repoPrivate || a.blocked || (o.only && !o.only.includes(a.repo))) continue;
    const pending = a.packages.filter((x) => x.bump === null && x.to !== null);
    for (const x of pending) inFlight.push({ name: x.name, version: x.to as string });
    if (pending.length > 0) releaseRepos.add(a.repo);
  }
  for (const r of o.plan.repos) if (!r.private && (r.pendingChangesets ?? 0) > 0 && (!o.only || o.only.includes(r.name))) releaseRepos.add(r.name);
  if (o.releaseDispatch) {
    for (const repo of releaseRepos) {
      const info = infoOf.get(repo);
      const changesets = info?.pendingChangesets ?? 0;
      const base0 = { repo, private: false, actionId: `release:${repo}`, kind: "release", wave: null, items: 0, autoMerge: null };
      try {
        const wf = await gh.request<{ content?: string }>("GET", `${base}/${repo}/contents/.github/workflows/release.yml`);
        const text = wf.data?.content ? Buffer.from(wf.data.content, "base64").toString("utf8") : "";
        if (!dispatchOnly(text)) continue;
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
          const s = await settle(repo, vpr, "train", meta, VERSION_BRANCH);
          result({ ...base0, state: s.state, pr: { number: vpr.number, url: vpr.html_url }, ci: s.ci, detail: `Version pull request: ${s.detail}` });
          continue;
        }
        const runs = await gh.request<{ workflow_runs: { status: string }[] }>("GET", `${base}/${repo}/actions/workflows/release.yml/runs?branch=${encodeURIComponent(meta.default_branch)}&per_page=5`);
        if ((runs.data?.workflow_runs ?? []).some((x) => x.status !== "completed")) {
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
        result({ ...base0, state: "opened", pr: null, ci, detail: `The train started the release workflow for ${what}.` });
      } catch (e) {
        result({ ...base0, state: "error", pr: null, ci: null, detail: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return { owner, at: (o.now ?? new Date()).toISOString(), dryRun: o.dryRun, results, inFlight };
}

/** The branch of the version pull request of changesets. */
export const VERSION_BRANCH = "changeset-release/main";

/** This function tells if a release workflow starts only by hand: it has `workflow_dispatch` and no `push` trigger. */
export function dispatchOnly(workflow: string): boolean {
  const lines = workflow.split("\n").map((l) => l.trim());
  const push = lines.some((l) => l.startsWith("push:") || l === "push" || l === "- push" || l.startsWith("on: push") || (l.startsWith("on: [") && l.includes("push")));
  return !push && lines.some((l) => l.startsWith("workflow_dispatch"));
}
