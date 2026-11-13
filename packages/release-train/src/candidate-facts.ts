import { COMPARE_FILES_MAX, ciState, latestRuns } from "./apply.ts";
import { commitHealth, jobMinutes, surfaceChanged } from "./candidate-policy.ts";
import type { CandidateCi, CandidateFacts, CandidateNeed, CandidatePolicy, CommitHealth, JobCost, MainHealth, RunHealth } from "./candidate-policy.ts";
import type { GhResponse, GitHub } from "./github.ts";

/** A pull request, as far as the readers of the candidate facts read it. */
export interface CandidatePull {
  number: number;
  body: string | null;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head: { sha: string };
}

/** The branch of one repository that the candidate rules decide for. */
export interface CandidateTarget {
  repo: string;
  private: boolean;
  /** The train branch: the update branch or the sync branch. */
  branch: string;
  defaultBranch: string;
  /** The open pull request of the branch, or null. */
  pr: CandidatePull | null;
}

/** The comparison of a candidate with the default branch. */
export interface CandidateCompare {
  behind: number;
  /** The files that the candidate changes since the merge base. */
  files: string[];
  /** This value is true when GitHub cut the list of files short. */
  cut: boolean;
  mergeBase: string | null;
}

/** The readers of the candidate facts in one run. Each reader keeps its GitHub responses for the rest of the run. */
export interface CandidateReader {
  /** This function reads the fact of a need for a branch. */
  read(need: CandidateNeed, t: CandidateTarget): Promise<Partial<CandidateFacts>>;
  /** This function compares a commit with the default branch, or gives null when GitHub does not answer. */
  compare(repo: string, sha: string, defaultBranch: string): Promise<CandidateCompare | null>;
  /** This function gives the count of the GitHub requests of the readers in this run. */
  requests(): number;
}

interface CheckRun {
  status: string;
  conclusion: string | null;
  check_suite?: { id: number } | null;
}

interface WorkflowRun extends RunHealth {
  id: number;
  check_suite_id: number;
  head_branch?: string | null;
}

const HOUR_MS = 3_600_000;

/**
 * This function gives the CI state of a candidate and tells if the state is stuck. Stuck: the state is `running` only
 * because of workflow jobs that are queued or in progress for more than `stuckHours`.
 */
export function stuckCi(runs: readonly CheckRun[], status: { state: string; total_count: number } | null, workflowRuns: readonly WorkflowRun[], now: number, stuckHours: number): CandidateCi {
  const latest = latestRuns(runs, workflowRuns);
  const state = ciState(latest, status);
  if (state !== "running") return { state, stuck: false };
  const old = new Set(workflowRuns.filter((w) => w.status !== "completed" && now - Date.parse(w.created_at) > stuckHours * HOUR_MS).map((w) => w.check_suite_id));
  if (old.size === 0) return { state, stuck: false };
  const rest = latest.filter((r) => !(r.check_suite && old.has(r.check_suite.id)));
  return { state, stuck: ciState(rest, status) !== "running" };
}

/**
 * This function makes the readers of the candidate facts for one run. It reads only with GET. It keeps each response by
 * its path, so two reads of the same path cost one request. The pull requests of `branches` give the train merges of R4,
 * and the train reads them only when the policy has a bound for R4.
 */
export function candidateReader(gh: GitHub, owner: string, policy: CandidatePolicy, now: number, branches: readonly string[]): CandidateReader {
  const base = `/repos/${owner}`;
  const cache = new Map<string, Promise<GhResponse<unknown>>>();
  let count = 0;
  const get = <T>(path: string): Promise<GhResponse<T>> => {
    let p = cache.get(path);
    if (!p) {
      count += 1;
      p = gh.request<unknown>("GET", path);
      cache.set(path, p);
    }
    return p as Promise<GhResponse<T>>;
  };

  const compare = async (repo: string, sha: string, defaultBranch: string): Promise<CandidateCompare | null> => {
    const res = await get<{ behind_by?: number; files?: { filename: string }[]; merge_base_commit?: { sha?: string } }>(`${base}/${repo}/compare/${encodeURIComponent(defaultBranch)}...${sha}`);
    if (typeof res.data?.behind_by !== "number") return null;
    const files = (res.data.files ?? []).map((f) => f.filename);
    return { behind: res.data.behind_by, files, cut: files.length >= COMPARE_FILES_MAX, mergeBase: res.data.merge_base_commit?.sha ?? null };
  };

  const runsOf = async (repo: string, sha: string): Promise<WorkflowRun[] | null> => {
    const res = await get<{ workflow_runs?: WorkflowRun[] }>(`${base}/${repo}/actions/runs?head_sha=${sha}&per_page=100`);
    return res.ok && res.data ? (res.data.workflow_runs ?? []) : null;
  };

  const closedOf = async (repo: string, branch: string): Promise<CandidatePull[] | null> => {
    const res = await get<CandidatePull[]>(`${base}/${repo}/pulls?state=closed&head=${owner}:${encodeURIComponent(branch)}&per_page=100`);
    return res.ok && Array.isArray(res.data) ? res.data : null;
  };

  /** The last candidate of a branch: the open pull request, else the newest closed one. Null: the branch had none. */
  const lastOf = async (t: CandidateTarget): Promise<CandidatePull | null> => {
    if (t.pr) return t.pr;
    const closed = await closedOf(t.repo, t.branch);
    const newest = [...(closed ?? [])].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
    return newest ?? null;
  };

  const readers: Record<CandidateNeed, (t: CandidateTarget) => Promise<Partial<CandidateFacts>>> = {
    async ci(t) {
      if (!t.pr) return { ci: { state: "none", stuck: false } };
      const sha = t.pr.head.sha;
      const runs = await get<{ check_runs?: CheckRun[] }>(`${base}/${t.repo}/commits/${sha}/check-runs?per_page=100`);
      const status = await get<{ state: string; total_count: number }>(`${base}/${t.repo}/commits/${sha}/status`);
      return { ci: stuckCi(runs.data?.check_runs ?? [], status.data, (await runsOf(t.repo, sha)) ?? [], now, policy.stuckCiHours) };
    },
    async mergeable(t) {
      if (!t.pr) return { mergeable: null };
      const res = await get<{ mergeable?: boolean | null }>(`${base}/${t.repo}/pulls/${t.pr.number}`);
      return { mergeable: res.data?.mergeable ?? null };
    },
    async behind(t) {
      if (!t.pr) return { behind: 0 };
      return { behind: (await compare(t.repo, t.pr.head.sha, t.defaultBranch))?.behind ?? null };
    },
    async surface(t) {
      if (!t.pr) return { surfaceChanged: false };
      const c = await compare(t.repo, t.pr.head.sha, t.defaultBranch);
      if (c === null || c.mergeBase === null) return { surfaceChanged: true };
      if (c.behind === 0) return { surfaceChanged: false };
      const res = await get<{ files?: { filename: string }[] }>(`${base}/${t.repo}/compare/${c.mergeBase}...${encodeURIComponent(t.defaultBranch)}`);
      if (!res.ok || !res.data) return { surfaceChanged: true };
      const main = (res.data.files ?? []).map((f) => f.filename);
      const mainCut = main.length >= COMPARE_FILES_MAX;
      // A cut list counts as a change. The fact surfaceCut lets the reason tell this case from a real change.
      return { surfaceChanged: surfaceChanged(c, { files: main, cut: mainCut }), ...(c.cut || mainCut ? { surfaceCut: true } : {}) };
    },
    async otherRuns(t) {
      let n = 0;
      for (const status of ["in_progress", "queued"]) {
        const res = await get<{ workflow_runs?: { head_branch: string | null; created_at?: string }[] }>(`${base}/${t.repo}/actions/runs?status=${status}&per_page=100`);
        for (const run of res.data?.workflow_runs ?? []) {
          if (run.head_branch === t.branch || run.head_branch === t.defaultBranch) continue;
          // A run that is queued or in progress for more than stuckCiHours is stuck, as in R1, so it does not count.
          if (now - Date.parse(run.created_at ?? "") > policy.stuckCiHours * HOUR_MS) continue;
          n++;
        }
      }
      return { otherRuns: n };
    },
    async lastPush(t) {
      const last = await lastOf(t);
      if (!last) return { lastPushAt: null };
      const res = await get<{ commit?: { committer?: { date?: string } } }>(`${base}/${t.repo}/commits/${last.head.sha}`);
      const at = Date.parse(res.data?.commit?.committer?.date ?? last.updated_at ?? last.created_at ?? "");
      // A time that is not readable counts as now, so the pace waits and does not push too soon.
      return { lastPushAt: Number.isNaN(at) ? now : at };
    },
    async cost(t) {
      const last = await lastOf(t);
      if (!last) return { costMinutes: null };
      const runs = await runsOf(t.repo, last.head.sha);
      if (runs === null) return { costMinutes: null };
      let minutes = 0;
      for (const run of runs) {
        const jobs = await get<{ jobs?: JobCost[] }>(`${base}/${t.repo}/actions/runs/${run.id}/jobs?per_page=100`);
        if (!jobs.ok || !jobs.data) return { costMinutes: null };
        for (const job of jobs.data.jobs ?? []) minutes += jobMinutes(job, t.private, now);
      }
      return { costMinutes: minutes };
    },
    async mainHealth(t) {
      return { mainHealth: await healthOf(t) };
    },
  };

  /**
   * This function reads the facts of R4 for a candidate. Each value counts only the runs of the workflows of the head
   * of the candidate. The value thus depends on the candidate, and the train keeps no value for each repository. The
   * cache of `get` makes each second read of a path free. With no bound in the policy, it does not read the count.
   */
  const healthOf = async (t: CandidateTarget): Promise<MainHealth> => {
    const own = t.pr ? await runsOf(t.repo, t.pr.head.sha) : null;
    const ids = new Set((own ?? []).map((r) => r.workflow_id));
    // An empty set or a failed read gives no read: the train cannot tell which workflows count.
    if (ids.size === 0) return { head: "no-read", redMerges: null };
    // A failed read, or no run of the set, gives no read.
    const healthOfSha = async (sha: string): Promise<CommitHealth> => commitHealth((await runsOf(t.repo, sha))?.filter((r) => ids.has(r.workflow_id)));
    const headSha = (await get<{ sha?: string }>(`${base}/${t.repo}/commits/${encodeURIComponent(t.defaultBranch)}`)).data?.sha;
    const head = headSha ? await healthOfSha(headSha) : "no-read";
    if (policy.redMainBound === null) return { head, redMerges: null };
    const since = now - policy.redMainWindowDays * 24 * HOUR_MS;
    let redMerges = 0;
    for (const branch of branches) {
      for (const pr of (await closedOf(t.repo, branch)) ?? []) {
        const at = Date.parse(pr.merged_at ?? "");
        if (Number.isNaN(at) || at < since || !pr.merge_commit_sha) continue;
        if ((await healthOfSha(pr.merge_commit_sha)) === "red") redMerges += 1;
      }
    }
    return { head, redMerges };
  };

  return {
    read: (need, t) => readers[need](t),
    compare,
    requests: () => count,
  };
}
