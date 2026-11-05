import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOLDS_FILE, extensionFaults, holdsOfFile, holdsUpdate, readHolds } from "./holds.ts";
import type { LagHold } from "./holds.ts";
import { FLIP_CASES, runFlip } from "./lag-flip.ts";
import { applyHolds, lagOver, lagSummary } from "./lag.ts";
import type { LagReport, LagRow } from "./lag.ts";

const NOW = new Date("2026-11-05T12:00:00Z");
const good: LagHold = { package: "p", reason: "The owner holds it.", ruling: "https://example.test/r", until: "2026-11-07" };
const read = (over: Partial<Record<keyof LagHold, unknown>>): string[] => readHolds({ holds: [{ ...good, ...over }] }, NOW).faults;

const row = (name: string, over = true): LagRow => ({
  repo: "r",
  private: false,
  package: name,
  published: "1.0.0",
  onBranch: "1.0.0",
  commit: "a".repeat(40),
  files: 1,
  firstChange: { sha: "b".repeat(40), title: "A change", at: "2026-11-01T00:00:00.000Z" },
  partial: false,
  ageDays: 3.4,
  reason: "kept-version",
  over,
});
const report = (rows: LagRow[]): LagReport => ({ owner: "o", generatedAt: NOW.toISOString(), packages: rows.length, rows, red: [], unread: [] });

describe("the hold list", () => {
  it("takes a valid hold", () => {
    expect(readHolds({ holds: [good] }, NOW)).toEqual({ holds: [good], faults: [] });
  });

  it("fails on a hold with no reason, no link or no date", () => {
    expect(read({ reason: " " })).toEqual(["p: the hold has no reason."]);
    expect(read({ ruling: undefined })).toEqual(["p: the hold has no https link to its ruling."]);
    expect(read({ ruling: "http://example.test/r" })).toEqual(["p: the hold has no https link to its ruling."]);
    expect(read({ until: undefined })).toEqual(["p: the hold has no date of the form YYYY-MM-DD."]);
    expect(read({ until: "2026-02-30" })).toEqual(["p: the hold has no date of the form YYYY-MM-DD."]);
  });

  it("holds through the last day of its date, and fails on a date in the past", () => {
    expect(read({ until: "2026-11-05" })).toEqual([]);
    expect(read({ until: "2026-11-04" })).toEqual(["p: the date 2026-11-04 of the hold is in the past."]);
  });

  it("fails on a date more than 14 days out", () => {
    expect(read({ until: "2026-11-19" })).toEqual([]);
    expect(read({ until: "2026-11-20" })).toEqual(["p: the date 2026-11-20 of the hold is more than 14 days after the run."]);
  });

  it("fails on two holds of one package and on a file with no list", () => {
    expect(readHolds({ holds: [good, good] }, NOW).faults).toEqual(["p: the file has two holds of this package."]);
    expect(readHolds({}, NOW).faults).toEqual(["The file of the holds has no list holds."]);
  });

  it("gives a hold with a fault no effect", () => {
    expect(readHolds({ holds: [{ ...good, until: "2026-11-04" }] }, NOW).holds).toEqual([]);
  });

  it("asks a new reason for a later date", () => {
    const later = { ...good, until: "2026-11-09" };
    expect(extensionFaults([good], [later])).toEqual(["p: the hold goes to 2026-11-09 with its old reason. An extension needs a new reason."]);
    expect(extensionFaults([good], [{ ...later, reason: "Vex needs its weekly run." }])).toEqual([]);
    expect(extensionFaults([], [later])).toEqual([]);
    expect(extensionFaults([later], [good])).toEqual([]);
  });

  it("reads an old file with no check of its dates", () => {
    expect(holdsOfFile({ holds: [{ ...good, until: "2020-01-01" }] })).toEqual([{ ...good, until: "2020-01-01" }]);
    expect(holdsOfFile({})).toEqual([]);
  });

  it("has a valid file in the repository, with the days after the run within the limit of its own commit", () => {
    const value: unknown = JSON.parse(readFileSync(new URL(`../../../${HOLDS_FILE}`, import.meta.url), "utf8"));
    const faults = holdsOfFile(value).flatMap((hold) => readHolds({ holds: [hold] }, new Date(`${hold.until}T00:00:00Z`)).faults);
    expect(faults).toEqual([]);
  });
});

describe("a hold of an update in one repository", () => {
  const here: LagHold = { ...good, repo: "app-repo" };

  it("takes a valid hold, and keeps the field", () => {
    expect(readHolds({ holds: [here] }, NOW)).toEqual({ holds: [here], faults: [] });
    expect(holdsOfFile({ holds: [here] })).toEqual([here]);
  });

  it("reads an empty field as no field", () => {
    expect(readHolds({ holds: [{ ...good, repo: " " }] }, NOW).holds[0]).not.toHaveProperty("repo");
  });

  it("names the repository in a fault, and an expired hold holds nothing", () => {
    const reading = readHolds({ holds: [{ ...here, until: "2026-11-04" }] }, NOW);
    expect(reading.faults).toEqual(["p in app-repo: the date 2026-11-04 of the hold is in the past."]);
    expect(reading.holds).toEqual([]);
  });

  it("keeps the limit of 14 days", () => {
    expect(readHolds({ holds: [{ ...here, until: "2026-11-20" }] }, NOW).faults).toEqual(["p in app-repo: the date 2026-11-20 of the hold is more than 14 days after the run."]);
  });

  it("takes one package in two repositories and with a release hold, and fails on two holds of one pair", () => {
    const other = { ...good, repo: "other-repo" };
    expect(readHolds({ holds: [here, other, good] }, NOW).faults).toEqual([]);
    expect(readHolds({ holds: [here, here] }, NOW).faults).toEqual(["p in app-repo: the file has two holds of this package."]);
  });

  it("asks a new reason for a later date of the same pair only", () => {
    const later = { ...here, until: "2026-11-09" };
    expect(extensionFaults([here], [later])).toEqual(["p in app-repo: the hold goes to 2026-11-09 with its old reason. An extension needs a new reason."]);
    expect(extensionFaults([good], [later])).toEqual([]);
    expect(extensionFaults([{ ...good, repo: "other-repo" }], [later])).toEqual([]);
  });

  it("stops the update only in its repository, and a release hold stops no update", () => {
    expect(holdsUpdate([here], "app-repo", "p")).toBe(true);
    expect(holdsUpdate([here], "other-repo", "p")).toBe(false);
    expect(holdsUpdate([here], "app-repo", "q")).toBe(false);
    expect(holdsUpdate([good], "app-repo", "p")).toBe(false);
  });

  it("does not hold a release row, so the gate fails on that row", () => {
    const report1 = applyHolds(report([row("p")]), { holds: [here], faults: [] });
    expect(report1.rows[0]?.held).toBeUndefined();
    expect(lagOver(report1)).toBe(true);
  });

  it("adds no row and does not fail the gate, and the report lists it apart", () => {
    const report1 = applyHolds(report([row("q", false)]), { holds: [here], faults: [] });
    expect(report1.rows).toHaveLength(1);
    expect(lagOver(report1)).toBe(false);
    const text = lagSummary(report1);
    expect(text).toContain("The gate passes.");
    expect(text).toContain("## Updates held in one repository\n\n- p in app-repo, to 2026-11-07: [The owner holds it.](https://example.test/r)");
    expect(text).not.toContain("Holds with no row");
  });
});

describe("the gate with holds", () => {
  it("keeps a held row over its limit, and passes", () => {
    const held = applyHolds(report([row("p")]), { holds: [good], faults: [] });
    expect(lagOver(held)).toBe(false);
    expect(held.rows[0]?.over).toBe(true);
    expect(held.rows[0]?.held).toEqual(good);
  });

  it("fails on a new row over its limit while another row is held", () => {
    expect(lagOver(applyHolds(report([row("p"), row("q")]), { holds: [good], faults: [] }))).toBe(true);
  });

  it("fails on a fault of the list, with no row over its limit", () => {
    expect(lagOver(applyHolds(report([]), { holds: [], faults: ["A fault."] }))).toBe(true);
  });

  it("gives the days and the hold of a held row in the summary, and it does not read as passed", () => {
    const text = lagSummary(applyHolds(report([row("p")]), { holds: [good], faults: [] }));
    expect(text).toContain("The gate holds 1 row over its limit. No row fails.");
    expect(text).toContain("## Held, over the limit");
    expect(text).toContain("| p | 1.0.0 | 1.0.0 | 3.4 | 2026-11-07 | [The owner holds it.](https://example.test/r) | b".concat("b".repeat(6), " A change |"));
    expect(text).not.toContain("## Over the limit");
    expect(text).not.toContain("The gate passes");
  });

  it("says that the gate fails, and names the fault", () => {
    const text = lagSummary(applyHolds(report([row("q")]), { holds: [], faults: ["A fault."] }));
    expect(text).toContain("The gate fails: 1 row over its limit with no hold, 1 fault of the holds.");
    expect(text).toContain("## Faults of the holds\n\n- A fault.");
  });

  it("names a hold with no row over its limit, and does not fail on it", () => {
    const held = applyHolds(report([row("q", false)]), { holds: [{ ...good, package: "q" }], faults: [] });
    expect(lagOver(held)).toBe(false);
    expect(held.rows[0]?.held).toBeUndefined();
    expect(lagSummary(held)).toContain("## Holds with no row over the limit\n\n- q, to 2026-11-07");
    expect(lagSummary(held)).toContain("The gate passes.");
  });

  it("leaves a report with no list of holds as it was", () => {
    const text = lagSummary(report([row("q", false)]));
    expect(text).toContain("The gate passes.");
    expect(text).not.toContain("Holds with no row");
  });
});

describe("the flip test", () => {
  it("has three cases that fail and one that passes", () => {
    expect(FLIP_CASES.map((item) => item.code)).toEqual([1, 1, 1, 0]);
  });

  it("passes on the real gate", () => {
    expect(runFlip()).toEqual([]);
  });

  it("finds a gate that gives another result", () => {
    const wrong = FLIP_CASES.map((item) => ({ ...item, code: item.code === 0 ? 1 : 0 }));
    expect(runFlip(wrong)).toHaveLength(FLIP_CASES.length);
  });
});
