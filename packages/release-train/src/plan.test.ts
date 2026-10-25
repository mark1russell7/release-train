// All repository and package names in these tests are made up.
import { describe, expect, it } from "vitest";
import { buildGraph, publicView } from "./graph.ts";
import { bumpVersion, plan, suggestRange } from "./plan.ts";
import type { Manifest, NpmInfo, RepoSnapshot, Resolved } from "./types.ts";

function repo(
  name: string,
  manifests: Record<string, Manifest>,
  opts: { private?: boolean; resolved?: Resolved; lock?: RepoSnapshot["lockKind"] } = {},
): RepoSnapshot {
  return {
    name,
    private: opts.private ?? false,
    defaultBranch: "main",
    manifests: Object.entries(manifests).map(([path, manifest]) => ({ path, manifest })),
    lockKind: opts.lock ?? "pnpm",
    resolved: opts.resolved ?? {},
    warnings: [],
  };
}
const npm = (latest: string): NpmInfo => ({ exists: true, latest });
const NONE: NpmInfo = { exists: false, latest: null };

function run(repos: RepoSnapshot[], registry: Record<string, NpmInfo>) {
  return plan(buildGraph({ owner: "example-owner", repos, npm: registry, now: new Date("2026-01-01T00:00:00Z") }));
}

describe("range logic", () => {
  it("plans a lockfile update only when the new version is in range", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "1.4.0" } }),
        repo("app-repo", { "": { name: "@ex/app", version: "2.0.0", dependencies: { "@ex/core": "^1.2.0" } } }, {
          resolved: { "": { "@ex/core": "1.3.0" } },
        }),
      ],
      { "@ex/core": npm("1.4.0"), "@ex/app": npm("2.0.0") },
    );
    expect(p.actions.map((a) => [a.id, a.kind])).toEqual([["update:app-repo", "adopt-in-range"]]);
    expect(p.actions[0]?.items[0]).toMatchObject({ dep: "@ex/core", resolved: "1.3.0", to: "1.4.0", newRange: null });
    // A caret range already reaches the users, so the dependent does not release.
    expect(p.counts.actions.release).toBe(0);
    expect(p.nodes.find((n) => n.id === "@ex/app")?.status).toBe("adopt");
  });

  it("marks an edge current when the lockfile has the newest version", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "1.4.0" } }),
        repo("app-repo", { "": { name: "app", private: true, devDependencies: { "@ex/core": "^1.0.0" } } }, {
          resolved: { "": { "@ex/core": "1.4.0(peer@1.0.0)" } },
        }),
      ],
      { "@ex/core": npm("1.4.0") },
    );
    expect(p.actions).toEqual([]);
    expect(p.edges[0]?.status).toBe("current");
  });

  it("plans a breaking adoption and a cascade release for a published runtime dependent", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "2.0.0" } }),
        repo("lib-repo", { "": { name: "@ex/lib", version: "1.1.0", dependencies: { "@ex/core": "^1.5.0" } } }, {
          resolved: { "": { "@ex/core": "1.5.0" } },
        }),
      ],
      { "@ex/core": npm("1.5.0"), "@ex/lib": npm("1.1.0") },
    );
    expect(p.actions.map((a) => a.id)).toEqual(["release:core-repo", "update:lib-repo", "release:lib-repo"]);
    const upd = p.actions[1];
    expect(upd?.kind).toBe("adopt-breaking");
    expect(upd?.items[0]?.newRange).toBe("^2.0.0");
    expect(upd?.dependsOn).toEqual(["release:core-repo"]);
    expect(p.actions[2]?.dependsOn).toEqual(["update:lib-repo"]);
    expect(p.actions[2]?.packages[0]).toMatchObject({ name: "@ex/lib", to: "1.1.1", bump: "patch" });
    expect(p.actions.map((a) => a.wave)).toEqual([0, 1, 2]);
  });

  it("does not cascade a breaking adoption in devDependencies", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "2.0.0" } }),
        repo("lib-repo", { "": { name: "@ex/lib", version: "1.1.0", devDependencies: { "@ex/core": "^1.0.0" } } }, {
          resolved: { "": { "@ex/core": "1.0.0" } },
        }),
      ],
      { "@ex/core": npm("2.0.0"), "@ex/lib": npm("1.1.0") },
    );
    expect(p.actions.map((a) => [a.id, a.kind])).toEqual([["update:lib-repo", "adopt-breaking"]]);
  });

  it("makes a peer dependency change a breaking release of the dependent", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "3.0.0" } }),
        repo("plug-repo", { "": { name: "@ex/plug", version: "1.2.0", peerDependencies: { "@ex/core": "^2.0.0" } } }),
      ],
      { "@ex/core": npm("3.0.0"), "@ex/plug": npm("1.2.0") },
    );
    const rel = p.actions.find((a) => a.id === "release:plug-repo");
    expect(rel?.packages[0]).toMatchObject({ to: "2.0.0", bump: "major" });
  });

  it("reports a range that asks for a version that does not exist", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "1.0.0" } }),
        repo("lib-repo", { "": { name: "@ex/lib", version: "1.0.0", dependencies: { "@ex/core": "^2.0.0" } } }),
      ],
      { "@ex/core": npm("1.0.0"), "@ex/lib": npm("1.0.0") },
    );
    expect(p.edges[0]?.status).toBe("blocked");
    expect(p.nodes.find((n) => n.id === "@ex/lib")?.status).toBe("blocked");
  });
});

describe("0.x rules", () => {
  it("treats a new minor before 1.0.0 as breaking", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "0.3.0" } }),
        repo("lib-repo", { "": { name: "@ex/lib", version: "0.4.2", dependencies: { "@ex/core": "^0.2.1" } } }, {
          resolved: { "": { "@ex/core": "0.2.1" } },
        }),
      ],
      { "@ex/core": npm("0.3.0"), "@ex/lib": npm("0.4.2") },
    );
    expect(p.actions.find((a) => a.id === "update:lib-repo")?.kind).toBe("adopt-breaking");
    expect(p.actions.find((a) => a.id === "update:lib-repo")?.items[0]?.newRange).toBe("^0.3.0");
  });

  it("treats a new patch before 1.0.0 as in range", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "0.2.5" } }),
        repo("lib-repo", { "": { name: "@ex/lib", version: "0.4.2", dependencies: { "@ex/core": "^0.2.1" } } }, {
          resolved: { "": { "@ex/core": "0.2.1" } },
        }),
      ],
      { "@ex/core": npm("0.2.5"), "@ex/lib": npm("0.4.2") },
    );
    expect(p.actions.map((a) => [a.id, a.kind])).toEqual([["update:lib-repo", "adopt-in-range"]]);
  });

  it("raises MINOR for a breaking bump before 1.0.0", () => {
    expect(bumpVersion("0.4.2", "major")).toBe("0.5.0");
    expect(bumpVersion("1.4.2", "major")).toBe("2.0.0");
    expect(bumpVersion("0.4.2", "patch")).toBe("0.4.3");
  });

  it("suggests a caret range of the new version", () => {
    expect(suggestRange("~1.2.0", "2.0.0")).toBe("^2.0.0");
    expect(suggestRange("1.2.0", "2.0.0")).toBe("^2.0.0");
    expect(suggestRange(">=1 <2", "2.0.0")).toBe("^2.0.0");
  });
});

describe("release and new package", () => {
  it("plans a release for an unreleased bump and a checklist for a new package", () => {
    const p = run(
      [repo("multi-repo", { "": { name: "multi-monorepo", private: true }, "packages/a": { name: "@ex/a", version: "1.1.0" }, "packages/b": { name: "@ex/b", version: "0.1.0" } })],
      { "@ex/a": npm("1.0.0"), "@ex/b": NONE },
    );
    expect(p.actions.map((a) => a.id)).toEqual(["new:@ex/b", "release:multi-repo"]);
    expect(p.actions[0]?.checklist.join(" ")).toContain("npm-bootstrap.mjs");
    expect(p.nodes.find((n) => n.id === "@ex/b")?.status).toBe("new-package");
    expect(p.nodes.find((n) => n.id === "@ex/a")?.status).toBe("release");
  });

  it("does not adopt a prerelease on main", () => {
    const p = run(
      [
        repo("core-repo", { "": { name: "@ex/core", version: "2.0.0-rc.1" } }),
        repo("lib-repo", { "": { name: "@ex/lib", version: "1.0.0", dependencies: { "@ex/core": "^1.0.0" } } }, {
          resolved: { "": { "@ex/core": "1.9.0" } },
        }),
      ],
      { "@ex/core": npm("1.9.0"), "@ex/lib": npm("1.0.0") },
    );
    expect(p.actions.map((a) => a.id)).toEqual(["release:core-repo"]);
  });
});

describe("graph shapes", () => {
  it("gives a diamond one combined action that waits for both sides", () => {
    // base <- left, right <- top
    const p = run(
      [
        repo("base-repo", { "": { name: "@ex/base", version: "2.0.0" } }),
        repo("left-repo", { "": { name: "@ex/left", version: "1.0.0", dependencies: { "@ex/base": "^1.0.0" } } }, { resolved: { "": { "@ex/base": "1.0.0" } } }),
        repo("right-repo", { "": { name: "@ex/right", version: "1.0.0", dependencies: { "@ex/base": "^1.0.0" } } }, { resolved: { "": { "@ex/base": "1.0.0" } } }),
        repo("top-repo", { "": { name: "top", private: true, dependencies: { "@ex/left": "^1.0.0", "@ex/right": "^1.0.0" } } }, {
          resolved: { "": { "@ex/left": "1.0.0", "@ex/right": "1.0.0" } },
        }),
      ],
      { "@ex/base": npm("1.0.0"), "@ex/left": npm("1.0.0"), "@ex/right": npm("1.0.0") },
    );
    const top = p.actions.filter((a) => a.repo === "top-repo");
    expect(top).toHaveLength(1);
    expect(top[0]?.kind).toBe("adopt-in-range");
    expect(top[0]?.items.map((i) => i.to)).toEqual(["1.0.1", "1.0.1"]);
    expect(top[0]?.dependsOn).toEqual(["release:left-repo", "release:right-repo"]);
    const wave = (id: string) => p.actions.find((a) => a.id === id)?.wave;
    expect(wave("release:base-repo")).toBe(0);
    expect(wave("update:left-repo")).toBe(1);
    expect(wave("release:left-repo")).toBe(2);
    expect(wave("update:top-repo")).toBe(3);
    // Nodes get a level for the layout from left to right.
    const lvl = (id: string) => p.nodes.find((n) => n.id === id)?.level;
    expect([lvl("@ex/base"), lvl("@ex/left"), lvl("top-repo:.")]).toEqual([0, 1, 2]);
  });

  it("reports a cycle between packages", () => {
    const p = run(
      [
        repo("x-repo", { "": { name: "@ex/x", version: "1.0.0", dependencies: { "@ex/y": "^1.0.0" } } }, { resolved: { "": { "@ex/y": "1.0.0" } } }),
        repo("y-repo", { "": { name: "@ex/y", version: "1.0.0", devDependencies: { "@ex/x": "^1.0.0" } } }, { resolved: { "": { "@ex/x": "1.0.0" } } }),
        repo("z-repo", { "": { name: "@ex/z", version: "1.0.0", dependencies: { "@ex/w": "^1.0.0" } } }, { resolved: { "": { "@ex/w": "1.0.0" } } }),
        repo("w-repo", { "": { name: "@ex/w", version: "1.0.0", dependencies: { "@ex/z": "^1.0.0" } } }, { resolved: { "": { "@ex/z": "1.0.0" } } }),
      ],
      { "@ex/x": npm("1.0.0"), "@ex/y": npm("1.0.0"), "@ex/z": npm("1.0.0"), "@ex/w": npm("1.0.0") },
    );
    expect(p.cycles).toHaveLength(2);
    expect(p.cycles).toContainEqual({ packages: ["@ex/x", "@ex/y"], runtime: false });
    expect(p.cycles).toContainEqual({ packages: ["@ex/w", "@ex/z"], runtime: true });
    const lvl = (id: string) => p.nodes.find((n) => n.id === id)?.level;
    expect(lvl("@ex/x")).toBe(lvl("@ex/y"));
  });

  it("reports a cycle of actions and still orders every action", () => {
    const p = run(
      [
        repo("x-repo", { "": { name: "@ex/x", version: "2.0.0", dependencies: { "@ex/y": "^1.0.0" } } }, { resolved: { "": { "@ex/y": "1.0.0" } } }),
        repo("y-repo", { "": { name: "@ex/y", version: "2.0.0", dependencies: { "@ex/x": "^1.0.0" } } }, { resolved: { "": { "@ex/x": "1.0.0" } } }),
      ],
      { "@ex/x": npm("1.0.0"), "@ex/y": npm("1.0.0") },
    );
    expect(p.actionCycles.length).toBeGreaterThan(0);
    expect(p.actions.every((a) => a.order > 0)).toBe(true);
  });

  it("records workspace edges apart and waits for a new package", () => {
    const p = run(
      [
        repo("mono-repo", {
          "": { name: "mono", private: true },
          "packages/core": { name: "@ex/mcore", version: "1.0.0" },
          "packages/fresh": { name: "@ex/fresh", version: "0.1.0" },
          "packages/ui": { name: "@ex/mui", version: "1.0.0", dependencies: { "@ex/mcore": "workspace:*", "@ex/fresh": "workspace:^" } },
        }, { resolved: { "packages/ui": { "@ex/mcore": "link:../core", "@ex/fresh": "link:../fresh" } } }),
      ],
      { "@ex/mcore": npm("1.0.0"), "@ex/mui": npm("1.0.0"), "@ex/fresh": NONE },
    );
    const ws = p.edges.filter((e) => e.kind === "workspace");
    expect(ws).toHaveLength(2);
    expect(ws.every((e) => e.sameRepo && e.resolved === null)).toBe(true);
    expect(ws.find((e) => e.to === "@ex/mcore")?.status).toBe("workspace");
    expect(ws.find((e) => e.to === "@ex/fresh")?.status).toBe("waiting");
  });

  it("flags git specifiers and blocks a release only for runtime sections of a published package", () => {
    const p = run(
      [
        repo("tool-repo", { "": { name: "@ex/tool", version: "1.0.0" } }),
        repo("lib-repo", { "": { name: "@ex/lib", version: "1.1.0", dependencies: { "@ex/tool": "github:example-owner/tool-repo#abc123" } } }),
        repo("dev-repo", { "": { name: "@ex/dev", version: "1.0.0", devDependencies: { "@ex/tool": "github:example-owner/tool-repo" } } }),
      ],
      { "@ex/tool": npm("1.0.0"), "@ex/lib": npm("1.0.0"), "@ex/dev": npm("1.0.0") },
    );
    expect(p.flags).toHaveLength(2);
    expect(p.counts.blockingFlags).toBe(1);
    const rel = p.actions.find((a) => a.id === "release:lib-repo");
    expect(rel?.blocked).toBe(true);
    expect(p.nodes.find((n) => n.id === "@ex/lib")?.status).toBe("blocked");
    expect(p.nodes.find((n) => n.id === "@ex/dev")?.status).toBe("up-to-date");
  });
});

describe("privacy", () => {
  it("removes each private repository from the public output", () => {
    const g = buildGraph({
      owner: "example-owner",
      repos: [
        repo("open-core", { "": { name: "@ex/open", version: "1.1.0" } }),
        repo("secret-repo", { "": { name: "@ex/secret-pkg", version: "1.0.0", dependencies: { "@ex/open": "^1.0.0" } } }, {
          private: true,
          resolved: { "": { "@ex/open": "1.0.0" } },
        }),
        repo("open-app", { "": { name: "open-app", private: true, dependencies: { "@ex/secret-pkg": "^1.0.0", "@ex/open": "^1.0.0" } } }, {
          resolved: { "": { "@ex/secret-pkg": "1.0.0", "@ex/open": "1.0.0" } },
        }),
      ],
      npm: { "@ex/open": npm("1.0.0"), "@ex/secret-pkg": npm("1.0.0") },
      warnings: ["something about secret-repo"],
    });
    const text = JSON.stringify(plan(publicView(g)));
    expect(text).not.toContain("secret");
    expect(text).toContain("open-app");
    // The full plan for the private page still has it.
    expect(JSON.stringify(plan(g))).toContain("secret-repo");
  });
});
