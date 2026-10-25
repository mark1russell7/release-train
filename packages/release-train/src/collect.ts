import { DEP_TYPES } from "./types.ts";
import type { LockKind, Manifest, ManifestFile, NpmInfo, RepoSnapshot } from "./types.ts";
import { manifestWorkspaces, matchWorkspaces, parseNpmLock, parsePnpmLock, parsePnpmWorkspace } from "./parse.ts";

/** The `fetch` function that the collector uses. Tests give a mock. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** The options of `collect`. */
export interface CollectOptions {
  owner: string;
  token: string | null;
  fetch?: FetchFn;
  /** When this option is true, the collector reads no private repository. */
  publicOnly?: boolean;
  /** This option sets the number of requests at one time. */
  concurrency?: number;
  /** The npm user of the owner. The default is the owner name. */
  npmUser?: string;
  apiBase?: string;
  registryBase?: string;
  log?: (line: string) => void;
  /** The collector gives the list of repositories to this function before it reads them, for example to hide private names. */
  onRepos?: (repos: readonly { name: string; private: boolean }[]) => void;
}

/** The data that `collect` gives to the graph builder. */
export interface Collected {
  repos: RepoSnapshot[];
  npm: Record<string, NpmInfo>;
  warnings: string[];
}

interface GhRepo {
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  default_branch: string;
  owner?: { login?: string };
}

interface TreeEntry {
  path: string;
  type: string;
}

/** This error holds the HTTP status of a failed request. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

/** This function starts the tasks with a limit on the number of tasks at one time. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** This function reads the repositories, the manifests, the lockfiles and the npm state of one owner. */
export async function collect(opts: CollectOptions): Promise<Collected> {
  const f: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const api = opts.apiBase ?? "https://api.github.com";
  const registry = opts.registryBase ?? "https://registry.npmjs.org";
  const limit = opts.concurrency ?? 6;
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];

  const ghHeaders = (accept: string): Record<string, string> => {
    const h: Record<string, string> = { accept, "x-github-api-version": "2022-11-28", "user-agent": "release-train" };
    if (opts.token) h["authorization"] = `Bearer ${opts.token}`;
    return h;
  };

  const ghJson = async <T>(url: string): Promise<{ data: T; next: string | null }> => {
    const res = await f(url.startsWith("http") ? url : `${api}${url}`, { headers: ghHeaders("application/vnd.github+json") });
    if (!res.ok) throw new HttpError(res.status, url);
    return { data: (await res.json()) as T, next: nextLink(res.headers.get("link")) };
  };

  const ghRaw = async (repo: string, path: string, ref: string): Promise<string | null> => {
    const url = `${api}/repos/${opts.owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const res = await f(url, { headers: ghHeaders("application/vnd.github.raw") });
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, url);
    return res.text();
  };

  const paginate = async <T>(first: string): Promise<T[]> => {
    const all: T[] = [];
    let url: string | null = first;
    while (url) {
      const page: { data: T[]; next: string | null } = await ghJson<T[]>(url);
      all.push(...page.data);
      url = page.next;
    }
    return all;
  };

  // The list of repositories. A token of the owner also lists the private repositories.
  let listUrl = `/users/${opts.owner}/repos?type=owner&per_page=100`;
  if (opts.token && !opts.publicOnly) {
    try {
      const me = await ghJson<{ login?: string }>("/user");
      if (me.data.login?.toLowerCase() === opts.owner.toLowerCase()) {
        listUrl = "/user/repos?affiliation=owner&visibility=all&per_page=100";
      }
    } catch {
      // A workflow token cannot read /user. The public list is correct for it.
    }
  }
  let listed: GhRepo[] | null = null;
  if (opts.token && !opts.publicOnly && listUrl.startsWith("/users/")) {
    // The token of a GitHub App installation lists its repositories, also the private ones.
    try {
      const all: GhRepo[] = [];
      let url: string | null = "/installation/repositories?per_page=100";
      while (url) {
        const page: { data: { repositories: GhRepo[] }; next: string | null } = await ghJson<{ repositories: GhRepo[] }>(url);
        all.push(...page.data.repositories);
        url = page.next;
      }
      listed = all;
    } catch {
      // A token that is not of an installation cannot read this list. The public list is correct for it.
    }
  }
  const ghRepos = (listed ?? (await paginate<GhRepo>(listUrl)))
    .filter((r) => !r.archived && !r.fork)
    .filter((r) => !(opts.publicOnly && r.private))
    .filter((r) => !r.owner?.login || r.owner.login.toLowerCase() === opts.owner.toLowerCase())
    .sort((a, b) => a.name.localeCompare(b.name));
  opts.onRepos?.(ghRepos.map((r) => ({ name: r.name, private: r.private })));
  log(`repositories: ${ghRepos.length}`);

  // Phase 1: the manifests of each repository.
  interface Partial1 {
    snap: RepoSnapshot;
    lockPath: string | null;
  }
  const phase1 = await pool(ghRepos, limit, async (r): Promise<Partial1 | null> => {
    const snap: RepoSnapshot = {
      name: r.name,
      private: r.private,
      defaultBranch: r.default_branch,
      manifests: [],
      lockKind: "none",
      resolved: {},
      warnings: [],
    };
    let tree: { tree: TreeEntry[]; truncated?: boolean };
    try {
      tree = (await ghJson<{ tree: TreeEntry[]; truncated?: boolean }>(
        `/repos/${opts.owner}/${r.name}/git/trees/${encodeURIComponent(r.default_branch)}?recursive=1`,
      )).data;
    } catch (e) {
      // An empty repository gives HTTP 409.
      if (e instanceof HttpError && (e.status === 409 || e.status === 404)) return null;
      throw e;
    }
    if (tree.truncated) snap.warnings.push("The git tree is too large. GitHub gave only a part of it.");
    const blobs = new Set(tree.tree.filter((t) => t.type === "blob").map((t) => t.path));
    if (!blobs.has("package.json")) return null;
    const rootText = await ghRaw(r.name, "package.json", r.default_branch);
    if (rootText === null) return null;
    let root: Manifest;
    try {
      root = JSON.parse(rootText) as Manifest;
    } catch {
      snap.warnings.push("The root package.json is not valid JSON.");
      return { snap, lockPath: null };
    }
    snap.manifests.push({ path: "", manifest: root });

    let globs: string[] = manifestWorkspaces(root);
    if (blobs.has("pnpm-workspace.yaml")) {
      const ws = await ghRaw(r.name, "pnpm-workspace.yaml", r.default_branch);
      if (ws) globs = [...globs, ...parsePnpmWorkspace(ws)];
    }
    if (globs.length > 0) {
      const dirs = [...blobs]
        .filter((p) => p.endsWith("/package.json"))
        .map((p) => p.slice(0, -"/package.json".length));
      const wsDirs = matchWorkspaces(globs, dirs);
      const files = await pool(wsDirs, limit, async (d): Promise<ManifestFile | null> => {
        const text = await ghRaw(r.name, `${d}/package.json`, r.default_branch);
        if (text === null) return null;
        try {
          return { path: d, manifest: JSON.parse(text) as Manifest };
        } catch {
          snap.warnings.push(`${d}/package.json is not valid JSON.`);
          return null;
        }
      });
      for (const m of files) if (m) snap.manifests.push(m);
    }

    let lockKind: LockKind = "none";
    let lockPath: string | null = null;
    if (blobs.has("pnpm-lock.yaml")) [lockKind, lockPath] = ["pnpm", "pnpm-lock.yaml"];
    else if (blobs.has("package-lock.json")) [lockKind, lockPath] = ["npm", "package-lock.json"];
    else if (blobs.has("yarn.lock")) lockKind = "yarn";
    snap.lockKind = lockKind;
    return { snap, lockPath };
  });
  const snaps = phase1.filter((p): p is Partial1 => p !== null);

  // The names of the packages of the owner.
  const owned = new Set<string>();
  for (const { snap } of snaps) {
    for (const { manifest: m } of snap.manifests) if (m.name && m.private !== true) owned.add(m.name);
  }

  // Phase 2: the lockfiles, only for a repository that depends on a package of the owner.
  await pool(snaps, limit, async ({ snap, lockPath }) => {
    if (!lockPath) return;
    const used = new Set<string>();
    for (const { manifest: m } of snap.manifests) {
      for (const t of DEP_TYPES) for (const n of Object.keys(m[t] ?? {})) if (owned.has(n)) used.add(n);
    }
    if (used.size === 0) return;
    const text = await ghRaw(snap.name, lockPath, snap.defaultBranch);
    if (text === null) return;
    try {
      snap.resolved =
        snap.lockKind === "pnpm"
          ? parsePnpmLock(text)
          : parseNpmLock(text, snap.manifests.map((m) => m.path), [...used]);
    } catch {
      snap.warnings.push(`${lockPath} could not be read.`);
    }
  });

  // A package is foreign when its npm repository is not of the owner and no maintainer is the owner.
  const npmUser = (opts.npmUser ?? opts.owner).toLowerCase();
  const isForeign = async (n: string, version: string): Promise<boolean> => {
    const res = await f(`${registry}/${n.replace("/", "%2f")}/${encodeURIComponent(version)}`, { headers: { "user-agent": "release-train" } });
    if (!res.ok) return false;
    const m = (await res.json()) as { repository?: string | { url?: string }; maintainers?: { name?: string }[] };
    const repoUrl = (typeof m.repository === "string" ? m.repository : (m.repository?.url ?? "")).toLowerCase();
    const ownRepo = repoUrl.includes(`github.com/${opts.owner.toLowerCase()}/`) || repoUrl.startsWith(`github:${opts.owner.toLowerCase()}/`) || repoUrl.startsWith(`${opts.owner.toLowerCase()}/`);
    const ownMaint = (m.maintainers ?? []).some((x) => x.name?.toLowerCase() === npmUser);
    return !ownRepo && !ownMaint;
  };

  // Phase 3: the npm state of each package.
  const names = [...owned].sort();
  const infos = await pool(names, limit, async (n): Promise<[string, NpmInfo]> => {
    const url = `${registry}/${n.replace("/", "%2f")}`;
    const res = await f(url, { headers: { accept: "application/vnd.npm.install-v1+json", "user-agent": "release-train" } });
    if (res.status === 404) return [n, { exists: false, latest: null }];
    if (!res.ok) {
      warnings.push(`npm gave HTTP ${res.status} for ${n}.`);
      return [n, { exists: true, latest: null }];
    }
    const doc = (await res.json()) as { "dist-tags"?: Record<string, string> };
    const latest = doc["dist-tags"]?.["latest"] ?? null;
    return [n, { exists: true, latest, foreign: latest ? await isForeign(n, latest) : false }];
  });
  log(`packages: ${names.length}`);
  return { repos: snaps.map((s) => s.snap), npm: Object.fromEntries(infos), warnings };
}
