import { describe, expect, it } from "vitest";
import { GATE_AGE_MAX_MINUTES, gateReasons, gatesFor, readMergeGates } from "./merge-gates.ts";
import type { MergeGate } from "./merge-gates.ts";

const LOCK: MergeGate = { files: ["pnpm-lock.yaml"], status: "install-fits", maxAgeMinutes: 10 };
const MANIFESTS: MergeGate = { files: ["package.json", "packages/*/package.json"], status: "manifest-review", maxAgeMinutes: 60 };

describe("readMergeGates", () => {
  it("gives no gates and no faults for a manifest with no field releaseTrain.mergeGates", () => {
    expect(readMergeGates({ name: "x" })).toEqual({ gates: [], faults: [] });
    expect(readMergeGates({ releaseTrain: {} })).toEqual({ gates: [], faults: [] });
  });

  it("reads each valid gate, and trims its paths and its status", () => {
    const reading = readMergeGates({ releaseTrain: { mergeGates: [{ files: [" pnpm-lock.yaml "], status: " install-fits ", maxAgeMinutes: 10 }, MANIFESTS] } });
    expect(reading).toEqual({ gates: [LOCK, MANIFESTS], faults: [] });
  });

  it("gives a fault for each wrong entry, and keeps the valid gates", () => {
    const reading = readMergeGates({
      releaseTrain: {
        mergeGates: [
          LOCK,
          "pnpm-lock.yaml",
          { files: [], status: "a", maxAgeMinutes: 1 },
          { files: ["x", 3], status: "a", maxAgeMinutes: 1 },
          { files: ["x"], status: " ", maxAgeMinutes: 1 },
          { files: ["x"], status: "a", maxAgeMinutes: 0 },
          { files: ["x"], status: "a", maxAgeMinutes: 1.5 },
          { files: ["x"], status: "a", maxAgeMinutes: GATE_AGE_MAX_MINUTES + 1 },
          { files: ["x"], status: "a", maxAgeMinutes: "10" },
        ],
      },
    });
    expect(reading.gates).toEqual([LOCK]);
    expect(reading.faults).toEqual([
      "mergeGates[1] is not an object",
      "mergeGates[2].files is not a list of one or more paths",
      "mergeGates[3].files is not a list of one or more paths",
      "mergeGates[4].status is not the name of a commit status",
      `mergeGates[5].maxAgeMinutes is not a whole number from 1 to ${GATE_AGE_MAX_MINUTES}`,
      `mergeGates[6].maxAgeMinutes is not a whole number from 1 to ${GATE_AGE_MAX_MINUTES}`,
      `mergeGates[7].maxAgeMinutes is not a whole number from 1 to ${GATE_AGE_MAX_MINUTES}`,
      `mergeGates[8].maxAgeMinutes is not a whole number from 1 to ${GATE_AGE_MAX_MINUTES}`,
    ]);
  });

  it("gives a fault for settings of the wrong shape", () => {
    expect(readMergeGates(null).faults).toEqual(["the root package.json is not an object"]);
    expect(readMergeGates([1]).faults).toEqual(["the root package.json is not an object"]);
    expect(readMergeGates({ releaseTrain: [] }).faults).toEqual(["releaseTrain is not an object"]);
    expect(readMergeGates({ releaseTrain: { mergeGates: LOCK } }).faults).toEqual(["releaseTrain.mergeGates is not a list"]);
  });
});

describe("gatesFor", () => {
  it("gives each gate with a pattern that matches a changed file, and no gate for other changes", () => {
    expect(gatesFor([LOCK, MANIFESTS], ["pnpm-lock.yaml", "src/a.ts"], false)).toEqual([LOCK]);
    expect(gatesFor([LOCK, MANIFESTS], ["packages/core/package.json"], false)).toEqual([MANIFESTS]);
    expect(gatesFor([LOCK, MANIFESTS], ["src/a.ts", "packages/core/src/package.json.ts"], false)).toEqual([]);
    // A pattern with no `*` matches only the same path: a lockfile in a folder is another file.
    expect(gatesFor([LOCK], ["examples/pnpm-lock.yaml"], false)).toEqual([]);
    expect(gatesFor([], ["pnpm-lock.yaml"], false)).toEqual([]);
  });

  it("gives each gate when the list of files is cut, because the list can hide a file of a gate", () => {
    expect(gatesFor([LOCK, MANIFESTS], [], true)).toEqual([LOCK, MANIFESTS]);
  });
});

describe("gateReasons", () => {
  const NOW = Date.parse("2026-11-21T20:00:00Z");
  const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

  it("lets the merge go when the status of each gate is success and not older than the gate allows", () => {
    expect(gateReasons([LOCK], [{ context: "install-fits", state: "success", updated_at: at(10) }], NOW)).toEqual([]);
    expect(gateReasons([], [], NOW)).toEqual([]);
  });

  it("holds the merge for a status that is missing, not success, old, or with no valid time", () => {
    expect(gateReasons([LOCK], [{ context: "CI OK", state: "success", updated_at: at(1) }], NOW)).toEqual(["the head commit has no status install-fits"]);
    expect(gateReasons([LOCK], [{ context: "install-fits", state: "pending", description: "the install does not fit now", updated_at: at(1) }], NOW)).toEqual([
      "the status install-fits is pending (the install does not fit now)",
    ]);
    expect(gateReasons([LOCK], [{ context: "install-fits", state: "failure", updated_at: at(1) }], NOW)).toEqual(["the status install-fits is failure"]);
    expect(gateReasons([LOCK], [{ context: "install-fits", state: "success", updated_at: at(11) }], NOW)).toEqual([
      "the status install-fits is 11 minutes old, and the gate takes at most 10",
    ]);
    expect(gateReasons([LOCK], [{ context: "install-fits", state: "success", updated_at: null }], NOW)).toEqual(["the status install-fits has no valid time"]);
    expect(gateReasons([LOCK], [{ context: "install-fits", state: "success", updated_at: "soon" }], NOW)).toEqual(["the status install-fits has no valid time"]);
  });

  it("gives one reason for each gate that holds", () => {
    const statuses = [{ context: "install-fits", state: "success", updated_at: at(2) }];
    expect(gateReasons([LOCK, MANIFESTS], statuses, NOW)).toEqual(["the head commit has no status manifest-review"]);
  });
});
