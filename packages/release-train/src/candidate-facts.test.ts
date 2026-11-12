// All repository and package names in these tests are made up.
import { describe, expect, it } from "vitest";
import { candidateReader, stuckCi } from "./candidate-facts.ts";
import type { CandidateTarget } from "./candidate-facts.ts";
import { CANDIDATE_POLICY } from "./candidate-policy.ts";
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

const reader = (routes: Record<string, Handler>) => {
  const s = server(routes);
  return { ...s, r: candidateReader(s.gh, OWNER, CANDIDATE_POLICY, NOW, ["release-train/update", "release-train/template"]) };
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

  it("reads the health of the default branch one time for each repository", async () => {
    const merged = (n: number, hoursAgo: number) => ({ number: n, body: "", created_at: iso(NOW - (hoursAgo + 1) * H), merged_at: iso(NOW - hoursAgo * H), merge_commit_sha: `m${n}`, head: { sha: `h${n}` } });
    const runs: Record<string, string> = { m1: "failure", m2: "success", m3: "failure", head1: "failure" };
    const { r, calls } = reader({
      [`GET ${base}/data-repo/pulls`]: (u) => [200, u.searchParams.get("head")?.endsWith("update") ? [merged(1, 2), merged(2, 30), { ...merged(9, 24 * 40) }] : [merged(3, 50)]],
      [`GET ${base}/data-repo/actions/runs`]: (u) => {
        const c = runs[u.searchParams.get("head_sha") ?? ""];
        return [200, { workflow_runs: c ? [{ id: 1, workflow_id: 1, check_suite_id: 1, created_at: iso(NOW - H), status: "completed", conclusion: c }] : [] }];
      },
      [`GET ${base}/data-repo/commits/main`]: () => [200, { sha: "head1" }],
    });
    expect(await r.read("mainHealth", target())).toEqual({ mainHealth: { lastMerge: "red", head: "red", redMerges: 2 } });
    await r.read("mainHealth", target({ branch: "release-train/template" }));
    expect(calls.filter((c) => c.startsWith(`GET ${base}/data-repo/commits/main`))).toHaveLength(1);
    // Two lists of closed pull requests, three merges in the window and the head of the default branch.
    expect(r.requests()).toBe(2 + 3 + 2);
  });

  it("gives no read for a default branch with no workflow run", async () => {
    const { r } = reader({ [`GET ${base}/data-repo/pulls`]: () => [200, []], [`GET ${base}/data-repo/commits/main`]: () => [200, { sha: "head1" }], [`GET ${base}/data-repo/actions/runs`]: () => [200, { workflow_runs: [] }] });
    expect(await r.read("mainHealth", target())).toEqual({ mainHealth: { lastMerge: "none", head: "no-read", redMerges: 0 } });
  });
});
