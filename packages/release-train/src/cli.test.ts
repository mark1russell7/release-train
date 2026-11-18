import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NEED, DEFAULT_WAIT_MINUTES } from "./budget.ts";
import { applyHolding, hashKey, paceOptions, parseArgs, runApply } from "./cli.ts";
import type { FetchFn } from "./collect.ts";

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

/** This function starts the shell of the step "Version fix" with a fake `node`, and gives the arguments of the command. */
function argsOfVersionFix(env: Record<string, string>): string[] {
  const block = /name: Version fix[\s\S]*?run: \|\n((?: {10}.*\n)+)/.exec(workflow)?.[1];
  if (!block) throw new Error("The workflow has no step Version fix.");
  const script = `node() { shift; printf '%s\\n' "$@"; }\n${block.replace(/^ {10}/gm, "")}`;
  const output = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, OWNER: "ex", AUTHOR: "a <a@ex>", ONLY: "", INPUT_DRY: "", ...env },
  });
  return output.split("\n").filter(Boolean);
}

describe("the step Version fix of train.yml", () => {
  it("changes pull requests from the schedule only when LIVE and VERSION_FIX_LIVE are both true", () => {
    expect(argsOfVersionFix({ EVENT: "schedule", LIVE: "true", VERSION_FIX_LIVE: "false" })).toContain("--dry-run");
    expect(argsOfVersionFix({ EVENT: "schedule", LIVE: "false", VERSION_FIX_LIVE: "true" })).toContain("--dry-run");
    expect(argsOfVersionFix({ EVENT: "schedule", LIVE: "true", VERSION_FIX_LIVE: "true" })).not.toContain("--dry-run");
  });

  it("follows the dry-run input in a start by hand", () => {
    expect(argsOfVersionFix({ EVENT: "workflow_dispatch", INPUT_DRY: "true", LIVE: "true", VERSION_FIX_LIVE: "false" })).toContain("--dry-run");
    expect(argsOfVersionFix({ EVENT: "workflow_dispatch", INPUT_DRY: "false", LIVE: "true", VERSION_FIX_LIVE: "false" })).not.toContain("--dry-run");
  });

  it("does not change the step Plan and apply", () => {
    expect(parseArgs(argsOfStep({ EVENT: "schedule", VERSION_FIX_LIVE: "false" })).takeReplaced).toBe(true);
  });
});

describe("the key of the private-name hashes", () => {
  it("comes from its own secret, not from the private key of the app", () => {
    expect(workflow).toContain("RELEASE_TRAIN_HASH_KEY: ${{ secrets.RELEASE_TRAIN_HASH_KEY }}");
    expect(workflow).not.toContain("RELEASE_TRAIN_HASH_KEY: ${{ secrets.RELEASE_TRAIN_APP_KEY }}");
  });

  it("refuses an empty key in GitHub Actions and a PEM key everywhere", () => {
    expect(hashKey({ RELEASE_TRAIN_HASH_KEY: "a-random-key", GITHUB_ACTIONS: "true" })).toBe("a-random-key");
    // A local run can hash with no key: its output stays on the machine
    expect(hashKey({})).toBe("");
    expect(() => hashKey({ GITHUB_ACTIONS: "true" })).toThrow("RELEASE_TRAIN_HASH_KEY is empty");
    expect(() => hashKey({ GITHUB_ACTIONS: "true", RELEASE_TRAIN_HASH_KEY: "" })).toThrow("RELEASE_TRAIN_HASH_KEY is empty");
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIE", "-----END RSA PRIVATE KEY-----"].join("\n");
    expect(() => hashKey({ RELEASE_TRAIN_HASH_KEY: pem })).toThrow("PEM private key");
    expect(() => hashKey({ RELEASE_TRAIN_HASH_KEY: pem.replace(" RSA", "") })).toThrow("PEM private key");
  });
});

describe("the options of the rate budget", () => {
  it("takes the need from the runs and the default longest wait", () => {
    const o = parseArgs(["apply"]);
    expect(o.rateNeed).toBeNull();
    expect(o.rateWait).toBe(DEFAULT_WAIT_MINUTES);
  });

  it("reads --rate-need and --rate-wait, and refuses a bad value", () => {
    expect(parseArgs(["apply", "--rate-need", "0", "--rate-wait", "7.5"])).toMatchObject({ rateNeed: 0, rateWait: 7.5 });
    expect(() => parseArgs(["apply", "--rate-need", "-1"])).toThrow("--rate-need needs a whole number");
    expect(() => parseArgs(["apply", "--rate-need", "2.5"])).toThrow("--rate-need needs a whole number");
    expect(() => parseArgs(["apply", "--rate-wait", "soon"])).toThrow("--rate-wait needs a number");
    expect(() => parseArgs(["apply", "--rate-wait"])).toThrow("--rate-wait needs a value");
  });
});

describe("runApply and the rate budget", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stops with the exit code 0, and writes the report and the summary, when the reset is far", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rate-budget-"));
    const report = join(dir, "apply.json");
    const summaryFile = join(dir, "summary.md");
    writeFileSync(summaryFile, "");
    vi.stubEnv("GH_TOKEN", "ghs_example");
    vi.stubEnv("RELEASE_TRAIN_HASH_KEY", "example-key");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summaryFile);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const now = Date.parse("2026-11-15T12:00:00Z");
    const seen: string[] = [];
    const fetch: FetchFn = async (url) => {
      seen.push(new URL(url).pathname);
      if (url.endsWith("/rate_limit")) {
        return new Response(JSON.stringify({ resources: { core: { limit: 10_200, used: 10_160, remaining: 40, reset: now / 1000 + 45 * 60 } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "The test answers only the rate limit." }), { status: 500 });
    };
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const code = await runApply(parseArgs(["apply", "--owner", "example-owner", "--report", report]), { fetch, now: () => now, sleep });
    expect(code).toBe(0);
    expect(sleeps).toEqual([]);
    // Only the two reads of the rate limit: the gate stops the run before the first read of a repository.
    expect(seen).toEqual(["/rate_limit", "/rate_limit"]);
    const written: unknown = JSON.parse(readFileSync(report, "utf8"));
    expect(written).toMatchObject({
      owner: "example-owner",
      at: "2026-11-15T12:00:00.000Z",
      dryRun: false,
      results: [],
      inFlight: [],
      rateLimit: { start: { remaining: 40 }, end: { remaining: 40 }, routes: [], gate: { outcome: "stop", need: DEFAULT_NEED, left: 40, waitedMs: 0 } },
    });
    const summary = readFileSync(summaryFile, "utf8");
    expect(summary).toContain("The run stops, and a later run does the work.");
    expect(summary).toContain("GitHub requests by route: none.");
    expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain("::notice::Rate budget: 40 requests are left");
  });

  it("ends the run with the exit code 0 when the guard stops it after the gate, and writes the stop in the report and the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rate-guard-"));
    const report = join(dir, "apply.json");
    const summaryFile = join(dir, "summary.md");
    writeFileSync(summaryFile, "");
    vi.stubEnv("GH_TOKEN", "ghs_example");
    vi.stubEnv("RELEASE_TRAIN_HASH_KEY", "example-key");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summaryFile);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const now = Date.parse("2026-11-15T12:00:00Z");
    let counted = 0;
    const fetch: FetchFn = async (url) => {
      // A stale read at the start: it shows a large budget, so the gate lets the run go on.
      if (url.endsWith("/rate_limit")) {
        return new Response(JSON.stringify({ resources: { core: { limit: 10_250, used: 276, remaining: 9974, reset: now / 1000 + 34 * 60 } } }), { status: 200 });
      }
      if (!url.startsWith("https://api.github.com/")) return new Response("{}", { status: 404 });
      counted++;
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-used": "10250", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 45 * 60) },
      });
    };
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const code = await runApply(parseArgs(["apply", "--owner", "example-owner", "--report", report]), { fetch, now: () => now, sleep });
    expect(code).toBe(0);
    expect(sleeps).toEqual([]);
    // GitHub refuses the first request of the run. The reset is after the longest wait, so no other request goes to GitHub.
    expect(counted).toBe(1);
    const written = JSON.parse(readFileSync(report, "utf8")) as { rateLimit: { guard: { stop: string } } };
    expect(written).toMatchObject({ results: [], inFlight: [], rateLimit: { gate: { outcome: "go" }, guard: { sent: 1, repeats: 0, waitedMs: 0 } } });
    expect(written.rateLimit.guard.stop).toContain("The reset at 2026-11-15T12:45:00.000Z is 45.0 minutes away");
    const summary = readFileSync(summaryFile, "utf8");
    expect(summary).toContain("Rate guard: GitHub refused a request, because the rate limit is spent until 2026-11-15T12:45:00.000Z.");
    expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain("::notice::Rate guard: GitHub refused a request");
  });
});
