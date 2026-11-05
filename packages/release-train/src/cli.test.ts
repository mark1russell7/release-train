import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHolding, paceOptions, parseArgs } from "./cli.ts";

const workflow = readFileSync(new URL("../../../.github/workflows/train.yml", import.meta.url), "utf8");

/** This function starts the shell of the step "Plan and apply" with a fake `node`, and gives the arguments of the command. */
function argsOfStep(env: Record<string, string>): string[] {
  const block = /name: Plan and apply[\s\S]*?run: \|\n((?: {10}.*\n)+)/.exec(workflow)?.[1];
  if (!block) throw new Error("The workflow has no step Plan and apply.");
  const script = `node() { shift; printf '%s\\n' "$@"; }\n${block.replace(/^ {10}/gm, "")}`;
  const output = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, LIVE: "true", RELEASE_DISPATCH: "false", CASCADE: "all", SYNC: "true", OWNER: "ex", AUTHOR: "a <a@ex>", WORKFLOWS: "no", ONLY: "", URGENT: "", INPUT_CASCADE: "", INPUT_DRY: "", ...env },
  });
  return output.split("\n").filter(Boolean);
}

describe("parseArgs", () => {
  it("has no urgent names by default", () => {
    expect(parseArgs(["apply"]).urgent).toBeNull();
  });

  it("reads the urgent names, comma-separated and in each --urgent", () => {
    expect(parseArgs(["apply", "--urgent", "@ex/a, @ex/b,", "--urgent", "c"]).urgent).toEqual(["@ex/a", "@ex/b", "c"]);
  });
});

describe("the holds of the command apply", () => {
  const file = (value: unknown): string => {
    const folder = mkdtempSync(join(tmpdir(), "apply-holds-"));
    const path = join(folder, "holds.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const hold = { package: "p", repo: "r", reason: "The owner holds it.", ruling: "https://example.test/r", until: "2026-11-07" };
  const now = new Date("2026-11-05T12:00:00Z");

  it("gets the file from the step of train.yml", () => {
    expect(parseArgs(argsOfStep({ EVENT: "workflow_dispatch", INPUT_DRY: "true" })).holds).toBe("lag-holds.json");
  });

  it("has no hold with no file", () => {
    expect(applyHolding({}, () => undefined)).toEqual([]);
  });

  it("gives the valid holds of the file", () => {
    const lines: string[] = [];
    expect(applyHolding({ holds: file({ holds: [hold] }), now }, (line) => lines.push(line))).toEqual([hold]);
    expect(lines).toEqual([]);
  });

  it("writes a fault, and an expired hold holds nothing", () => {
    const lines: string[] = [];
    expect(applyHolding({ holds: file({ holds: [{ ...hold, until: "2026-11-04" }] }), now }, (line) => lines.push(line))).toEqual([]);
    expect(lines).toEqual(["A fault of the holds: p in r: the date 2026-11-04 of the hold is in the past."]);
  });
});

describe("the urgent input of train.yml", () => {
  it("declares the input, and gives it to the step", () => {
    expect(workflow).toMatch(/workflow_dispatch:[\s\S]*\n {6}urgent:\n[\s\S]*\n {2}repository_dispatch:/);
    expect(workflow).toContain("URGENT: ${{ inputs.urgent }}");
  });

  it("brings the names of a manual start to the options of apply", () => {
    const o = parseArgs(argsOfStep({ EVENT: "workflow_dispatch", INPUT_DRY: "false", URGENT: "@ex/a,@ex/b" }));
    expect(paceOptions(o).urgent).toEqual(["@ex/a", "@ex/b"]);
    expect(o.dryRun).toBe(false);
  });

  it("keeps the default of a manual start: a dry run", () => {
    expect(parseArgs(argsOfStep({ EVENT: "workflow_dispatch", INPUT_DRY: "true", URGENT: "@ex/a" })).dryRun).toBe(true);
  });

  it("writes the names in the title of the run, because a replaced run has no other record of them", () => {
    expect(workflow).toContain("format('Train urgent {0}', inputs.urgent)");
    expect(workflow).toContain("inputs.dry-run && 'Train dry run'");
  });

  it("takes the names of a replaced run only in a live run", () => {
    expect(parseArgs(argsOfStep({ EVENT: "schedule" })).takeReplaced).toBe(true);
    expect(parseArgs(argsOfStep({ EVENT: "repository_dispatch" })).takeReplaced).toBe(true);
    expect(parseArgs(argsOfStep({ EVENT: "workflow_dispatch", INPUT_DRY: "false" })).takeReplaced).toBe(true);
    expect(parseArgs(argsOfStep({ EVENT: "workflow_dispatch", INPUT_DRY: "true" })).takeReplaced).toBe(false);
  });

  it("gives a run from the schedule or a released event no urgent names", () => {
    for (const EVENT of ["schedule", "repository_dispatch"]) expect(parseArgs(argsOfStep({ EVENT })).urgent).toBeNull();
  });
});
