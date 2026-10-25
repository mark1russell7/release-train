import type { FetchFn } from "./collect.ts";
import { pool } from "./collect.ts";
import type { Action, Plan } from "./plan.ts";

/** The state of an action on GitHub. */
export type ProgressState = "todo" | "in-flight" | "ci-running" | "ci-failed" | "ci-green";

/** The progress of one action: an open pull request or a running release. */
export interface Progress {
  state: ProgressState;
  detail: string;
  url: string | null;
}

interface Pull {
  number: number;
  title: string;
  html_url: string;
  head: { sha: string; ref: string };
}

interface CheckRuns {
  check_runs: { status: string; conclusion: string | null }[];
}

interface Runs {
  workflow_runs: { status: string; conclusion: string | null; html_url: string; head_sha: string; created_at: string }[];
}

/** This function changes the checks of a commit into one state. */
export function checkState(runs: CheckRuns["check_runs"]): ProgressState {
  if (runs.length === 0) return "in-flight";
  if (runs.some((r) => r.status !== "completed")) return "ci-running";
  if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled")) return "ci-failed";
  return "ci-green";
}

/** This function finds the pull request of an action: a title or a branch that names one of its packages. */
export function matchPull(a: Action, pulls: readonly Pull[]): Pull | null {
  const names =
    a.kind === "release" || a.kind === "new-package" ? a.packages.map((p) => p.name) : a.items.map((i) => i.dep);
  const releaseWords = /\b(release|version|bump)\b/i;
  for (const pr of pulls) {
    const text = `${pr.title} ${pr.head.ref}`;
    const named = names.some((n) => text.includes(n) || text.includes(n.split("/").pop() ?? n));
    if (!named) continue;
    if (a.kind === "release" && !releaseWords.test(text)) continue;
    return pr;
  }
  return null;
}

/** This function reads the open pull requests and the release workflows of the repositories of the actions. */
export async function addProgress(
  plan: Plan,
  opts: { owner: string; token: string | null; fetch?: FetchFn; apiBase?: string; concurrency?: number },
): Promise<Record<string, Progress>> {
  const f: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const api = opts.apiBase ?? "https://api.github.com";
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "release-train" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const get = async <T>(path: string): Promise<T | null> => {
    const res = await f(`${api}${path}`, { headers });
    return res.ok ? ((await res.json()) as T) : null;
  };
  const repos = [...new Set(plan.actions.map((a) => a.repo))].sort();
  const out: Record<string, Progress> = {};
  await pool(repos, opts.concurrency ?? 4, async (repo) => {
    const pulls = (await get<Pull[]>(`/repos/${opts.owner}/${repo}/pulls?state=open&per_page=50`)) ?? [];
    for (const a of plan.actions.filter((x) => x.repo === repo)) {
      const pr = matchPull(a, pulls);
      if (pr) {
        const checks = await get<CheckRuns>(`/repos/${opts.owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`);
        const state = checkState(checks?.check_runs ?? []);
        out[a.id] = { state, detail: `PR #${pr.number}: ${pr.title}`, url: pr.html_url };
        continue;
      }
      if (a.kind === "release") {
        const runs = await get<Runs>(`/repos/${opts.owner}/${repo}/actions/workflows/release.yml/runs?branch=main&per_page=1`);
        const run = runs?.workflow_runs[0];
        if (run && run.status !== "completed") {
          out[a.id] = { state: "ci-running", detail: "The release workflow runs now.", url: run.html_url };
          continue;
        }
        if (run && run.conclusion === "failure") {
          out[a.id] = { state: "ci-failed", detail: "The last release workflow run failed.", url: run.html_url };
          continue;
        }
      }
      out[a.id] = { state: "todo", detail: "No pull request yet.", url: null };
    }
  });
  return out;
}
