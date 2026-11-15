import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { UNSETTLED } from "./run-command.ts";

const guard = pathToFileURL(fileURLToPath(new URL("./run-command.ts", import.meta.url))).href;

/** This function runs a module script in a new Node process and gives its exit code and its output. */
function run(script: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A command that waits on a timer with unref: no handle keeps the process alive during the wait. */
const unrefWait = "await new Promise((resolve) => setTimeout(resolve, 200).unref());";

describe("runCommand", () => {
  it("the control: with a plain then, Node ends the process during the wait, with code 0 and no output", () => {
    const result = run(`
      const command = async () => { ${unrefWait} console.log("after the wait"); return 0; };
      command().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("after the wait");
  });

  it("gives the exit code 1 and the text UNSETTLED when the process ends during the wait", () => {
    const result = run(`
      const { runCommand } = await import(${JSON.stringify(guard)});
      runCommand(async () => { ${unrefWait} console.log("after the wait"); return 0; });
    `);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("after the wait");
    expect(result.stderr).toContain(UNSETTLED);
  });

  it("gives the code of the command after a wait that keeps the process alive", () => {
    const result = run(`
      const { runCommand } = await import(${JSON.stringify(guard)});
      runCommand(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); console.log("after the wait"); return 3; });
    `);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("after the wait");
    expect(result.stderr).not.toContain(UNSETTLED);
  });

  it("gives the exit code 0 of a command that ends with 0", () => {
    const result = run(`
      const { runCommand } = await import(${JSON.stringify(guard)});
      runCommand(async () => 0);
    `);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(UNSETTLED);
  });

  it("writes the text of a thrown value and gives the exit code 1", () => {
    const result = run(`
      const { runCommand } = await import(${JSON.stringify(guard)});
      runCommand(async () => { throw new Error("the read failed"); });
    `);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the read failed");
    expect(result.stderr).not.toContain(UNSETTLED);
  });

  it("writes the text of a value that is not an Error", () => {
    const result = run(`
      const { runCommand } = await import(${JSON.stringify(guard)});
      runCommand(async () => { throw "a plain text"; });
    `);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a plain text");
  });
});
