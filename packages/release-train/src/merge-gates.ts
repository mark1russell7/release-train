import { globMatch } from "./settings.ts";

/** The key of the settings of the train in the root package.json of a repository. */
export const SETTINGS_KEY = "releaseTrain";

/** The longest age of a gate status, in minutes: one day. */
export const GATE_AGE_MAX_MINUTES = 1440;

/**
 * One merge gate of a repository, from the field `releaseTrain.mergeGates` of its root package.json. A pull request can
 * change a file that matches one of `files`. Then the train merges it only when its head commit has the commit status
 * `status` in the state `success`. The status must also be at most `maxAgeMinutes` old.
 *
 * The repository declares its gates, and a system of the owner sets the status. For example, a computer that installs the
 * default branch sets a status when an install fits in its memory. A status that is missing or old holds the merge, so a
 * gate with no writer gives no pass. A status in the state `pending` also reads as CI that runs (`ciState`). A status in
 * the state `failure` reads as failed CI, so the writer of a gate uses only `pending` and `success`.
 */
export interface MergeGate {
  /** The patterns of the paths, from the root of the repository. In a pattern, `*` stands for any text, also a `/`. */
  files: string[];
  /** The context of the commit status. */
  status: string;
  /** The longest age of the status, in whole minutes from 1 to GATE_AGE_MAX_MINUTES. */
  maxAgeMinutes: number;
}

/** The result of `readMergeGates`. Only a valid gate is in `gates`. */
export interface GateReading {
  gates: MergeGate[];
  faults: string[];
}

/** One commit status of GitHub, from the field `statuses` of the combined status of a commit. */
export interface CommitStatus {
  context: string;
  state: string;
  updated_at?: string | null;
  description?: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function gives the gate of one entry of `mergeGates`, or the fault of the entry. */
function gateOf(entry: unknown, at: number): MergeGate | string {
  const name = `mergeGates[${at}]`;
  if (!isRecord(entry)) return `${name} is not an object`;
  const { files, status, maxAgeMinutes } = entry;
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string" && f.trim() !== "")) {
    return `${name}.files is not a list of one or more paths`;
  }
  if (typeof status !== "string" || status.trim() === "") return `${name}.status is not the name of a commit status`;
  if (typeof maxAgeMinutes !== "number" || !Number.isInteger(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > GATE_AGE_MAX_MINUTES) {
    return `${name}.maxAgeMinutes is not a whole number from 1 to ${GATE_AGE_MAX_MINUTES}`;
  }
  return { files: files.map((f: string) => f.trim()), status: status.trim(), maxAgeMinutes };
}

/**
 * This function reads the merge gates of a root package.json. A manifest with no field `releaseTrain.mergeGates` has no
 * gates and no faults. Each entry that is not a valid gate gives a fault. The caller holds each merge of a repository
 * with a fault, because it cannot tell which changes a wrong entry covers.
 */
export function readMergeGates(manifest: unknown): GateReading {
  if (!isRecord(manifest)) return { gates: [], faults: ["the root package.json is not an object"] };
  const settings = manifest[SETTINGS_KEY];
  if (settings === undefined) return { gates: [], faults: [] };
  if (!isRecord(settings)) return { gates: [], faults: [`${SETTINGS_KEY} is not an object`] };
  const list = settings["mergeGates"];
  if (list === undefined) return { gates: [], faults: [] };
  if (!Array.isArray(list)) return { gates: [], faults: [`${SETTINGS_KEY}.mergeGates is not a list`] };
  const reading: GateReading = { gates: [], faults: [] };
  list.forEach((entry, at) => {
    const gate = gateOf(entry, at);
    if (typeof gate === "string") reading.faults.push(gate);
    else reading.gates.push(gate);
  });
  return reading;
}

/**
 * This function gives the gates that a change covers: each gate with a pattern that matches a changed file. When GitHub
 * cut the list of files short (`cut`), the list can hide a file of a gate, so each gate counts.
 */
export function gatesFor(gates: readonly MergeGate[], files: readonly string[], cut: boolean): MergeGate[] {
  if (cut) return [...gates];
  return gates.filter((gate) => gate.files.some((pattern) => files.some((file) => globMatch(pattern, file))));
}

/**
 * This function gives the reason of each gate that holds the merge, or an empty list when each gate lets it go. The
 * statuses are the latest status of each context. A status that is missing, not `success`, without a valid time, or older
 * than the gate lets holds the merge.
 */
export function gateReasons(gates: readonly MergeGate[], statuses: readonly CommitStatus[], nowMs: number): string[] {
  const reasons: string[] = [];
  for (const gate of gates) {
    const found = statuses.find((s) => s.context === gate.status);
    if (found === undefined) {
      reasons.push(`the head commit has no status ${gate.status}`);
      continue;
    }
    if (found.state !== "success") {
      const note = found.description ? ` (${found.description})` : "";
      reasons.push(`the status ${gate.status} is ${found.state}${note}`);
      continue;
    }
    const at = found.updated_at ? Date.parse(found.updated_at) : Number.NaN;
    if (Number.isNaN(at)) {
      reasons.push(`the status ${gate.status} has no valid time`);
      continue;
    }
    const age = Math.floor((nowMs - at) / 60_000);
    if (age > gate.maxAgeMinutes) reasons.push(`the status ${gate.status} is ${age} minutes old, and the gate takes at most ${gate.maxAgeMinutes}`);
  }
  return reasons;
}
