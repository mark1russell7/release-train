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

/**
 * The template sync need of each repository, with the time when the train saw it first. A sync with no open pull request waits from
 * this time. Without it, the sync waits from the date of the newest template commit, so each template merge starts its wait again.
 */
export interface SyncStarts {
  /** This function gives the first sight of the sync need of a repository, or undefined when the state has none. */
  since(repo: string): string | undefined;
  /** This function keeps the sync need of a repository: its first sight from the state, else `start`. It gives that time. */
  need(repo: string, start: string): string;
  /** This function drops the sync need of a repository, because the template files of the repository are in sync. */
  done(repo: string): void;
}

/** The starts of the needs of one run, from npm and from the state. The repository of each need is the first argument of `since`. */
export interface NeedStarts {
  /**
   * This function gives the start of the oldest need of an update. A need with a publish time starts at that time. Any
   * other need starts at the first run that saw it, from the state. An update with no need (a settings update) has one
   * need for its repository.
   */
  since(repo: string, needs: readonly Need[]): string;
  /**
   * This function keeps the sync need of each repository of the list in the next state. Thus a run with no sync, a run
   * with `--only` or a run that stops early does not start these waits again. A repository that is not in the list loses its need.
   */
  keepSync(repos: readonly string[]): void;
  /** The template sync needs of the run. */
  sync: SyncStarts;
  /** The `seen` field for the next state: only the needs of this run, so the field does not grow. */
  seen(): Record<string, string>;
  /** The count of the needs that got their start from npm and from the state, and of the sync needs that the state had. */
  counts(): { npm: number; state: number; sync: number };
}

/**
 * This function makes the starts of the needs of one run. `hash` makes the key of a need with no publish time, so the
 * state has no private name. `now` is the start of a need that the state does not have.
 */
export function needStarts(npm: Readonly<Record<string, NpmInfo>>, prior: Readonly<Record<string, string>>, now: string, hash: (key: string) => string): NeedStarts {
  const next: Record<string, string> = {};
  let fromNpm = 0;
  let fromState = 0;
  let syncKept = 0;
  const seenAt = (key: string): string => {
    const h = hash(key);
    const at = next[h] ?? prior[h] ?? now;
    next[h] = at;
    fromState++;
    return at;
  };
  // The key of a sync need. The keys of the other needs have one part (settings) or three parts after the repository.
  const syncKey = (repo: string): string => hash(`${repo}\0sync`);
  // A repository whose template files are in sync in this run. Its sync need from the state does not come back.
  const synced = new Set<string>();
  const syncAt = (repo: string): string | undefined => (synced.has(repo) ? next[syncKey(repo)] : (next[syncKey(repo)] ?? prior[syncKey(repo)]));
  return {
    keepSync(repos) {
      for (const repo of repos) {
        const at = syncAt(repo);
        if (at !== undefined) next[syncKey(repo)] = at;
      }
    },
    sync: {
      since: syncAt,
      need(repo, start) {
        const known = syncAt(repo);
        if (known !== undefined && prior[syncKey(repo)] === known) syncKept++;
        const at = known ?? start;
        next[syncKey(repo)] = at;
        return at;
      },
      done(repo) {
        synced.add(repo);
        delete next[syncKey(repo)];
      },
    },
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
    counts: () => ({ npm: fromNpm, state: fromState, sync: syncKept }),
  };
}
