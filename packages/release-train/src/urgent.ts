/**
 * A concurrency group keeps one pending run, so a new run replaces the run that waits. When the replaced run has urgent
 * names, this file gives them to the run that replaced it. The train stores nothing: the title of a run holds the names.
 * `queue: max` does not fit. The train starts 3.3 runs each hour, and a run takes 16 minutes, so a queue grows.
 * Then an urgent run waits behind runs that have no work.
 */
import type { GitHub } from "./github.ts";

/** The start of the title of a live run with urgent names. `run-name` of `train.yml` writes it. */
export const URGENT_TITLE = "Train urgent ";

/** The title of a live run that examines all repositories. */
export const PLAIN_TITLE = "Train";

/** The number of runs that the search reads, approximately 9 hours of the train. */
const RUNS_READ = 30;

/** The form of a package name in a title. */
const NAME = /^[@a-z0-9][@a-z0-9._/-]*$/;

/** The fields of a workflow run that the search reads. */
export interface TrainRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly display_title: string;
}

/** The urgent names that a run takes, and the runs that held them. */
export interface TakenUrgent {
  readonly names: string[];
  readonly runs: number[];
}

/** This function gives the names in the title of an urgent run, or null for another title. It refuses a name with a wrong form. */
export function urgentOfTitle(title: string): string[] | null {
  if (!title.startsWith(URGENT_TITLE)) return null;
  const names = title.slice(URGENT_TITLE.length).split(",").map((name) => name.trim()).filter(Boolean);
  return names.length > 0 && names.every((name) => NAME.test(name)) ? names : null;
}

/**
 * This function gives the cancelled urgent runs that no run served, newest first. The list arrives newest first, and the
 * search starts after the run `self`. It stops at a passed run that examined all repositories, because that run took the
 * names. A failed run and a dry run did not take them, so the search continues past each one.
 */
export function cancelledUrgent(runs: readonly TrainRun[], self: number): TrainRun[] {
  const start = runs.findIndex((run) => run.id === self);
  if (start < 0) return [];
  const found: TrainRun[] = [];
  for (const run of runs.slice(start + 1)) {
    const names = urgentOfTitle(run.display_title);
    if (run.conclusion === "success" && (names !== null || run.display_title === PLAIN_TITLE)) break;
    if (run.conclusion === "cancelled" && names !== null) found.push(run);
  }
  return found;
}

/**
 * This function gives the urgent names of the runs that a newer run replaced. A replaced run has no job. A run that
 * started and then stopped has a job, so its names stay out: a person cancelled it, or its time ended.
 */
export async function takeReplaced(gh: GitHub, repo: string, self: number): Promise<TakenUrgent> {
  const list = await gh.request<{ workflow_runs: TrainRun[] }>("GET", `/repos/${repo}/actions/workflows/train.yml/runs?per_page=${RUNS_READ}`);
  if (!list.data) throw new Error(`The runs of the train are not readable (HTTP ${list.status}).`);
  const names = new Set<string>();
  const taken: number[] = [];
  for (const run of cancelledUrgent(list.data.workflow_runs, self)) {
    const jobs = await gh.request<{ total_count: number }>("GET", `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=1`);
    if (!jobs.data) throw new Error(`The jobs of run ${run.id} are not readable (HTTP ${jobs.status}).`);
    if (jobs.data.total_count > 0) continue;
    taken.push(run.id);
    for (const name of urgentOfTitle(run.display_title) ?? []) names.add(name);
  }
  return { names: [...names], runs: taken };
}
