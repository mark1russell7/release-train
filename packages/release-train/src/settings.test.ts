// All repository and package names in these tests are made up.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectUpdates } from "./apply.ts";
import type { RepoUpdate } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { buildGraph } from "./graph.ts";
import { plan } from "./plan.ts";
import { ageRuleEdit, needsAgeRule, ownScopes } from "./settings.ts";
import type { Manifest, RepoSnapshot } from "./types.ts";
import { gitUpdater, releaseAgePolicy } from "./workspace.ts";
import type { RunFn } from "./workspace.ts";

const SCOPES = ["@ex/*", "@tools/*"];

describe("ageRuleEdit", () => {
  it("makes a new file with only the rule", () => {
    const r = ageRuleEdit(null, SCOPES);
    expect(r.changed).toBe(true);
    expect(releaseAgePolicy(r.text, "", "12.0.0").exclude).toEqual(SCOPES);
    expect(r.text.endsWith("\n")).toBe(true);
  });

  it("adds the rule at the end and keeps the other settings", () => {
    const yaml = "packages:\n  - \"packages/*\"\nallowBuilds:\n  esbuild: true\n";
    const r = ageRuleEdit(yaml, SCOPES);
    expect(r.text.startsWith(yaml)).toBe(true);
    expect(releaseAgePolicy(r.text, "", "12.0.0").exclude).toEqual(SCOPES);
  });

  it("removes the entries that the scopes cover, with their stale comment, and keeps the quotes and the line endings", () => {
    const yaml = [
      "packages:",
      "  - a",
      "# pnpm added this entry because the version is new.",
      "minimumReleaseAgeExclude:",
      "  - '@ex/core@1.0.2'",
      "  - '@ex/util@0.2.0'",
      "onlyBuiltDependencies: []",
      "",
    ].join("\r\n");
    const r = ageRuleEdit(yaml, SCOPES);
    expect(r.removed).toEqual(["@ex/core@1.0.2", "@ex/util@0.2.0"]);
    expect(r.text).not.toContain("pnpm added this entry");
    expect(r.text).toContain("  - '@ex/*'\r\n");
    expect(r.text.split("\r\n").join("")).not.toContain("\n");
    expect(r.text).toContain("onlyBuiltDependencies: []");
    expect(releaseAgePolicy(r.text, "", "12.0.0").exclude).toEqual(SCOPES);
  });

  it("keeps a third-party entry and its comment", () => {
    const yaml = 'minimumReleaseAgeExclude:\n  # A fix that we need now.\n  - "third-party@4.5.6"\n  - "@ex/core@1.0.0"\n';
    const r = ageRuleEdit(yaml, SCOPES);
    expect(r.text).toContain("# A fix that we need now.\n  - \"third-party@4.5.6\"");
    expect(releaseAgePolicy(r.text, "", "12.0.0").exclude).toEqual([...SCOPES, "third-party@4.5.6"]);
  });

  it("changes an inline list into a block list", () => {
    const r = ageRuleEdit("minimumReleaseAgeExclude: [other@1.0.0, '@ex/a@2.0.0']\n", SCOPES);
    expect(releaseAgePolicy(r.text, "", "12.0.0").exclude).toEqual([...SCOPES, "other@1.0.0"]);
  });

  it("changes nothing when the rule is there", () => {
    const yaml = 'packages:\n  - a\nminimumReleaseAgeExclude:\n  - "@ex/*"\n  - "@tools/*"\n';
    expect(ageRuleEdit(yaml, SCOPES)).toEqual({ text: yaml, changed: false, removed: [] });
    expect(needsAgeRule({ lockKind: "pnpm", pnpmWorkspace: yaml, packageManager: "pnpm@12.0.0" }, SCOPES)).toBe(false);
  });
});

describe("needsAgeRule", () => {
  it("needs the rule only for pnpm with a release age check", () => {
    expect(needsAgeRule({ lockKind: "pnpm", pnpmWorkspace: null, packageManager: "pnpm@12.1.0" }, SCOPES)).toBe(true);
    expect(needsAgeRule({ lockKind: "pnpm", pnpmWorkspace: null, packageManager: "pnpm@10.4.0" }, SCOPES)).toBe(false);
    expect(needsAgeRule({ lockKind: "pnpm", pnpmWorkspace: "packages:\n  - a\n", packageManager: null }, SCOPES)).toBe(true);
    expect(needsAgeRule({ lockKind: "npm", pnpmWorkspace: null, packageManager: "pnpm@12.0.0" }, SCOPES)).toBe(false);
  });

  it("gives the scopes of the owner", () => {
    expect(ownScopes("someone")).toEqual(["@someone/*", "@procedures/*"]);
  });
});

function snap(name: string, manifests: Record<string, Manifest>, extra: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    name,
    private: false,
    defaultBranch: "main",
    manifests: Object.entries(manifests).map(([path, manifest]) => ({ path, manifest })),
    lockKind: "pnpm",
    resolved: {},
    warnings: [],
    ...extra,
  };
}

describe("selection of the settings", () => {
  const OWNER = "ex";
  const p = plan(
    buildGraph({
      owner: OWNER,
      repos: [
        snap("lib-repo", { "": { name: "@ex/lib", version: "1.0.0" } }, { pnpmWorkspace: null, packageManager: "pnpm@12.0.0" }),
        snap("use-repo", { "": { name: "use", private: true, dependencies: { "@ex/lib": "^1.0.0" } } }, {
          resolved: { "": { "@ex/lib": "0.9.0" } },
          pnpmWorkspace: "packages:\n  - a\n",
        }),
        snap("done-repo", { "": { name: "done", private: true } }, { pnpmWorkspace: 'minimumReleaseAgeExclude:\n  - "@ex/*"\n  - "@procedures/*"\n' }),
      ],
      npm: { "@ex/lib": { exists: true, latest: "1.0.0" } },
      now: new Date("2026-01-01T00:00:00Z"),
    }),
  );

  it("sends the settings alone or in the pull request of the adoption", () => {
    const s = selectUpdates(p);
    const lib = s.ready.find((u) => u.repo === "lib-repo") as RepoUpdate;
    expect([lib.kind, lib.items.length, lib.ageScopes]).toEqual(["settings", 0, ownScopes(OWNER)]);
    const use = s.ready.find((u) => u.repo === "use-repo") as RepoUpdate;
    expect(use.kind).toBe("adopt-in-range");
    expect(use.ageScopes).toEqual(ownScopes(OWNER));
    expect(s.ready.some((u) => u.repo === "done-repo")).toBe(false);
    expect(s.needed.has("lib-repo")).toBe(true);
  });
});

describe("gitUpdater with the settings", () => {
  const base: RepoUpdate = {
    repo: "lib-repo",
    private: false,
    actionId: "settings:lib-repo",
    kind: "settings",
    wave: 0,
    why: "test",
    lockKind: "pnpm",
    items: [],
    ageScopes: SCOPES,
    fingerprint: "x",
  };

  it("writes a new pnpm-workspace.yaml, adds it to git and pushes", async () => {
    const cmds: string[] = [];
    let written = "";
    const run: RunFn = async (cmd, args, opts) => {
      cmds.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args.includes("commit")) written = readFileSync(join(opts.cwd, "pnpm-workspace.yaml"), "utf8");
      const out = cmd === "pnpm" && args[0] === "--version" ? "12.0.0\n" : cmd === "git" && args[0] === "status" ? "?? pnpm-workspace.yaml\n" : "";
      return { code: cmd === "git" && args[0] === "fetch" ? 1 : 0, stdout: out, stderr: "" };
    };
    const up = gitUpdater({ owner: "ex", token: "t", author: { name: "a", email: "a@b" }, run, fetch: async () => new Response("{}") });
    const r = await up.update(base, { defaultBranch: "main", rebuild: false });
    expect(r.status).toBe("pushed");
    expect(cmds).toContain("git add -- pnpm-workspace.yaml");
    expect(releaseAgePolicy(written, "", "12.0.0").exclude).toEqual(SCOPES);
    expect(cmds.some((c) => c.startsWith("git -c") && c.includes("chore(pnpm)"))).toBe(true);
  });

  it("does not wait for a young version that the new rule covers", async () => {
    const cmds: string[] = [];
    const run: RunFn = async (cmd, args, opts) => {
      cmds.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "clone") {
        writeFileSync(join(opts.cwd, "package.json"), `${JSON.stringify({ name: "x", dependencies: { "@ex/core": "^1.0.0", other: "^1.0.0" } })}\n`);
        writeFileSync(join(opts.cwd, "pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - '@ex/core@1.9.0'\n");
      }
      const out = cmd === "pnpm" && args[0] === "--version" ? "12.0.0\n" : cmd === "git" && args[0] === "status" ? " M pnpm-workspace.yaml\n" : "";
      return { code: 0, stdout: out, stderr: "" };
    };
    const young: FetchFn = async () => new Response(JSON.stringify({ time: { "2.0.0": "2026-01-01T12:00:00.000Z" } }), { status: 200 });
    const up = gitUpdater({ owner: "ex", token: "t", author: { name: "a", email: "a@b" }, run, fetch: young, now: () => Date.parse("2026-01-01T13:00:00.000Z") });
    const item = (dep: string) => ({ path: "", dependent: "x", dep, type: "dependencies" as const, range: "^1.0.0", newRange: "^2.0.0", from: "1.0.0", to: "2.0.0", why: "w" });
    const r = await up.update({ ...base, kind: "adopt-breaking", items: [item("@ex/core"), item("other")] }, { defaultBranch: "main", rebuild: false });
    expect(r.young.map((y) => y.dep)).toEqual(["other"]);
    expect(r.status).not.toBe("young");
    expect(cmds.filter((c) => c.startsWith("pnpm install")).length).toBe(3);
  });
});

