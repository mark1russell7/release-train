import { describe, expect, it } from "vitest";
import type { GitHub } from "./github.ts";
import { type TrainRun, cancelledUrgent, takeReplaced, urgentOfTitle } from "./urgent.ts";

const run = (id: number, conclusion: string | null, display_title: string): TrainRun => ({ id, status: conclusion === null ? "in_progress" : "completed", conclusion, display_title });

const SELF = run(10, null, "Train");

describe("urgentOfTitle", () => {
  it("gives the names of an urgent title", () => {
    expect(urgentOfTitle("Train urgent @ex/a, fix")).toEqual(["@ex/a", "fix"]);
  });

  it("gives null for another title, for no name and for a name with a wrong form", () => {
    for (const title of ["Train", "Train dry run", "Train only a", "Train urgent ", "Train urgent $(x)", "Train urgent a b"]) expect(urgentOfTitle(title)).toBeNull();
  });
});

describe("cancelledUrgent", () => {
  it("finds a cancelled urgent run behind the run that replaced it", () => {
    const urgent = run(9, "cancelled", "Train urgent fix");
    expect(cancelledUrgent([SELF, urgent, run(8, "success", "Train")], 10)).toEqual([urgent]);
  });

  it("finds it behind a run that a newer run replaced too", () => {
    const urgent = run(8, "cancelled", "Train urgent fix");
    expect(cancelledUrgent([SELF, run(9, "cancelled", "Train"), urgent, run(7, "success", "Train")], 10)).toEqual([urgent]);
  });

  it("stops at a passed run, because that run took the names", () => {
    expect(cancelledUrgent([SELF, run(9, "success", "Train"), run(8, "cancelled", "Train urgent fix")], 10)).toEqual([]);
    expect(cancelledUrgent([SELF, run(9, "success", "Train urgent other"), run(8, "cancelled", "Train urgent fix")], 10)).toEqual([]);
  });

  it("continues past a failed run, a dry run and a run of some repositories", () => {
    const urgent = run(6, "cancelled", "Train urgent fix");
    const runs = [SELF, run(9, "failure", "Train"), run(8, "success", "Train dry run"), run(7, "success", "Train only a"), urgent];
    expect(cancelledUrgent(runs, 10)).toEqual([urgent]);
  });

  it("does not read a run that is newer than the run itself", () => {
    expect(cancelledUrgent([run(11, "cancelled", "Train urgent fix"), SELF], 10)).toEqual([]);
  });

  it("gives nothing when the list does not hold the run itself", () => {
    expect(cancelledUrgent([run(9, "cancelled", "Train urgent fix")], 10)).toEqual([]);
  });
});

describe("takeReplaced", () => {
  /** This function gives a GitHub client. `jobs` holds the count of jobs of each run. */
  const client = (runs: readonly TrainRun[], jobs: Record<number, number>): GitHub & { paths: string[] } => {
    const paths: string[] = [];
    return {
      paths,
      request: (async (_method: string, path: string) => {
        paths.push(path);
        const id = /\/runs\/(\d+)\/jobs/.exec(path)?.[1];
        return { status: 200, data: id === undefined ? { workflow_runs: runs } : { total_count: jobs[Number(id)] ?? 0 } };
      }) as GitHub["request"],
    } as GitHub & { paths: string[] };
  };

  it("takes the names of each replaced run once", async () => {
    const gh = client([SELF, run(9, "cancelled", "Train urgent a,b"), run(8, "cancelled", "Train urgent b,c"), run(7, "success", "Train")], {});
    expect(await takeReplaced(gh, "ex/release-train", 10)).toEqual({ names: ["a", "b", "c"], runs: [9, 8] });
    expect(gh.paths[0]).toContain("/repos/ex/release-train/actions/workflows/train.yml/runs");
  });

  it("leaves out a run that started and then stopped", async () => {
    const gh = client([SELF, run(9, "cancelled", "Train urgent a"), run(7, "success", "Train")], { 9: 1 });
    expect(await takeReplaced(gh, "ex/release-train", 10)).toEqual({ names: [], runs: [] });
  });

  it("throws when GitHub gives no list", async () => {
    const gh = { request: (async () => ({ ok: false, status: 502, data: null, message: "bad" })) as GitHub["request"] } as GitHub;
    await expect(takeReplaced(gh, "ex/release-train", 10)).rejects.toThrow("HTTP 502");
  });
});
