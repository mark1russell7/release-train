import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paceOptions, parseArgs } from "./cli.ts";

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

  it("gives a run from the schedule or a released event no urgent names", () => {
    for (const EVENT of ["schedule", "repository_dispatch"]) expect(parseArgs(argsOfStep({ EVENT })).urgent).toBeNull();
  });
});
