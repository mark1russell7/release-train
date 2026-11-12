// All repository and package names in these tests are made up.
import { describe, expect, it } from "vitest";
import { candidateReader, stuckCi } from "./candidate-facts.ts";
import type { CandidateTarget } from "./candidate-facts.ts";
import { COMPARE_FILES_MAX } from "./apply.ts";
import { CANDIDATE_POLICY } from "./candidate-policy.ts";
import type { CandidatePolicy } from "./candidate-policy.ts";
import type { FetchFn } from "./collect.ts";
import { gitHub } from "./github.ts";

const OWNER = "acme";
const base = `/repos/${OWNER}`;
const NOW = Date.parse("2026-11-11T12:00:00Z");
const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

type Handler = (url: URL) => [number, unknown];

function server(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const f: FetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    const h = routes[`${init?.method ?? "GET"} ${u.pathname}`];
    const [status, data] = h ? h(u) : [404, { message: "Not Found" }];
    return new Response(JSON.stringify(data), { status });
  };
  return { gh: gitHub({ token: "t", fetch: f }), calls };
}

const target = (over: Partial<CandidateTarget> = {}): CandidateTarget => ({
  repo: "data-repo",
  private: false,
  branch: "release-train/update",
  defaultBranch: "main",
  pr: { number: 7, body: "", created_at: iso(NOW - 2 * H), head: { sha: "sha7" } },
  ...over,
});

const reader = (routes: Record<string, Handler>, policy: CandidatePolicy = CANDIDATE_POLICY) => {
  const s = server(routes);
  return { ...s, r: candidateReader(s.gh, OWNER, policy, NOW, ["release-train/update", "release-train/template"]) };
};

describe("stuckCi", () => {
  const run = (suite: number, hoursOld: number, status = "in_progress") => ({ id: suite, workflow_id: suite, check_suite_id: suite, created_at: iso(NOW - hoursOld * H), status, conclusion: null });
  const check = (suite: number, status = "in_progress", conclusion: string | null = null) => ({ status, conclusion, check_suite: { id: suite } });

  it("tells stuck when only an old run keeps the state at running", () => {
    expect(stuckCi([check(1), check(2, "completed", "success")], null, [run(1, 7), run(2, 1, "completed")], NOW, 6)).toEqual({ state: "running", stuck: true });
  });

  it("does not tell stuck for a young run", () => {
    expect(stuckCi([check(1), check(2)], null, [run(1, 7), run(2, 1)], NOW, 6)).toEqual({ state: "running", stuck: false });
  });

  it("does not change a state that is not running", () => {
    expect(stuckCi([check(1, "completed", "failure")], null, [run(1, 7, "completed")], NOW, 6)).toEqual({ state: "failed", stuck: false });
  });
});

describe("candidateReader", () => {
  it("reads the CI of the head of the candidate", async () => {
    const { r } = reader({
      [`GET ${base}/data-repo/commits/sha7/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: "success" }] }],
      [`GET ${base}/data-repo/commits/sha7/status`]: () => [200, { state: "pending", total_count: 0 }],
      [`GET ${base}/data-repo/actions/runs`]: () => [200, { workflow_runs: [] }],
    });
    expect(await r.read("ci", target())).toEqual({ ci: { state: "green", stuck: false } });
    expect(r.requests()).toBe(3);
  });

  it("reads mergeable and behind, and keeps the comparison for the surface", async () => {
    const { r, calls } = reader({
      [`GET ${base}/data-repo/pulls/7`]: () => [200, { mergeable: false }],
      [`GET ${base}/data-repo/compare/main...sha7`]: () => [200, { behind_by: 4, files: [{ filename: "package.json" }], merge_base_commit: { sha: "mb1" } }],
      [`GET ${base}/data-repo/compare/mb1...main`]: () => [200, { files: [{ filename: "src/index.ts" }] }],
    });
    expect(await r.read("mergeable", target())).toEqual({ mergeable: false });
    expect(await r.read("behind", target())).toEqual({ behind: 4 });
    expect(await r.read("surface", target())).toEqual({ surfaceChanged: false });
    expect(calls.filter((c) => c.includes("/compare/main...sha7"))).toHaveLength(1);
    expect(r.requests()).toBe(3);
  });

  it("finds a change of the surface, also through the lockfile", async () => {
    const { r } = reader({
      [`GET ${base}/data-repo/compare/main...sha7`]: () => [200, { behind_by: 4, files: [{ filename: "pnpm-lock.yaml" }], merge_base_commit: { sha: "mb1" } }],
      [`GET ${base}/data-repo/compare/mb1...main`]: () => [200, { files: [{ filename: ".npmrc" }] }],
    });
    expect(await r.read("surface", target())).toEqual({ surfaceChanged: true });
  });

  it("counts a failed read of the surface as a change", async () => {
    const { r } = reader({ [`GET ${base}/data-repo/compare/main...sha7`]: () => [200, { behind_by: 4, files: [], merge_base_commit: { sha: "mb1" } }] });
    expect(await r.read("surface", target())).toEqual({ surfaceChanged: true });
    const failed = reader({});
    expect(await failed.r.read("behind", target())).toEqual({ behind: null });
    expect(await failed.r.read("surface", target())).toEqual({ surfaceChanged: true });
  });

  it("counts the runs of other branches", async () => {
    const { r } = reader({
      [`GET ${base}/data-repo/actions/runs`]: (u) => [200, { workflow_runs: u.searchParams.get("status") === "queued" ? [{ head_branch: "feature" }] : [{ head_branch: "main" }, { head_branch: "release-train/update" }, { head_branch: "other" }] }],
    });
    expect(await r.read("otherRuns", target())).toEqual({ otherRuns: 2 });
  });

  it("does not count a run of another branch that is older than stuckCiHours", async () => {
    const { r } = reader({
      [`GET ${base}/data-repo/actions/runs`]: (u) => [200, { workflow_runs: u.searchParams.get("status") === "queued" ? [{ head_branch: "feature", created_at: iso(NOW - 7 * H) }] : [{ head_branch: "other", created_at: iso(NOW - H) }] }],
    });
    expect(await r.read("otherRuns", target())).toEqual({ otherRuns: 1 });
  });

  it("counts runs, not jobs", async () => {
    // The fact counts the workflow runs that the list gives. It reads no list of jobs.
    const { r, calls } = reader({
      [`GET ${base}/data-repo/actions/runs`]: (u) => [200, { workflow_runs: u.searchParams.get("status") === "queued" ? [] : [{ id: 1, head_branch: "other", created_at: iso(NOW - H) }] }],
      [`GET ${base}/data-repo/actions/runs/1/jobs`]: () => [200, { jobs: [{}, {}, {}] }],
    });
    expect(await r.read("otherRuns", target())).toEqual({ otherRuns: 1 });
    expect(calls.some((c) => c.includes("/jobs"))).toBe(false);
  });

  it("marks a surface read with a list that GitHub cut", async () => {
    const many = Array.from({ length: COMPARE_FILES_MAX }, (_, i) => ({ filename: `src/f${i}.ts` }));
    const head = reader({
      [`GET ${base}/data-repo/compare/main...sha7`]: () => [200, { behind_by: 4, files: many, merge_base_commit: { sha: "mb1" } }],
      [`GET ${base}/data-repo/compare/mb1...main`]: () => [200, { files: [{ filename: "docs/a.md" }] }],
    });
    expect(await head.r.read("surface", target())).toEqual({ surfaceChanged: true, surfaceCut: true });
    const main = reader({
      [`GET ${base}/data-repo/compare/main...sha7`]: () => [200, { behind_by: 4, files: [{ filename: "src/a.ts" }], merge_base_commit: { sha: "mb1" } }],
      [`GET ${base}/data-repo/compare/mb1...main`]: () => [200, { files: many }],
    });
    expect(await main.r.read("surface", target())).toEqual({ surfaceChanged: true, surfaceCut: true });
  });

  it("reads the last push from the head commit of the open pull request", async () => {
    const { r } = reader({ [`GET ${base}/data-repo/commits/sha7`]: () => [200, { commit: { committer: { date: iso(NOW - 3 * H) } } }] });
    expect(await r.read("lastPush", target())).toEqual({ lastPushAt: NOW - 3 * H });
  });

  it("reads the last push from the newest closed pull request, and null when the branch had none", async () => {
    const { r } = reader({
      [`GET ${base}/data-repo/pulls`]: () => [200, [
        { number: 3, body: "", created_at: iso(NOW - 50 * H), head: { sha: "old" } },
        { number: 5, body: "", created_at: iso(NOW - 10 * H), head: { sha: "new" } },
      ]],
      [`GET ${base}/data-repo/commits/new`]: () => [200, { commit: { committer: { date: iso(NOW - 9 * H) } } }],
    });
    expect(await r.read("lastPush", target({ pr: null }))).toEqual({ lastPushAt: NOW - 9 * H });
    const none = reader({ [`GET ${base}/data-repo/pulls`]: () => [200, []] });
    expect(await none.r.read("lastPush", target({ pr: null }))).toEqual({ lastPushAt: null });
  });

  it("reads the cost of the last candidate in runner minutes or in billed minutes", async () => {
    const job = (seconds: number, labels: string[]) => ({ started_at: iso(NOW - H), completed_at: iso(NOW - H + seconds * 1000), labels, runner_name: "runner" });
    const routes: Record<string, Handler> = {
      [`GET ${base}/data-repo/actions/runs`]: () => [200, { workflow_runs: [{ id: 11 }, { id: 12 }] }],
      [`GET ${base}/data-repo/actions/runs/11/jobs`]: () => [200, { jobs: [job(90, ["ubuntu-latest"]), job(30, ["windows-latest"])] }],
      [`GET ${base}/data-repo/actions/runs/12/jobs`]: () => [200, { jobs: [{ ...job(60, ["ubuntu-latest"]), runner_name: null }] }],
    };
    expect(await reader(routes).r.read("cost", target())).toEqual({ costMinutes: 2 });
    expect(await reader(routes).r.read("cost", target({ private: true }))).toEqual({ costMinutes: 4 });
    const failed = reader({ ...routes, [`GET ${base}/data-repo/actions/runs/12/jobs`]: () => [500, { message: "error" }] });
    expect(await failed.r.read("cost", target())).toEqual({ costMinutes: null });
  });
});

describe("the health of the default branch (R4)", () => {
  /** The workflow runs of each commit, as pairs of a workflow id and a conclusion. */
  type Runs = Record<string, [number, string][]>;
  const runsRoute = (runs: Runs): Handler => (u) => {
    const list = runs[u.searchParams.get("head_sha") ?? ""] ?? [];
    return [200, { workflow_runs: list.map(([id, conclusion], i) => ({ id: i + 1, workflow_id: id, check_suite_id: i + 1, created_at: iso(NOW - H), status: "completed", conclusion })) }];
  };
  const routes = (runs: Runs, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
    [`GET ${base}/data-repo/actions/runs`]: runsRoute(runs),
    [`GET ${base}/data-repo/commits/main`]: () => [200, { sha: "head1" }],
    ...extra,
  });
  const runsOf = (calls: string[], sha: string): string[] => calls.filter((c) => c.includes(`head_sha=${sha}&`));

  it("does not count a red workflow that the candidate did not run", async () => {
    // Workflow 1 is CI. Workflow 2 runs only on the default branch, for example a release workflow.
    const { r } = reader(routes({ sha7: [[1, "success"]], head1: [[1, "success"], [2, "failure"]] }));
    expect(await r.read("mainHealth", target())).toEqual({ mainHealth: { head: "green", redMerges: null } });
  });

  it("gives no read when no run of the workflows of the candidate is left", async () => {
    const { r } = reader(routes({ sha7: [[1, "success"]], head1: [[2, "failure"]] }));
    expect(await r.read("mainHealth", target())).toEqual({ mainHealth: { head: "no-read", redMerges: null } });
  });

  it("counts a red workflow of the candidate", async () => {
    const { r } = reader(routes({ sha7: [[1, "success"], [2, "success"]], head1: [[1, "success"], [2, "failure"]] }));
    expect(await r.read("mainHealth", target())).toEqual({ mainHealth: { head: "red", redMerges: null } });
  });

  it("gives no read for an empty set of workflows, and then reads nothing of the default branch", async () => {
    const { r, calls } = reader(routes({ sha7: [], head1: [[1, "failure"]] }));
    expect(await r.read("mainHealth", target())).toEqual({ mainHealth: { head: "no-read", redMerges: null } });
    expect(calls.some((c) => c.includes("/commits/main"))).toBe(false);
    const failed = reader({ [`GET ${base}/data-repo/commits/main`]: () => [200, { sha: "head1" }] });
    expect(await failed.r.read("mainHealth", target())).toEqual({ mainHealth: { head: "no-read", redMerges: null } });
  });

  it("with no bound, reads no closed pull request and no merge commit, so it costs 2 requests after the CI", async () => {
    const { r, calls } = reader(
      routes(
        { sha7: [[1, "success"]], head1: [[1, "failure"]] },
        {
          [`GET ${base}/data-repo/commits/sha7/check-runs`]: () => [200, { check_runs: [{ status: "completed", conclusion: "success" }] }],
          [`GET ${base}/data-repo/commits/sha7/status`]: () => [200, { state: "pending", total_count: 0 }],
          [`GET ${base}/data-repo/pulls`]: () => [200, [{ number: 1, body: "", merged_at: iso(NOW - H), merge_commit_sha: "m1", head: { sha: "h1" } }]],
        },
      ),
    );
    expect(CANDIDATE_POLICY.redMainBound).toBeNull();
    await r.read("ci", target());
    const before = r.requests();
    expect(await r.read("mainHealth", target())).toEqual({ mainHealth: { head: "red", redMerges: null } });
    // The runs of the head of the candidate are in the cache of the CI read. The head of the default branch and its runs cost 2.
    expect(r.requests() - before).toBe(2);
    expect(runsOf(calls, "sha7")).toHaveLength(1);
    expect(calls.some((c) => c.includes("state=closed") || c.includes("head_sha=m1"))).toBe(false);
  });

  it("with a bound, counts the red train merges in the window with the same filter, for each candidate", async () => {
    const merged = (n: number, hoursAgo: number) => ({ number: n, body: "", created_at: iso(NOW - (hoursAgo + 1) * H), merged_at: iso(NOW - hoursAgo * H), merge_commit_sha: `m${n}`, head: { sha: `h${n}` } });
    const runs: Runs = {
      // The update candidate runs workflow 1. The sync candidate runs workflow 2.
      sha7: [[1, "success"]],
      sha8: [[2, "success"]],
      head1: [[1, "success"], [2, "failure"]],
      m1: [[1, "failure"]],
      m2: [[1, "success"], [2, "failure"]],
      m3: [[1, "failure"], [2, "success"]],
      m9: [[1, "failure"]],
    };
    const { r, calls } = reader(
      routes(runs, {
        [`GET ${base}/data-repo/pulls`]: (u) => [200, u.searchParams.get("head")?.endsWith("update") ? [merged(1, 2), merged(2, 30), merged(9, 24 * 40)] : [merged(3, 50)]],
      }),
      { ...CANDIDATE_POLICY, redMainBound: 5 },
    );
    // Workflow 1: m1 and m3 are red, m2 is green, and m9 is out of the window.
    expect(await r.read("mainHealth", target())).toEqual({ mainHealth: { head: "green", redMerges: 2 } });
    // Workflow 2: only m2 is red. The value depends on the candidate, so the train keeps no value for the repository.
    const sync = target({ branch: "release-train/template", pr: { number: 8, body: "", created_at: iso(NOW - 2 * H), head: { sha: "sha8" } } });
    expect(await r.read("mainHealth", sync)).toEqual({ mainHealth: { head: "red", redMerges: 1 } });
    expect(runsOf(calls, "m9")).toHaveLength(0);
    // The cache of the paths: the runs of 2 candidates, the head and its runs, 1 list for each branch and 1 read for each merge in the window.
    expect(calls.filter((c) => c.startsWith(`GET ${base}/data-repo/commits/main`))).toHaveLength(1);
    expect(r.requests()).toBe(2 + 2 + 2 + 3);
  });
});
