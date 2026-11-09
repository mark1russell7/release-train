// All names in these tests are made up. No test uses the network.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState, firstAbove, needStarts, readState } from "./state.ts";
import type { NpmInfo } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = (text: string | null): string => {
  const d = mkdtempSync(join(tmpdir(), "train-state-"));
  dirs.push(d);
  const p = join(d, "train-state.json");
  if (text !== null) writeFileSync(p, text);
  return p;
};

const tool: NpmInfo = {
  exists: true,
  latest: "1.3.0",
  times: { "1.0.0": "2026-10-01T00:00:00Z", "1.1.0": "2026-11-01T00:00:00Z", "1.2.0-rc.1": "2026-10-20T00:00:00Z", "1.3.0": "2026-11-05T00:00:00Z", bad: "2026-01-01T00:00:00Z" },
};

describe("the state of the train", () => {
  it("reads a good file, and starts again from a missing, broken or unknown file with a note", () => {
    const state = { version: 1, npm: { "@ex/tool": { modified: "m", times: { "1.0.0": "t" } } }, seen: { h: "2026-11-09T00:00:00Z" } };
    expect(readState(file(JSON.stringify(state)))).toEqual({ state, note: null });
    for (const [text, part] of [
      [null, "No state file"],
      ["{", "is not JSON"],
      [JSON.stringify({ version: 2, npm: {}, seen: {} }), "unknown format"],
      [JSON.stringify({ version: 1, npm: null, seen: {} }), "unknown format"],
    ] as const) {
      const read = readState(file(text));
      expect(read.state).toEqual(emptyState());
      expect(read.note).toContain(part);
    }
  });

  it("gives the publish time of the first stable version above the version before the update", () => {
    expect(firstAbove(tool, "1.0.0")).toBe("2026-11-01T00:00:00Z");
    expect(firstAbove(tool, "1.1.0")).toBe("2026-11-05T00:00:00Z");
    // No version above, no version before the update, no times, or a version that is not SemVer: no time.
    expect(firstAbove(tool, "1.3.0")).toBeUndefined();
    expect(firstAbove(tool, null)).toBeUndefined();
    expect(firstAbove(tool, "workspace:*")).toBeUndefined();
    expect(firstAbove({ exists: true, latest: "1.0.0" }, "0.9.0")).toBeUndefined();
    expect(firstAbove(undefined, "1.0.0")).toBeUndefined();
  });

  it("starts each need at its publish time, else at the first run that saw it, and keeps only the needs of the run", () => {
    const hash = (k: string): string => `h:${k.replaceAll("\0", "|")}`;
    const prior = { "h:app|packages/a|@ex/gone|1.0.0": "2026-11-02T00:00:00Z", "h:old|x|y|z": "2026-01-01T00:00:00Z" };
    const run = needStarts({ "@ex/tool": tool }, prior, "2026-11-09T20:30:00Z", hash);
    // The oldest need of the update decides: the publish time of 1.1.0 is before the first sight of @ex/gone.
    expect(run.since("app", [{ path: "", dep: "@ex/tool", from: "1.0.0" }, { path: "packages/a", dep: "@ex/gone", from: "1.0.0" }])).toBe("2026-11-01T00:00:00Z");
    // A need with no publish time keeps its first sight from the state, and a new one starts now.
    expect(run.since("app", [{ path: "packages/a", dep: "@ex/gone", from: "1.0.0" }])).toBe("2026-11-02T00:00:00Z");
    expect(run.since("lib", [{ path: "", dep: "@ex/new", from: "2.0.0" }])).toBe("2026-11-09T20:30:00Z");
    // A settings update has no item, so it has one need for its repository.
    expect(run.since("lib", [])).toBe("2026-11-09T20:30:00Z");
    expect(run.seen()).toEqual({
      "h:app|packages/a|@ex/gone|1.0.0": "2026-11-02T00:00:00Z",
      "h:lib||@ex/new|2.0.0": "2026-11-09T20:30:00Z",
      "h:lib|settings": "2026-11-09T20:30:00Z",
    });
    expect(run.counts()).toEqual({ npm: 1, state: 4 });
    // The next run keeps the first sight, so the start does not renew in each run.
    const next = needStarts({}, run.seen(), "2026-11-09T21:00:00Z", hash);
    expect(next.since("lib", [{ path: "", dep: "@ex/new", from: "2.0.0" }])).toBe("2026-11-09T20:30:00Z");
  });
});
