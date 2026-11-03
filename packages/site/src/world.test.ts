import { describe, expect, it } from "vitest";
import { depKey, mainVersion, noChoices, planFor, SAMPLE, SCENARIOS, snapshot } from "./world.ts";

const ids = (c = noChoices()) => planFor(c).actions.map((a) => `${a.id}@${a.wave}`);

describe("the sample world", () => {
  it("uses made-up names of one owner", () => {
    for (const p of SAMPLE) expect(p.name.startsWith("@acme/") || p.app).toBe(true);
  });

  it("gives each repository one snapshot", () => {
    const { repos, npm } = snapshot(noChoices());
    expect(repos.map((r) => r.name).sort()).toEqual(["chart", "cli", "dashboard", "grid", "kit", "theme", "units"]);
    expect(repos.find((r) => r.name === "kit")?.manifests).toHaveLength(2);
    expect(npm["@acme/kit-react"]).toEqual({ exists: false, latest: null });
  });

  it("sets the version on main from the bump, with MINOR for a break before 1.0.0", () => {
    const grid = SAMPLE.find((p) => p.name === "@acme/grid");
    expect(grid && mainVersion(grid, { ...noChoices(), bumps: { "@acme/grid": "major" } })).toBe("0.7.0");
  });
});

describe("the planner on the sample world", () => {
  it("with no bump, plans only the new package and the two old lockfiles", () => {
    expect(ids()).toEqual(["new:@acme/kit-react@0", "update:chart@0", "update:dashboard@0"]);
  });

  it("with a major bump of units, makes a train in waves", () => {
    const p = planFor({ ...noChoices(), bumps: { "@acme/units": "major" } });
    const wave = (id: string) => p.actions.find((a) => a.id === id)?.wave ?? -1;
    expect(wave("release:units")).toBe(0);
    expect(wave("update:grid")).toBe(1);
    expect(wave("release:grid")).toBe(2);
    expect(wave("update:chart")).toBe(3);
    expect(wave("release:chart")).toBe(4);
    expect(wave("update:dashboard")).toBe(5);
    const grid = p.actions.find((a) => a.id === "release:grid");
    expect(grid?.packages[0]).toMatchObject({ from: "0.6.2", to: "0.6.3", bump: "patch" });
    expect(p.actions.find((a) => a.id === "update:grid")?.items[0]?.newRange).toBe("^2.0.0");
  });

  it("with a major bump of a peer, gives the dependent a major release", () => {
    const p = planFor({ ...noChoices(), bumps: { "@acme/theme": "major" } });
    expect(p.actions.find((a) => a.id === "release:chart")?.packages[0]).toMatchObject({ to: "3.0.0", bump: "major" });
  });

  it("holds a lockfile update to a version with no provenance", () => {
    const p = planFor({ ...noChoices(), noProvenance: ["@acme/theme"] });
    expect(p.actions.some((a) => a.id === "update:chart")).toBe(false);
    expect(p.edges.find((e) => e.from === "chart:." && e.to === "@acme/theme")?.status).toBe("waiting");
  });

  it("blocks a release with a github: dependency", () => {
    const p = planFor({ ...noChoices(), bumps: { "@acme/cli": "patch" }, git: [depKey("@acme/cli", "@acme/units")] });
    const cli = p.actions.find((a) => a.id === "release:cli");
    expect(cli?.blocked).toBe(true);
    expect(cli?.blockers[0]).toContain("github:acme/units#main");
  });

  it("gives each scenario a plan", () => {
    for (const s of SCENARIOS) expect(planFor(s.choices()).nodes).toHaveLength(SAMPLE.length);
  });
});
