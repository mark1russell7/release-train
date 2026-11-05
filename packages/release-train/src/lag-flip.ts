// The flip test of the lag gate. This script starts the command `lag` on a saved report, with no network, and each case
// gives a hold list. The gate has to fail on the first two cases and pass on the third, in the same job. So a gate that
// cannot fail makes this script fail.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LagHold } from "./holds.ts";
import type { LagReport, LagRow } from "./lag.ts";

const NOW = "2026-11-05T12:00:00.000Z";
const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

const row = (name: string): LagRow => ({
  repo: "r",
  private: false,
  package: name,
  published: "1.0.0",
  onBranch: "1.0.0",
  commit: "a".repeat(40),
  files: 1,
  firstChange: { sha: "b".repeat(40), title: "A change", at: "2026-11-01T00:00:00.000Z" },
  partial: false,
  ageDays: 4.5,
  reason: "kept-version",
  over: true,
});

const report = (names: readonly string[]): LagReport => ({ owner: "o", generatedAt: NOW, packages: names.length, rows: names.map(row), red: [], unread: [] });

const hold = (name: string, until: string): LagHold => ({ package: name, reason: "The owner holds the release.", ruling: "https://example.test/ruling", until });

/** One case of the flip: a report, a hold list, the exit code of the gate, and a text that the output has. */
export interface FlipCase {
  name: string;
  report: LagReport;
  holds: readonly LagHold[];
  code: number;
  says: string;
}

/** The three cases of the flip test. */
export const FLIP_CASES: readonly FlipCase[] = [
  { name: "a new package over the limit fails while another package is held", report: report(["held", "new"]), holds: [hold("held", "2026-11-07")], code: 1, says: "The gate fails" },
  { name: "a date in the past fails", report: report(["held"]), holds: [hold("held", "2026-11-04")], code: 1, says: "is in the past" },
  { name: "a held row alone passes, and it reads as held", report: report(["held"]), holds: [hold("held", "2026-11-07")], code: 0, says: "The gate holds 1 row" },
];

/** This function starts the gate on each case and gives a fault for each result that differs from its case. */
export function runFlip(cases: readonly FlipCase[] = FLIP_CASES): string[] {
  const folder = mkdtempSync(join(tmpdir(), "lag-flip-"));
  try {
    return cases.flatMap((item, index) => {
      const reportFile = join(folder, `report-${index}.json`);
      const holdsFile = join(folder, `holds-${index}.json`);
      writeFileSync(reportFile, JSON.stringify(item.report));
      writeFileSync(holdsFile, JSON.stringify({ holds: item.holds }));
      const done = spawnSync(process.execPath, ["--no-warnings", BIN, "lag", "--from-report", reportFile, "--holds", holdsFile, "--gate", "--now", NOW], { encoding: "utf8" });
      const faults: string[] = [];
      if (done.status !== item.code) faults.push(`${item.name}: the exit code is ${String(done.status)}, not ${item.code}. ${done.stderr}`);
      if (!done.stdout.includes(item.says)) faults.push(`${item.name}: the output does not have "${item.says}".`);
      return faults;
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const faults = runFlip();
  for (const item of FLIP_CASES) process.stdout.write(`${faults.some((fault) => fault.startsWith(item.name)) ? "FAIL" : "ok"}: ${item.name}\n`);
  for (const fault of faults) process.stderr.write(`${fault}\n`);
  process.exitCode = faults.length === 0 ? 0 : 1;
}
