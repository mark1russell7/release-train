import { describe, expect, it } from "vitest";
import { BOX, dependencyDrawing, semverReason, trainDrawing } from "./layout.ts";
import { noChoices, planFor, SAMPLE } from "./world.ts";

describe("the drawings", () => {
  const p = planFor({ ...noChoices(), bumps: { "@acme/units": "major" } });

  it("puts each action into the column of its wave", () => {
    const d = trainDrawing(p);
    expect(d.boxes).toHaveLength(p.actions.length);
    for (const a of p.actions) expect(d.boxes.find((b) => b.id === a.id)?.column).toBe(a.wave);
    expect(d.columns).toBe(6);
    expect(d.width).toBe(BOX.pad * 2 + 6 * BOX.w + 5 * BOX.gapX);
  });

  it("draws an arrow for each wait of an action", () => {
    const d = trainDrawing(p);
    expect(d.arrows).toHaveLength(p.actions.reduce((n, a) => n + a.dependsOn.length, 0));
    expect(d.arrows.some((a) => a.from === "release:units" && a.to === "update:grid")).toBe(true);
  });

  it("puts each package into the column of its level", () => {
    const d = dependencyDrawing(p);
    expect(d.boxes).toHaveLength(SAMPLE.length);
    for (const n of p.nodes) expect(d.boxes.find((b) => b.id === n.id)?.column).toBe(n.level);
    expect(d.arrows.some((a) => a.from === "@acme/units" && a.to === "@acme/grid" && a.status === "breaking")).toBe(true);
  });
});

describe("the SemVer reason", () => {
  it("names the rule of each bump", () => {
    expect(semverReason({ name: "a", path: "", from: "1.0.0", to: "2.0.0", bump: "major", why: "" }, undefined)).toMatch(/^MAJOR/);
    expect(semverReason({ name: "a", path: "", from: "0.6.0", to: "0.7.0", bump: "major", why: "" }, undefined)).toMatch(/^MINOR/);
    expect(semverReason({ name: "a", path: "", from: "0.6.2", to: "0.6.3", bump: "patch", why: "" }, undefined)).toMatch(/^PATCH/);
    expect(semverReason({ name: "a", path: "", from: "0.6.2", to: "0.7.0", bump: null, why: "" }, "major")).toMatch(/^MINOR/);
    expect(semverReason({ name: "a", path: "", from: null, to: "0.1.0", bump: null, why: "" }, undefined)).toBe("first release");
  });
});
