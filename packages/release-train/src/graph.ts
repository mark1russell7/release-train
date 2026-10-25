import { BLOCKING_KINDS, DEP_TYPES } from "./types.ts";
import type { Edge, Graph, Importer, NpmInfo, PackageNode, RepoInfo, RepoSnapshot } from "./types.ts";
import { parseSpec } from "./parse.ts";
import { needsAgeRule, ownScopes } from "./settings.ts";

/** The input of `buildGraph`. */
export interface GraphInput {
  owner: string;
  repos: readonly RepoSnapshot[];
  npm: Readonly<Record<string, NpmInfo>>;
  warnings?: readonly string[];
  now?: Date;
}

/** This function gives the ID of the importer at the folder `path` of the repository `repo`. */
export function importerId(repo: string, path: string): string {
  return `${repo}:${path || "."}`;
}

/** This function makes the dependency graph from the repository data and the npm data. */
export function buildGraph(input: GraphInput): Graph {
  const warnings = [...(input.warnings ?? [])];
  const packages = new Map<string, PackageNode>();
  const importers: Importer[] = [];
  const repoInfos: RepoInfo[] = [];

  for (const repo of input.repos) {
    const info: RepoInfo = {
      name: repo.name,
      private: repo.private,
      lockKind: repo.lockKind,
      packages: [],
      importers: repo.manifests.length,
      warnings: [...repo.warnings],
      pendingChangesets: repo.pendingChangesets ?? 0,
      needsAgeRule: needsAgeRule({ lockKind: repo.lockKind, pnpmWorkspace: repo.pnpmWorkspace ?? null, packageManager: repo.packageManager ?? null }, ownScopes(input.owner)),
    };
    for (const { path, manifest: m } of repo.manifests) {
      const published = Boolean(m.name) && m.private !== true;
      importers.push({
        id: importerId(repo.name, path),
        repo: repo.name,
        path,
        name: m.name ?? null,
        version: m.version ?? null,
        published,
        repoPrivate: repo.private,
      });
      if (!published || !m.name) continue;
      if (input.npm[m.name]?.foreign) {
        info.warnings.push(`${path || "."}/package.json has the name ${m.name}, but another person publishes that package on npm. The graph ignores it.`);
        continue;
      }
      const prior = packages.get(m.name);
      if (prior) {
        const msg = `The package ${m.name} is in ${prior.repo}/${prior.path || "."} and in ${repo.name}/${path || "."}. The graph uses the first.`;
        info.warnings.push(msg);
        continue;
      }
      info.packages.push(m.name);
      packages.set(m.name, {
        name: m.name,
        repo: repo.name,
        path,
        version: m.version ?? null,
        repoPrivate: repo.private,
        npm: input.npm[m.name] ?? { exists: false, latest: null },
      });
    }
    repoInfos.push(info);
  }

  const edges: Edge[] = [];
  const byRepo = new Map(input.repos.map((r) => [r.name, r]));
  for (const imp of importers) {
    const repo = byRepo.get(imp.repo);
    const mf = repo?.manifests.find((m) => m.path === imp.path);
    if (!repo || !mf) continue;
    for (const type of DEP_TYPES) {
      for (const [key, spec] of Object.entries(mf.manifest[type] ?? {})) {
        const parsed = parseSpec(key, spec);
        const target = packages.get(parsed.target);
        if (!target) continue;
        // A package that lists itself, for example as a peer of its own tests, is no edge.
        if (target.repo === imp.repo && target.path === imp.path) continue;
        const resolvedRaw = repo.resolved[imp.path]?.[key] ?? null;
        let kind = parsed.kind;
        // pnpm can link a plain range to a workspace package of the same repository.
        if (kind === "registry" && resolvedRaw?.startsWith("link:") && target.repo === imp.repo) kind = "workspace";
        const resolved = resolvedRaw && !/^(link|file):/.test(resolvedRaw) ? resolvedRaw : null;
        edges.push({
          from: imp.id,
          fromName: imp.name,
          to: target.name,
          type,
          spec,
          kind,
          range: parsed.range,
          resolved,
          sameRepo: target.repo === imp.repo,
          blocking: imp.published && type !== "devDependencies" && BLOCKING_KINDS.includes(kind),
        });
      }
    }
  }

  return {
    owner: input.owner,
    generatedAt: (input.now ?? new Date()).toISOString(),
    repos: repoInfos,
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    importers,
    edges,
    warnings,
  };
}

/**
 * This function removes each private repository from the graph: its packages, its importers and their edges.
 * Each public output uses this view.
 */
export function publicView(g: Graph): Graph {
  const privRepos = new Set(g.repos.filter((r) => r.private).map((r) => r.name));
  const privPkgs = new Set(g.packages.filter((p) => privRepos.has(p.repo)).map((p) => p.name));
  const importers = g.importers.filter((i) => !privRepos.has(i.repo));
  const keep = new Set(importers.map((i) => i.id));
  const secret = [...privRepos, ...privPkgs];
  const clean = (ws: readonly string[]): string[] => ws.filter((w) => !secret.some((n) => w.includes(n)));
  return {
    ...g,
    repos: g.repos.filter((r) => !r.private).map((r) => ({ ...r, warnings: clean(r.warnings) })),
    packages: g.packages.filter((p) => !privPkgs.has(p.name)),
    importers,
    edges: g.edges.filter((e) => keep.has(e.from) && !privPkgs.has(e.to)),
    // A warning can name a private package, so the public view keeps only the warnings without such a name.
    warnings: clean(g.warnings),
  };
}
