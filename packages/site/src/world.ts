/**
 * The sample world of the plan explorer: a made-up owner `acme` with eight packages in seven repositories.
 * The explorer changes this world and gives it to the real planner of the library (`buildGraph`, then `plan`).
 */

import { buildGraph } from "@release-train/release-train/src/graph.ts";
import { bumpVersion, RELEASE_WORKFLOW, plan } from "@release-train/release-train/src/plan.ts";
import type { Bump, Plan } from "@release-train/release-train/src/plan.ts";
import type { DepType, Manifest, NpmInfo, RepoSnapshot } from "@release-train/release-train/src/types.ts";

/** The owner of the sample packages. */
export const OWNER = "acme";

/** One dependency of a sample package on another sample package. */
export interface SampleDep {
  name: string;
  type: DepType;
  spec: string;
  /** The version in the lockfile of the dependent, or null for a workspace link. */
  locked: string | null;
}

/** One `package.json` of the sample world. */
export interface SamplePackage {
  name: string;
  repo: string;
  path: string;
  /** The latest version on npm, or null when the package is not on npm. */
  npm: string | null;
  /** This value is true for an app: a private `package.json` that only uses the packages. */
  app: boolean;
  role: string;
  deps: SampleDep[];
}

/** The sample world: each package and app, with its dependencies and its lockfile. */
export const SAMPLE: readonly SamplePackage[] = [
  { name: "@acme/units", repo: "units", path: "", npm: "1.4.0", app: false, role: "amounts with units", deps: [] },
  { name: "@acme/theme", repo: "theme", path: "", npm: "1.0.3", app: false, role: "colors and fonts", deps: [] },
  {
    name: "@acme/grid",
    repo: "grid",
    path: "",
    npm: "0.6.2",
    app: false,
    role: "a data grid",
    deps: [{ name: "@acme/units", type: "dependencies", spec: "^1.4.0", locked: "1.4.0" }],
  },
  {
    name: "@acme/kit-core",
    repo: "kit",
    path: "packages/core",
    npm: "2.3.1",
    app: false,
    role: "the core of a UI kit",
    deps: [{ name: "@acme/units", type: "dependencies", spec: "^1.2.0", locked: "1.4.0" }],
  },
  {
    name: "@acme/kit-react",
    repo: "kit",
    path: "packages/react",
    npm: null,
    app: false,
    role: "React parts of the UI kit",
    deps: [
      { name: "@acme/kit-core", type: "dependencies", spec: "workspace:*", locked: null },
      { name: "@acme/theme", type: "peerDependencies", spec: "^1.0.0", locked: "1.0.3" },
    ],
  },
  {
    name: "@acme/chart",
    repo: "chart",
    path: "",
    npm: "2.1.0",
    app: false,
    role: "charts on the grid",
    deps: [
      { name: "@acme/grid", type: "dependencies", spec: "^0.6.0", locked: "0.6.2" },
      { name: "@acme/units", type: "dependencies", spec: "^1.2.0", locked: "1.4.0" },
      { name: "@acme/theme", type: "peerDependencies", spec: "^1.0.0", locked: "1.0.2" },
    ],
  },
  {
    name: "@acme/cli",
    repo: "cli",
    path: "",
    npm: "3.2.1",
    app: false,
    role: "a command-line tool",
    deps: [
      { name: "@acme/units", type: "dependencies", spec: "^1.0.0", locked: "1.4.0" },
      { name: "@acme/theme", type: "devDependencies", spec: "^1.0.0", locked: "1.0.3" },
    ],
  },
  {
    name: "dashboard",
    repo: "dashboard",
    path: "",
    npm: null,
    app: true,
    role: "a web app",
    deps: [
      { name: "@acme/chart", type: "dependencies", spec: "^2.1.0", locked: "2.1.0" },
      { name: "@acme/grid", type: "dependencies", spec: "^0.6.0", locked: "0.6.1" },
    ],
  },
];

/** The changes that a visitor makes to the sample world. */
export interface Choices {
  /** The version bump on `main` of each package, as a person merges it. A missing key is no bump. */
  bumps: Record<string, Bump>;
  /** The packages whose latest npm version has no provenance from their own `release.yml`. */
  noProvenance: string[];
  /** The dependencies that use a `github:` specifier, as `<dependent> uses <dependency>`. */
  git: string[];
}

/** This function gives the key of one dependency in `Choices.git`. */
export function depKey(dependent: string, dependency: string): string {
  return `${dependent} uses ${dependency}`;
}

/** This function gives choices with no change. */
export function noChoices(): Choices {
  return { bumps: {}, noProvenance: [], git: [] };
}

/** A ready set of choices that shows one case of the planner. */
export interface Scenario {
  id: string;
  label: string;
  hint: string;
  choices: () => Choices;
}

/** The scenarios of the explorer. The first one is the start state of the page. */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: "major",
    label: "A major release",
    hint: "@acme/units 2.0.0 breaks the API. Each dependent changes its range and releases again.",
    choices: () => ({ ...noChoices(), bumps: { "@acme/units": "major" } }),
  },
  {
    id: "peer",
    label: "A peer range",
    hint: "@acme/theme 2.0.0 is outside a peer range, so @acme/chart needs a major release too.",
    choices: () => ({ ...noChoices(), bumps: { "@acme/theme": "major" } }),
  },
  {
    id: "provenance",
    label: "No provenance",
    hint: "npm has @acme/theme 1.0.3 with no provenance. The train does not move a lockfile to it.",
    choices: () => ({ ...noChoices(), noProvenance: ["@acme/theme"] }),
  },
  {
    id: "git",
    label: "A git dependency",
    hint: "@acme/cli has a github: specifier in its dependencies, so its release is blocked.",
    choices: () => ({ ...noChoices(), bumps: { "@acme/cli": "patch" }, git: [depKey("@acme/cli", "@acme/units")] }),
  },
  {
    id: "none",
    label: "No bump",
    hint: "Only the two old lockfiles change. Each update is in range.",
    choices: noChoices,
  },
];

/** This function gives the version on `main` of a package after the choices. */
export function mainVersion(p: SamplePackage, c: Choices): string {
  const base = p.npm ?? (p.app ? "0.0.0" : "0.1.0");
  const bump = c.bumps[p.name];
  return bump && p.npm ? bumpVersion(p.npm, bump) : base;
}

/** This function makes the repository data and the npm data of the sample world after the choices. */
export function snapshot(c: Choices): { repos: RepoSnapshot[]; npm: Record<string, NpmInfo> } {
  const repos = new Map<string, RepoSnapshot>();
  const npm: Record<string, NpmInfo> = {};
  for (const p of SAMPLE) {
    const repo = repos.get(p.repo) ?? {
      name: p.repo,
      private: false,
      defaultBranch: "main",
      manifests: [],
      lockKind: "pnpm",
      resolved: {},
      warnings: [],
      pnpmWorkspace: null,
      packageManager: "pnpm@10.0.0",
    };
    repos.set(p.repo, repo);
    const manifest: Manifest = { name: p.name, version: mainVersion(p, c) };
    if (p.app) manifest.private = true;
    const locked: Record<string, string> = {};
    for (const d of p.deps) {
      const git = c.git.includes(depKey(p.name, d.name));
      const section = (manifest[d.type] ??= {});
      section[d.name] = git ? `github:${OWNER}/${SAMPLE.find((s) => s.name === d.name)?.repo ?? d.name}#main` : d.spec;
      if (d.locked && !git) locked[d.name] = d.locked;
    }
    repo.manifests.push({ path: p.path, manifest });
    repo.resolved[p.path] = locked;
    if (!p.app) {
      npm[p.name] = p.npm
        ? {
            exists: true,
            latest: p.npm,
            provenance: c.noProvenance.includes(p.name) ? null : { repository: `https://github.com/${OWNER}/${p.repo}`, workflow: RELEASE_WORKFLOW },
          }
        : { exists: false, latest: null };
    }
  }
  return { repos: [...repos.values()], npm };
}

/** This function starts the planner of the library on the sample world after the choices, and gives the plan. */
export function planFor(c: Choices, now: Date = new Date(0)): Plan {
  const { repos, npm } = snapshot(c);
  return plan(buildGraph({ owner: OWNER, repos, npm, now }));
}

/** This function gives the short name of a package: its name with no scope. */
export function short(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}
