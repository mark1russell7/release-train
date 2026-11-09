import { parse as parseYaml } from "yaml";

/**
 * The days of a Renovate schedule, in the sequence of the week. Each repository gets one day for its weekly Renovate pull
 * requests. Thus the pull requests of all repositories do not wait for the same runners on one morning.
 */
export const RENOVATE_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/** One day of `RENOVATE_DAYS`. */
export type RenovateDay = (typeof RENOVATE_DAYS)[number];

/** The day of the shared Renovate preset of the template (`renovate/base.json`). A repository with no schedule of its own uses it. */
export const PRESET_DAY: RenovateDay = "monday";

/** This function gives the schedule text of a day, in the form of the shared preset. */
export function renovateSchedule(day: RenovateDay): string {
  return `before 6am on ${day}`;
}

/** This function gives the day of a schedule text in the form of `renovateSchedule`, or null for another text. */
export function dayOfSchedule(text: string): RenovateDay | null {
  const m = /^before 6am on ([a-z]+)$/.exec(text.trim().toLowerCase());
  const day = m?.[1];
  return RENOVATE_DAYS.find((d) => d === day) ?? null;
}

/** The facts of one repository for the assignment of the days. */
export interface DayInput {
  repo: string;
  /** The load of one Renovate pull request: the count of the jobs that its workflows start. */
  weight: number;
  /** The current day of the repository, or null when it has no day. */
  current: RenovateDay | null;
  /** This value is true when the assignment cannot move the repository. Its weight still counts on its day. */
  fixed?: boolean;
}

/**
 * This function gives each repository one day of the week, so that the load of the days is balanced.
 *
 * 1. Each repository keeps its current day.
 * 2. Each repository with no day goes to the lightest day, the heaviest repository first (ties: the name, then the day sequence).
 * 3. The function then moves repositories from the heaviest day to the lightest day. It stops when the difference is at most the largest weight.
 *    It moves the repository whose weight is nearest to half of the difference, so each move makes the spread smaller.
 *
 * The result is stable: an input with the days of a result gives the same result. The spread of the result is at most the largest weight.
 */
export function assignDays(inputs: readonly DayInput[]): Map<string, RenovateDay> {
  const load = new Map<RenovateDay, number>(RENOVATE_DAYS.map((d) => [d, 0]));
  const dayOf = new Map<string, RenovateDay>();
  const byName = [...inputs].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  const weightOf = (i: DayInput): number => (Number.isFinite(i.weight) && i.weight > 0 ? i.weight : 0);
  const put = (i: DayInput, day: RenovateDay): void => {
    dayOf.set(i.repo, day);
    load.set(day, (load.get(day) ?? 0) + weightOf(i));
  };
  const lightest = (): RenovateDay => RENOVATE_DAYS.reduce((best, d) => ((load.get(d) ?? 0) < (load.get(best) ?? 0) ? d : best));
  const heaviest = (): RenovateDay => RENOVATE_DAYS.reduce((best, d) => ((load.get(d) ?? 0) > (load.get(best) ?? 0) ? d : best));

  for (const i of byName) if (i.current !== null) put(i, i.current);
  const open = byName.filter((i) => i.current === null).sort((a, b) => weightOf(b) - weightOf(a));
  for (const i of open) put(i, lightest());

  const largest = byName.reduce((m, i) => Math.max(m, weightOf(i)), 0);
  for (let guard = 0; guard < inputs.length * RENOVATE_DAYS.length * 4; guard++) {
    const hi = heaviest();
    const lo = lightest();
    const gap = (load.get(hi) ?? 0) - (load.get(lo) ?? 0);
    if (gap <= largest) break;
    const movable = byName.filter((i) => !i.fixed && dayOf.get(i.repo) === hi && weightOf(i) > 0 && weightOf(i) < gap);
    if (movable.length === 0) break;
    const best = movable.reduce((b, i) => (Math.abs(weightOf(i) - gap / 2) < Math.abs(weightOf(b) - gap / 2) ? i : b));
    load.set(hi, (load.get(hi) ?? 0) - weightOf(best));
    put(best, lo);
  }
  return dayOf;
}

/** This function gives the load of each day for an assignment and its inputs. */
export function dayLoads(inputs: readonly DayInput[], days: ReadonlyMap<string, RenovateDay>): Record<RenovateDay, number> {
  const out = Object.fromEntries(RENOVATE_DAYS.map((d) => [d, 0])) as Record<RenovateDay, number>;
  for (const i of inputs) {
    const d = days.get(i.repo);
    if (d) out[d] += Math.max(0, i.weight);
  }
  return out;
}

/** The text of a file, or null when the file is not readable. */
export type ReadText = (path: string) => Promise<string | null>;

/** This function tells if a workflow starts for a pull request: its `on` names `pull_request` or `pull_request_target`. */
export function startsOnPullRequest(on: unknown): boolean {
  const names = ["pull_request", "pull_request_target"];
  if (typeof on === "string") return names.includes(on);
  if (Array.isArray(on)) return on.some((x) => typeof x === "string" && names.includes(x));
  if (on !== null && typeof on === "object") return names.some((n) => n in on);
  return false;
}

/**
 * This function gives the count of the jobs of one matrix. An axis is a list. The `include` entries add jobs only when the matrix has no axis.
 * The `exclude` entries remove jobs. An expression in place of a list gives one job, because its size is not known.
 */
export function matrixSize(matrix: unknown): number {
  if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix)) return 1;
  let product = 1;
  let axes = 0;
  for (const [key, value] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude") continue;
    if (Array.isArray(value)) {
      axes++;
      product *= value.length;
    }
  }
  const m = matrix as { include?: unknown; exclude?: unknown };
  const include = Array.isArray(m.include) ? m.include.length : 0;
  const exclude = Array.isArray(m.exclude) ? m.exclude.length : 0;
  const size = axes === 0 ? Math.max(1, include) : product - exclude;
  return Math.max(1, size);
}

/** The most levels of called workflows that `jobCount` follows. */
const CALL_DEPTH = 3;

/**
 * This function gives the count of the jobs that one workflow text starts. A job with a matrix counts each of its jobs.
 * A job that calls a workflow counts the jobs of the called file, times its matrix. When `read` cannot give the called file, the job counts 1.
 */
export async function jobCount(text: string, read: ReadText, depth = 0): Promise<number> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return 0;
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  if (jobs === null || typeof jobs !== "object") return 0;
  let n = 0;
  for (const job of Object.values(jobs as Record<string, unknown>)) {
    const j = (job ?? {}) as { strategy?: { matrix?: unknown }; uses?: unknown };
    const times = j.strategy?.matrix === undefined ? 1 : matrixSize(j.strategy.matrix);
    let each = 1;
    if (typeof j.uses === "string" && depth < CALL_DEPTH) {
      const called = await read(j.uses).catch(() => null);
      if (called !== null) each = Math.max(1, await jobCount(called, read, depth + 1));
    }
    n += times * each;
  }
  return n;
}

/** This function gives the count of the jobs that one pull request of a repository starts: the sum over its pull request workflows. */
export async function pullRequestJobs(paths: readonly string[], read: ReadText, readUses: ReadText): Promise<number> {
  let n = 0;
  for (const path of paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) {
    const text = await read(path);
    if (text === null) continue;
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch {
      continue;
    }
    if (!startsOnPullRequest((doc as { on?: unknown } | null)?.on)) continue;
    n += await jobCount(text, readUses);
  }
  return n;
}

/** The parts of a `renovate.json` that the day rule reads. */
export interface RenovateConfig {
  extends?: unknown;
  schedule?: unknown;
  [key: string]: unknown;
}

/** This function tells if a Renovate config extends the shared preset of the template (`renovate/default` or `renovate/base`). */
export function usesSharedPreset(config: RenovateConfig, owner: string, template: string): boolean {
  const ext = Array.isArray(config.extends) ? config.extends : [];
  const base = `github>${owner}/${template}//renovate/`.toLowerCase();
  return ext.some((e) => typeof e === "string" && [`${base}default`, `${base}base`].includes(e.toLowerCase()));
}

/**
 * This function gives the day of a Renovate config: the day of its one schedule text, or `"own"` for a schedule of another form.
 * A config with no schedule gives null, because it uses `PRESET_DAY` of the preset. The assignment does not change a schedule of another form.
 */
export function configDay(config: RenovateConfig): RenovateDay | null | "own" {
  if (config.schedule === undefined) return null;
  const s = config.schedule;
  const list = typeof s === "string" ? [s] : Array.isArray(s) ? s : null;
  if (list === null || list.length !== 1 || typeof list[0] !== "string") return "own";
  return dayOfSchedule(list[0]) ?? "own";
}

/** This function gives a copy of a config with the schedule of a day. A new `schedule` key goes after `extends`, and the other keys keep their sequence. */
export function withSchedule(config: RenovateConfig, day: RenovateDay): RenovateConfig {
  const schedule = [renovateSchedule(day)];
  if ("schedule" in config) return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, k === "schedule" ? schedule : v]));
  const out: RenovateConfig = {};
  let placed = false;
  for (const [k, v] of Object.entries(config)) {
    out[k] = v;
    if (k === "extends") {
      out["schedule"] = schedule;
      placed = true;
    }
  }
  if (!placed) out["schedule"] = schedule;
  return out;
}
