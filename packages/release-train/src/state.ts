import { readFileSync } from "node:fs";
import semver from "semver";
import type { NpmInfo } from "./types.ts";

/** The publish times of one npm package, with the `modified` time of its npm document at the read. */
export interface NpmTimes {
  /** The field `modified` of the npm document. npm changes it at each publish, dist-tag change or deprecation. */
  modified: string;
  /** The publish time of each version, by version. */
  times: Record<string, string>;
}

/**
 * The state that the train keeps from one run to the next, in the Actions cache. The state has no private name: each key
 * of `seen` is a hash with the secret key of the run. A lost state costs one run with more npm reads.
 */
export interface TrainState {
  version: 1;
  /** The publish times of each npm package, by name. A run reads the full npm document only when `modified` changed. */
  npm: Record<string, NpmTimes>;
  /** The first time that the train saw each need with no publish time, by the hash of the need. */
  seen: Record<string, string>;
}

/** This function gives a state with no data. */
export function emptyState(): TrainState {
  return { version: 1, npm: {}, seen: {} };
}

/**
 * This function reads the state file of the train. A missing or bad file gives an empty state and a note for the log.
 * Thus a lost cache does not stop a run.
 */
export function readState(file: string): { state: TrainState; note: string | null } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { state: emptyState(), note: `No state file ${file}: this run reads each full npm document and starts the state.` };
  }
  try {
    const data = JSON.parse(text) as Partial<TrainState>;
    if (data.version !== 1 || typeof data.npm !== "object" || data.npm === null || typeof data.seen !== "object" || data.seen === null) {
      return { state: emptyState(), note: `The state file ${file} has an unknown format: this run starts the state again.` };
    }
    return { state: { version: 1, npm: data.npm, seen: data.seen }, note: null };
  } catch {
    return { state: emptyState(), note: `The state file ${file} is not JSON: this run starts the state again.` };
  }
}

/**
 * This function gives the publish time of the first stable version above `from`, from the times of `info`. That time is
 * when the need of an update started. The result is undefined when `from` is not a version or npm gives no such time.
 */
export function firstAbove(info: NpmInfo | undefined, from: string | null): string | undefined {
  const base = from === null ? null : semver.valid(from);
  if (!info?.times || base === null) return undefined;
  let best: string | undefined;
  let at: string | undefined;
  for (const [v, t] of Object.entries(info.times)) {
    if (semver.valid(v) === null || semver.prerelease(v) !== null || !semver.gt(v, base) || Number.isNaN(Date.parse(t))) continue;
    if (best === undefined || semver.lt(v, best)) {
      best = v;
      at = t;
    }
  }
  return at;
}

/** One need of an update: a dependency in a folder of the repository, at its version before the update. */
export interface Need {
  path: string;
  dep: string;
  from: string | null;
}

/** The starts of the needs of one run, from npm and from the state. The repository of each need is the first argument of `since`. */
export interface NeedStarts {
  /**
   * This function gives the start of the oldest need of an update. A need with a publish time starts at that time. Any
   * other need starts at the first run that saw it, from the state. An update with no need (a settings update) has one
   * need for its repository.
   */
  since(repo: string, needs: readonly Need[]): string;
  /** The `seen` field for the next state: only the needs of this run, so the field does not grow. */
  seen(): Record<string, string>;
  /** The count of the needs that got their start from npm and from the state. */
  counts(): { npm: number; state: number };
}

/**
 * This function makes the starts of the needs of one run. `hash` makes the key of a need with no publish time, so the
 * state has no private name. `now` is the start of a need that the state does not have.
 */
export function needStarts(npm: Readonly<Record<string, NpmInfo>>, prior: Readonly<Record<string, string>>, now: string, hash: (key: string) => string): NeedStarts {
  const next: Record<string, string> = {};
  let fromNpm = 0;
  let fromState = 0;
  const seenAt = (key: string): string => {
    const h = hash(key);
    const at = next[h] ?? prior[h] ?? now;
    next[h] = at;
    fromState++;
    return at;
  };
  return {
    since(repo, needs) {
      if (needs.length === 0) return seenAt(`${repo}\0settings`);
      let best: string | undefined;
      for (const n of needs) {
        const published = firstAbove(npm[n.dep], n.from);
        if (published !== undefined) fromNpm++;
        const at = published ?? seenAt([repo, n.path, n.dep, n.from ?? ""].join("\0"));
        if (best === undefined || Date.parse(at) < Date.parse(best)) best = at;
      }
      return best as string;
    },
    seen: () => ({ ...next }),
    counts: () => ({ npm: fromNpm, state: fromState }),
  };
}
