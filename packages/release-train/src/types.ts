/** The four sections of a `package.json` that hold dependencies. */
export type DepType = "dependencies" | "peerDependencies" | "optionalDependencies" | "devDependencies";

/** This list holds each dependency section, in a fixed sequence. */
export const DEP_TYPES: readonly DepType[] = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];

/** The kind of a dependency specifier. */
export type SpecKind = "registry" | "workspace" | "github" | "git" | "file" | "link" | "tarball" | "tag";

/** These specifier kinds stop the release of a published package when they are in a runtime section. */
export const BLOCKING_KINDS: readonly SpecKind[] = ["github", "git", "file", "link", "tarball"];

/** The part of a `package.json` that the graph uses. */
export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

/** A `package.json` file and its folder in the repository. The root folder is the empty string. */
export interface ManifestFile {
  path: string;
  manifest: Manifest;
}

/** The kind of the lockfile at the root of a repository. */
export type LockKind = "pnpm" | "npm" | "yarn" | "none";

/** The resolved versions of a lockfile: folder of the importer, then dependency name, then version. */
export type Resolved = Record<string, Record<string, string>>;

/** The data of one repository that the graph builder reads. */
export interface RepoSnapshot {
  name: string;
  private: boolean;
  defaultBranch: string;
  manifests: ManifestFile[];
  lockKind: LockKind;
  resolved: Resolved;
  warnings: string[];
  /** The text of `pnpm-workspace.yaml`, or null when the repository has no such file. */
  pnpmWorkspace?: string | null;
  /** The `packageManager` field of the root `package.json`, for example `pnpm@12.0.0`. */
  packageManager?: string | null;
  /** The count of the changeset files on the default branch (`.changeset/*.md`, not the README). */
  pendingChangesets?: number;
}

/** The state of one package on the npm registry. */
export interface NpmInfo {
  exists: boolean;
  latest: string | null;
  /** This value is true when another person publishes the npm package of this name, for example for a copied package. */
  foreign?: boolean;
}

/** A package of the owner: a `package.json` with a name and without `"private": true`. */
export interface PackageNode {
  name: string;
  repo: string;
  path: string;
  version: string | null;
  repoPrivate: boolean;
  npm: NpmInfo;
}

/** An importer is a `package.json` in a repository. It can depend on the packages of the owner. */
export interface Importer {
  id: string;
  repo: string;
  path: string;
  name: string | null;
  version: string | null;
  published: boolean;
  repoPrivate: boolean;
}

/** A dependency of an importer on a package of the owner. */
export interface Edge {
  from: string;
  fromName: string | null;
  to: string;
  type: DepType;
  spec: string;
  kind: SpecKind;
  range: string | null;
  resolved: string | null;
  sameRepo: boolean;
  blocking: boolean;
}

/** A summary of one repository. */
export interface RepoInfo {
  name: string;
  private: boolean;
  lockKind: LockKind;
  packages: string[];
  importers: number;
  warnings: string[];
  /** True when the release train must put the scopes of the owner into `minimumReleaseAgeExclude` of pnpm. */
  needsAgeRule?: boolean;
  /** The count of the changeset files on the default branch. */
  pendingChangesets?: number;
}

/** The dependency graph of the packages of one owner. */
export interface Graph {
  owner: string;
  generatedAt: string;
  repos: RepoInfo[];
  packages: PackageNode[];
  importers: Importer[];
  edges: Edge[];
  warnings: string[];
}
