import semver from "semver";
import type { DepType, Edge, Graph, Importer, PackageNode, RepoInfo } from "./types.ts";

/** The kinds of the actions of a plan. */
export type ActionKind = "new-package" | "release" | "adopt-breaking" | "adopt-in-range";

/** The state of one dependency edge. */
export type EdgeStatus =
  | "current"
  | "adopt"
  | "breaking"
  | "waiting"
  | "workspace"
  | "blocked"
  | "flagged"
  | "unlocked";

/** The state of one node, from the most urgent to the least urgent. */
export type NodeStatus = "blocked" | "new-package" | "release" | "breaking" | "adopt" | "up-to-date";

/** The size of a version change. */
export type Bump = "patch" | "minor" | "major";

/** A dependency edge with its state in the plan. */
export interface EdgeState extends Edge {
  status: EdgeStatus;
  /** The newest version that the dependent can use, after the actions of the plan. */
  target: string | null;
  why: string;
  /** The action that changes this edge, if one changes it. */
  action: string | null;
}

/** A node of the plan: a package of the owner, or an app (a private `package.json` with dependencies on the owner). */
export interface NodeState {
  id: string;
  kind: "package" | "app";
  name: string;
  repo: string;
  path: string;
  repoPrivate: boolean;
  version: string | null;
  npmLatest: string | null;
  onNpm: boolean;
  /** The version that the plan publishes next, if it publishes one. */
  next: string | null;
  status: NodeStatus;
  why: string;
  actions: string[];
  dependents: string[];
  /** The ids of the nodes that this node depends on. */
  dependsOn: string[];
  /** The topological level: 0 for a node with no dependency on the owner, else one more than its deepest dependency. */
  level: number;
}

/** One dependency change of an adopt action. */
export interface ActionItem {
  importer: string;
  path: string;
  dependent: string | null;
  dep: string;
  type: DepType;
  range: string;
  resolved: string | null;
  to: string;
  newRange: string | null;
  why: string;
}

/** One package of a release action or a new-package action. */
export interface ActionPackage {
  name: string;
  path: string;
  from: string | null;
  to: string | null;
  bump: Bump | null;
  why: string;
}

/** One step of the plan. Each repository gets at most one release action and one adopt action. */
export interface Action {
  id: string;
  kind: ActionKind;
  repo: string;
  repoPrivate: boolean;
  packages: ActionPackage[];
  items: ActionItem[];
  dependsOn: string[];
  wave: number;
  order: number;
  blocked: boolean;
  blockers: string[];
  inCycle: boolean;
  why: string;
  checklist: string[];
}

/** A dependency cycle between packages. */
export interface Cycle {
  packages: string[];
  /** This value is true when the cycle stays without the `devDependencies` edges. */
  runtime: boolean;
}

/**
 * A version that is not free. It is a version on `main` that npm has already, or a version of an open pull request.
 * That version is on `main` or npm already, or another open pull request sets it too.
 * The plan blocks a release of a taken version on `main`.
 */
export interface TakenVersion {
  name: string;
  repo: string;
  version: string;
  why: string;
  /** The open pull requests that set this version. Empty: the version is on main. */
  pulls: number[];
}

/** A published package whose range on npm does not cover the next version of a package of its own repository. */
export interface BehindRange {
  name: string;
  repo: string;
  dep: string;
  /** The range of `dep` in the latest version of `name` on npm. */
  range: string;
  /** The next version of `dep`. */
  version: string;
}

/** The plan: the actions in order and the state of each node and edge. */
export interface Plan {
  owner: string;
  generatedAt: string;
  counts: {
    actions: Record<ActionKind, number>;
    nodes: Record<NodeStatus, number>;
    packages: number;
    repos: number;
    edges: number;
    flags: number;
    blockingFlags: number;
    /** The count of the versions that are not free, on main and in the open pull requests. The gate keeps it at 0. */
    taken: number;
    /** The count of the published workspace ranges that do not cover the next version. Each gets a cascade release. */
    behind: number;
  };
  actions: Action[];
  nodes: NodeState[];
  edges: EdgeState[];
  cycles: Cycle[];
  actionCycles: string[][];
  flags: EdgeState[];
  /** The versions that are not free, on main and in the open pull requests. */
  taken: TakenVersion[];
  /** The published workspace ranges that do not cover the next version. The plan gives each dependent a cascade release. */
  behind: BehindRange[];
  repos: RepoInfo[];
  reposWithoutPnpmLock: string[];
  warnings: string[];
}

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };
const KIND_ORDER: Record<ActionKind, number> = { "new-package": 0, release: 1, "adopt-breaking": 2, "adopt-in-range": 3 };
const STATUS_ORDER: readonly NodeStatus[] = ["blocked", "new-package", "release", "breaking", "adopt", "up-to-date"];

/** The workflow file that releases a package of the owner. */
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

function valid(v: string | null | undefined): string | null {
  return v ? semver.valid(v) : null;
}

function isStable(v: string | null): v is string {
  return v !== null && semver.prerelease(v) === null;
}

/** This function gives the release type of a bump. Before `1.0.0`, a breaking change increases MINOR. */
export function bumpVersion(version: string, bump: Bump): string {
  const major = semver.major(version);
  const kind = bump === "major" && major === 0 ? "minor" : bump;
  return semver.inc(version, kind) ?? version;
}

/** This function gives the new range for a breaking adoption: a caret range of the new version, the standard of the owner. */
export function suggestRange(_oldRange: string, to: string): string {
  return `^${to}`;
}

function isRuntime(t: DepType): boolean {
  return t !== "devDependencies";
}

/** This function finds the strongly connected components of a directed graph (Tarjan). */
export function stronglyConnected(nodes: readonly string[], next: (n: string) => readonly string[]): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of next(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp.sort());
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return out;
}

/** This function sets the topological level of each node. The nodes of one cycle get the same level. */
export function assignLevels(nodes: NodeState[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const next = (id: string): string[] => (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
  const comps = stronglyConnected([...byId.keys()].sort(), next);
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => c.forEach((id) => compOf.set(id, i)));
  // Tarjan gives each component after the components that it depends on.
  const level: number[] = [];
  comps.forEach((c, i) => {
    let l = 0;
    for (const id of c) for (const d of next(id)) if (compOf.get(d) !== i) l = Math.max(l, (level[compOf.get(d) as number] ?? 0) + 1);
    level[i] = l;
  });
  for (const n of nodes) n.level = level[compOf.get(n.id) as number] ?? 0;
}

/** This function gives the text of an adoption of the given items. */
export function adoptWhy(repo: string, items: readonly Pick<ActionItem, "dep" | "newRange">[]): string {
  const deps = [...new Set(items.map((i) => i.dep))];
  const lead = items.some((i) => i.newRange) ? "Change the ranges" : "Update the lockfile";
  return `${lead} of ${repo} for ${deps.length === 1 ? deps[0] : `${deps.length} packages`}, then merge when CI is green.`;
}

/**
 * This function gives each package the number of its set. The packages of one set move together in a repository.
 * A peer range joins two packages. A runtime `workspace:` range also joins them, because npm gets an exact version of it.
 * So a user with two versions of the hub of a set gets two copies. Only published packages join a set.
 */
export function moveSets(packages: readonly string[], edges: readonly Pick<Edge, "fromName" | "to" | "type" | "kind">[]): Map<string, number> {
  const near = new Map<string, string[]>(packages.map((n) => [n, []]));
  for (const e of edges) {
    const from = e.fromName === null ? undefined : near.get(e.fromName);
    const to = near.get(e.to);
    if (!from || !to || (e.type !== "peerDependencies" && !(e.kind === "workspace" && isRuntime(e.type)))) continue;
    from.push(e.to);
    to.push(e.fromName as string);
  }
  // Each edge goes in the two directions here, so a strongly connected component is a connected component.
  const sets = new Map<string, number>();
  stronglyConnected(packages, (n) => near.get(n) ?? []).forEach((c, i) => c.forEach((n) => sets.set(n, i)));
  return sets;
}

/** This function computes the plan from the graph. It keeps no state between runs. */
export function plan(g: Graph): Plan {
  const warnings = [...g.warnings];
  const pkgs = new Map(g.packages.map((p) => [p.name, p]));
  const importers = new Map(g.importers.map((i) => [i.id, i]));
  const repoInfo = new Map(g.repos.map((r) => [r.name, r]));
  const pkgOfImporter = (imp: Importer | undefined): PackageNode | undefined =>
    imp?.published && imp.name ? (pkgs.get(imp.name)?.repo === imp.repo ? pkgs.get(imp.name) : undefined) : undefined;

  // The train moves a repository only to a version that the release workflow of its own repository built. A version from
  // another build can come from a stolen token, and pnpm does not check our scopes (trustPolicyExclude, minimumReleaseAgeExclude).
  const untrusted = (p: PackageNode, t: string): string | null => {
    if (t !== valid(p.npm.latest) || p.npm.provenance === undefined) return null;
    const want = `https://github.com/${g.owner}/${p.repo}`;
    const prov = p.npm.provenance;
    const check = "A person checks the publish on npm, then releases a new version from release.yml.";
    if (prov === null) return `${p.name}@${t} has no provenance on npm, so the release train does not move a repository to it. ${check}`;
    if (prov.repository.toLowerCase() !== want.toLowerCase() || prov.workflow !== RELEASE_WORKFLOW) {
      return `${p.name}@${t} was built by ${prov.workflow} of ${prov.repository}, not by ${RELEASE_WORKFLOW} of ${want}. ${check}`;
    }
    return null;
  };

  // 1. The own state of each package.
  const target = new Map<string, string | null>();
  const publishBy = new Map<string, string>();
  const pendingBump = new Set<string>();
  const taken = new Map<string, TakenVersion>();
  for (const p of g.packages) {
    const main = valid(p.version);
    const latest = valid(p.npm.latest);
    if (p.version && !main) warnings.push(`The version "${p.version}" of ${p.name} is not SemVer.`);
    if (!p.npm.exists) {
      target.set(p.name, main);
      publishBy.set(p.name, `new:${p.name}`);
    } else if (main && latest && semver.gt(main, latest)) {
      pendingBump.add(p.name);
      if (p.npm.versions?.includes(main)) {
        const why = `npm has ${p.name}@${main} already, under a tag that is not latest. The release fails at the publish. Set the next free version on main.`;
        taken.set(p.name, { name: p.name, repo: p.repo, version: main, why, pulls: [] });
      }
      publishBy.set(p.name, `release:${p.repo}`);
      target.set(p.name, isStable(main) ? main : latest);
    } else {
      if (main && latest && semver.lt(main, latest)) {
        warnings.push(`main of ${p.repo} has ${p.name}@${main}, but npm has ${latest}.`);
      }
      target.set(p.name, latest ?? main);
    }
  }

  // 1b. The versions of the open pull requests. A version must be new, and only one pull request can set it.
  const clashes: TakenVersion[] = [];
  const setBy = new Map<string, Map<string, number[]>>();
  for (const pr of g.pulls ?? []) {
    const v = valid(pr.version);
    if (!v) continue;
    const id = `${pr.repo}:${pr.path || "."}`;
    const versions = setBy.get(id) ?? new Map<string, number[]>();
    versions.set(v, [...new Set([...(versions.get(v) ?? []), pr.number])].sort((x, y) => x - y));
    setBy.set(id, versions);
  }
  for (const [id, versions] of setBy) {
    const imp = importers.get(id);
    if (!imp?.name) continue;
    const main = valid(imp.version);
    const own = pkgOfImporter(imp);
    for (const [v, numbers] of versions) {
      const why: string[] = [];
      if (numbers.length > 1) why.push(`The pull requests ${numbers.map((n) => `#${n}`).join(", ")} all set ${v}.`);
      if (main && !semver.gt(v, main)) why.push(`main has ${main}, so ${v} is not new.`);
      if (own?.npm.versions?.includes(v)) why.push(`npm has ${imp.name}@${v} already.`);
      if (why.length > 0) clashes.push({ name: imp.name, repo: imp.repo, version: v, pulls: numbers, why: `${why.join(" ")} Set the next free version before the merge.` });
    }
  }

  // 2. The cascade: a breaking adoption in a runtime section of a published dependent makes it release.
  const cascade = new Map<string, Bump>();
  const behind = new Map<string, BehindRange>();
  const outside = (t: string | null, range: string | null): boolean =>
    Boolean(t && range && semver.validRange(range) && !semver.satisfies(t, range) && semver.gtr(t, range));
  for (let round = 0; round <= g.packages.length + 1; round++) {
    let changed = false;
    for (const [name, b] of cascade) {
      const p = pkgs.get(name) as PackageNode;
      if (pendingBump.has(name) || !p.npm.exists) continue;
      const from = valid(p.npm.latest) ?? valid(p.version);
      if (!from) continue;
      // The train sets this number, so it takes the first free one. npm can have a newer version under another tag.
      let to = bumpVersion(from, b);
      while (p.npm.versions?.includes(to)) to = bumpVersion(to, "patch");
      target.set(name, to);
      publishBy.set(name, `release:${p.repo}`);
    }
    for (const e of g.edges) {
      if ((e.kind !== "registry" && e.kind !== "workspace") || !isRuntime(e.type)) continue;
      const dep = pkgOfImporter(importers.get(e.from));
      // A workspace range has its real range only on npm: pnpm wrote it at the last publish of the dependent.
      const range = e.kind === "workspace" ? (dep?.npm.latestDeps?.[e.type]?.[e.to] ?? null) : e.range;
      if (!dep || !outside(target.get(e.to) ?? null, range)) continue;
      if (e.kind === "workspace") {
        behind.set(`${dep.name} ${e.to}`, { name: dep.name, repo: dep.repo, dep: e.to, range: range as string, version: target.get(e.to) as string });
      }
      const need: Bump = e.type === "peerDependencies" ? "major" : "patch";
      const have = cascade.get(dep.name);
      if (have === undefined || RANK[need] > RANK[have]) {
        cascade.set(dep.name, need);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 3. The state of each edge.
  const edges: EdgeState[] = g.edges.map((e) => {
    const imp = importers.get(e.from) as Importer;
    const p = pkgs.get(e.to) as PackageNode;
    const t = target.get(e.to) ?? null;
    const latest = valid(p.npm.latest);
    const unpublished = t !== null && (latest === null || semver.gt(t, latest));
    const st = (status: EdgeStatus, why: string): EdgeState => ({ ...e, status, target: t, why, action: null });
    if (e.kind === "workspace") {
      if (imp.published && isRuntime(e.type) && !p.npm.exists) {
        return st("waiting", `${e.to} is not on npm yet. The release of ${imp.name ?? imp.id} needs it there first.`);
      }
      return st("workspace", "Both packages are in the same repository. pnpm links them.");
    }
    if (e.kind === "github" || e.kind === "git" || e.kind === "file" || e.kind === "link" || e.kind === "tarball") {
      const label = e.kind === "github" || e.kind === "git" ? "git" : e.kind;
      if (e.blocking) {
        return st("blocked", `A ${label} specifier ("${e.spec}") in ${e.type} of a published package. npm users cannot install it, so it blocks the release.`);
      }
      return st("flagged", `A ${label} specifier ("${e.spec}") in ${e.type}. It does not block a release, but Renovate and the release train cannot move it.`);
    }
    if (e.kind === "tag") {
      if (e.range === "latest") return st("current", "The dist-tag latest always gives the newest version.");
      return st("flagged", `The dist-tag "${e.range}" is not a range. The release train does not move it.`);
    }
    if (!t) return st("waiting", `${e.to} has no version on npm or on main.`);
    const range = e.range ?? "*";
    if (!semver.validRange(range)) return st("flagged", `"${range}" is not a valid SemVer range.`);
    const hold = untrusted(p, t);
    if (semver.satisfies(t, range)) {
      const lock = repoInfo.get(imp.repo)?.lockKind ?? "none";
      if (lock === "none" || lock === "yarn") {
        return st("unlocked", `The range ${range} allows ${t}. The repository has no lockfile that the release train reads, so a new install gets it.`);
      }
      if (hold && (e.resolved === null || (valid(e.resolved) !== null && semver.lt(valid(e.resolved) as string, t)))) return st("waiting", hold);
      if (e.resolved === null) {
        return st("adopt", `The range ${range} allows ${t}, but the lockfile has no entry for it. A lockfile update fixes this.`);
      }
      const r = valid(e.resolved);
      if (r && semver.lt(r, t)) {
        return st("adopt", `The range ${range} allows ${t}, but the lockfile holds ${r}. Only a lockfile update and CI are necessary.`);
      }
      return st("current", `The lockfile holds ${e.resolved}, the newest version.`);
    }
    if (hold && semver.gtr(t, range)) return st("waiting", hold);
    if (semver.gtr(t, range)) {
      const pub = imp.published && isRuntime(e.type);
      return st(
        "breaking",
        `${t} is outside the range ${range}. The range must change${pub ? `, and ${imp.name} must then release` : ""}.${unpublished ? ` ${t} is not on npm yet.` : ""}`,
      );
    }
    return st("blocked", `The range ${range} asks for a version that is newer than npm (${latest ?? "none"}) and main (${p.version ?? "none"}).`);
  });

  // 4. The actions.
  const actions = new Map<string, Action>();
  const newAction = (id: string, kind: ActionKind, repo: string, why: string): Action => {
    const a: Action = {
      id,
      kind,
      repo,
      repoPrivate: repoInfo.get(repo)?.private ?? false,
      packages: [],
      items: [],
      dependsOn: [],
      wave: 0,
      order: 0,
      blocked: false,
      blockers: [],
      inCycle: false,
      why,
      checklist: [],
    };
    actions.set(id, a);
    return a;
  };
  const addDep = (a: Action, dep: string | undefined): void => {
    if (dep && dep !== a.id && !a.dependsOn.includes(dep)) a.dependsOn.push(dep);
  };

  for (const p of g.packages) {
    if (p.npm.exists) continue;
    const a = newAction(`new:${p.name}`, "new-package", p.repo, `${p.name} is not on npm. Only Mark can make a new package.`);
    a.packages.push({ name: p.name, path: p.path, from: null, to: valid(p.version), bump: null, why: "The first release." });
    a.checklist.push(
      `Merge the version ${p.version ?? "?"} of ${p.name} to main of ${p.repo}.`,
      `In a checkout of the template, run "node scripts/release/npm-bootstrap.ts <folder of ${p.repo}> --dispatch" (Mark only, fewer than 25 new packages a day).`,
    );
  }
  for (const p of g.packages) {
    const pending = pendingBump.has(p.name);
    const bump = cascade.get(p.name);
    if (!p.npm.exists || (!pending && bump === undefined)) continue;
    const id = `release:${p.repo}`;
    const a = actions.get(id) ?? newAction(id, "release", p.repo, "");
    const to = pending ? valid(p.version) : (target.get(p.name) ?? null);
    const why = pending
      ? `main has ${p.version}, npm has ${p.npm.latest}. The bump is not released.`
      : `A dependency of ${p.name} changes its range, so users need a new version (at least a ${bump === "major" ? "breaking" : "patch"} release).`;
    a.packages.push({ name: p.name, path: p.path, from: p.npm.latest, to, bump: pending ? null : (bump ?? null), why });
    const t = taken.get(p.name);
    if (t) {
      a.blocked = true;
      a.blockers.push(`${p.name}: ${t.why}`);
    }
  }
  for (const a of actions.values()) {
    if (a.kind !== "release") continue;
    const n = a.packages.length;
    a.why = `Release ${n === 1 ? (a.packages[0]?.name ?? "") : `${n} packages`} of ${a.repo} to npm: merge the version bump to main.`;
  }

  for (const e of edges) {
    if (e.status !== "adopt" && e.status !== "breaking") continue;
    const imp = importers.get(e.from) as Importer;
    const id = `update:${imp.repo}`;
    const a = actions.get(id) ?? newAction(id, "adopt-in-range", imp.repo, "");
    if (e.status === "breaking") a.kind = "adopt-breaking";
    const to = e.target as string;
    a.items.push({
      importer: e.from,
      path: imp.path,
      dependent: imp.name,
      dep: e.to,
      type: e.type,
      range: e.range ?? "*",
      resolved: e.resolved,
      to,
      newRange: e.status === "breaking" ? suggestRange(e.range ?? "^0.0.0", to) : null,
      why: e.why,
    });
    e.action = id;
    const p = pkgs.get(e.to) as PackageNode;
    const latest = valid(p.npm.latest);
    if (latest === null || semver.gt(to, latest)) addDep(a, publishBy.get(e.to));
  }
  for (const a of actions.values()) {
    if (a.kind !== "adopt-breaking" && a.kind !== "adopt-in-range") continue;
    a.why = adoptWhy(a.repo, a.items);
  }

  // A release or a new package waits for the adoption in its repository and for its runtime dependencies on npm.
  for (const a of actions.values()) {
    if (a.kind !== "release" && a.kind !== "new-package") continue;
    const names = new Set(a.packages.map((p) => p.name));
    const upd = actions.get(`update:${a.repo}`);
    if (upd?.items.some((i) => i.dependent && names.has(i.dependent))) addDep(a, upd.id);
    for (const e of edges) {
      const imp = importers.get(e.from) as Importer;
      if (imp.repo !== a.repo || !imp.name || !names.has(imp.name) || !isRuntime(e.type)) continue;
      if (e.status === "waiting" && publishBy.has(e.to)) addDep(a, publishBy.get(e.to));
      if (e.status === "blocked") {
        a.blocked = true;
        a.blockers.push(`${imp.name} → ${e.to}: ${e.why}`);
      }
    }
  }

  // 5. The sequence: waves of a topological sort over the components of the action graph.
  const ids = [...actions.keys()].sort();
  const next = (id: string): string[] => (actions.get(id) as Action).dependsOn.filter((d) => actions.has(d));
  const comps = stronglyConnected(ids, next);
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => c.forEach((id) => compOf.set(id, i)));
  const actionCycles = comps.filter((c) => c.length > 1);
  for (const c of actionCycles) for (const id of c) (actions.get(id) as Action).inCycle = true;
  for (const a of actions.values()) a.dependsOn = a.dependsOn.filter((d) => actions.has(d)).sort();
  const waveOf = new Map<number, number>();
  const compWave = (ci: number, seen: Set<number>): number => {
    const known = waveOf.get(ci);
    if (known !== undefined) return known;
    seen.add(ci);
    let w = 0;
    for (const id of comps[ci] as string[]) {
      for (const d of next(id)) {
        const dc = compOf.get(d) as number;
        if (dc !== ci && !seen.has(dc)) w = Math.max(w, compWave(dc, seen) + 1);
      }
    }
    seen.delete(ci);
    waveOf.set(ci, w);
    return w;
  };
  for (const a of actions.values()) a.wave = compWave(compOf.get(a.id) as number, new Set());
  const ordered = [...actions.values()].sort(
    (x, y) => x.wave - y.wave || Number(x.blocked) - Number(y.blocked) || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.id.localeCompare(y.id),
  );
  ordered.forEach((a, i) => (a.order = i + 1));

  // 6. The cycles between packages.
  const pkgNames = g.packages.map((p) => p.name);
  const pkgNext = (runtimeOnly: boolean) => (n: string): string[] => {
    const p = pkgs.get(n) as PackageNode;
    const from = `${p.repo}:${p.path || "."}`;
    return g.edges.filter((e) => e.from === from && (!runtimeOnly || isRuntime(e.type))).map((e) => e.to);
  };
  const runtimeComps = stronglyConnected(pkgNames, pkgNext(true)).filter((c) => c.length > 1);
  const cycles: Cycle[] = stronglyConnected(pkgNames, pkgNext(false))
    .filter((c) => c.length > 1)
    .map((c) => ({ packages: c, runtime: runtimeComps.some((r) => r.some((n) => c.includes(n))) }));

  // 7. The nodes.
  const dependents = new Map<string, Set<string>>();
  for (const e of edges) {
    const imp = importers.get(e.from) as Importer;
    const src = pkgOfImporter(imp)?.name ?? imp.id;
    const set = dependents.get(e.to) ?? new Set<string>();
    set.add(src);
    dependents.set(e.to, set);
  }
  const edgesFrom = new Map<string, EdgeState[]>();
  for (const e of edges) edgesFrom.set(e.from, [...(edgesFrom.get(e.from) ?? []), e]);
  const actionsOf = (repo: string, name: string | null, importer: string): string[] =>
    ordered
      .filter(
        (a) =>
          a.repo === repo &&
          (a.packages.some((p) => p.name === name) || a.items.some((i) => i.importer === importer)),
      )
      .map((a) => a.id);

  const nodes: NodeState[] = [];
  const nodeStatus = (out: EdgeState[], p: PackageNode | null): [NodeStatus, string] => {
    const blocked = out.filter((e) => e.status === "blocked" && (p ? isRuntime(e.type) : true));
    if (blocked.length > 0) return ["blocked", blocked.map((e) => e.why).join(" ")];
    const t = p ? taken.get(p.name) : undefined;
    if (t) return ["blocked", t.why];
    if (p && !p.npm.exists) return ["new-package", `${p.name} is not on npm yet. Mark must make it one time.`];
    if (p && (pendingBump.has(p.name) || cascade.has(p.name))) {
      return ["release", pendingBump.has(p.name) ? `main has ${p.version}, npm has ${p.npm.latest}.` : `It needs a new release after a dependency range change.`];
    }
    const br = out.filter((e) => e.status === "breaking");
    if (br.length > 0) return ["breaking", `A new major version of ${[...new Set(br.map((e) => e.to))].join(", ")} needs a range change.`];
    const ad = out.filter((e) => e.status === "adopt");
    if (ad.length > 0) return ["adopt", `The lockfile holds old versions of ${[...new Set(ad.map((e) => e.to))].join(", ")}.`];
    return ["up-to-date", "Nothing to do."];
  };
  for (const p of g.packages) {
    const impId = `${p.repo}:${p.path || "."}`;
    const out = edgesFrom.get(impId) ?? [];
    const [status, why] = nodeStatus(out, p);
    const willPublish = !p.npm.exists || pendingBump.has(p.name) || cascade.has(p.name);
    nodes.push({
      id: p.name,
      kind: "package",
      name: p.name,
      repo: p.repo,
      path: p.path,
      repoPrivate: p.repoPrivate,
      version: p.version,
      npmLatest: p.npm.latest,
      onNpm: p.npm.exists,
      next: willPublish ? (pendingBump.has(p.name) || !p.npm.exists ? valid(p.version) : (target.get(p.name) ?? null)) : null,
      status,
      why,
      actions: actionsOf(p.repo, p.name, impId),
      dependents: [...(dependents.get(p.name) ?? [])].sort(),
      dependsOn: [...new Set(out.map((e) => e.to))].sort(),
      level: 0,
    });
  }
  for (const imp of g.importers) {
    if (pkgOfImporter(imp)) continue;
    const out = edgesFrom.get(imp.id) ?? [];
    if (out.length === 0) continue;
    const [status, why] = nodeStatus(out, null);
    nodes.push({
      id: imp.id,
      kind: "app",
      name: imp.name ?? imp.id,
      repo: imp.repo,
      path: imp.path,
      repoPrivate: imp.repoPrivate,
      version: imp.version,
      npmLatest: null,
      onNpm: false,
      next: null,
      status,
      why,
      actions: actionsOf(imp.repo, null, imp.id),
      dependents: [],
      dependsOn: [...new Set(out.map((e) => e.to))].sort(),
      level: 0,
    });
  }
  assignLevels(nodes);

  const flags = edges.filter((e) => ["github", "git", "file", "link", "tarball"].includes(e.kind));
  const countBy = <K extends string>(keys: readonly K[], vals: readonly K[]): Record<K, number> => {
    const r = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
    for (const v of vals) r[v]++;
    return r;
  };
  return {
    owner: g.owner,
    generatedAt: g.generatedAt,
    counts: {
      actions: countBy(Object.keys(KIND_ORDER) as ActionKind[], ordered.map((a) => a.kind)),
      nodes: countBy(STATUS_ORDER, nodes.map((n) => n.status)),
      packages: g.packages.length,
      repos: g.repos.length,
      edges: edges.length,
      flags: flags.length,
      blockingFlags: flags.filter((f) => f.blocking).length,
      taken: taken.size + clashes.length,
      behind: behind.size,
    },
    actions: ordered,
    nodes,
    edges,
    cycles,
    actionCycles,
    flags,
    taken: [...taken.values(), ...clashes].sort((x, y) => x.name.localeCompare(y.name) || x.version.localeCompare(y.version) || x.pulls.length - y.pulls.length),
    behind: [...behind.values()].sort((x, y) => x.name.localeCompare(y.name) || x.dep.localeCompare(y.dep)),
    repos: g.repos,
    reposWithoutPnpmLock: g.repos.filter((r) => r.lockKind !== "pnpm" && r.importers > 0).map((r) => r.name),
    warnings,
  };
}
