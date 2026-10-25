import { parse as parseYaml, parseAllDocuments } from "yaml";
import { DEP_TYPES } from "./types.ts";
import type { Manifest, Resolved, SpecKind } from "./types.ts";

/** The result of `parseSpec`: the real package name, the kind of the specifier and its range. */
export interface ParsedSpec {
  target: string;
  kind: SpecKind;
  range: string | null;
}

const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+(#.*)?$/;

/**
 * This function finds the kind of a dependency specifier.
 * An `npm:` alias gives the real package name as the target.
 */
export function parseSpec(name: string, spec: string): ParsedSpec {
  const s = spec.trim();
  if (s.startsWith("workspace:")) return { target: name, kind: "workspace", range: s.slice("workspace:".length) };
  if (s.startsWith("npm:")) {
    const rest = s.slice(4);
    const at = rest.lastIndexOf("@");
    if (at > 0) return { target: rest.slice(0, at), kind: "registry", range: rest.slice(at + 1) || "*" };
    return { target: rest, kind: "registry", range: "*" };
  }
  if (s.startsWith("github:") || (GITHUB_SHORTHAND.test(s) && !s.startsWith("@"))) {
    return { target: name, kind: "github", range: null };
  }
  if (/^git(\+[a-z]+)?:|^git@/.test(s)) return { target: name, kind: "git", range: null };
  if (s.startsWith("file:")) return { target: name, kind: "file", range: null };
  if (s.startsWith("link:")) return { target: name, kind: "link", range: null };
  if (/^https?:/.test(s)) return { target: name, kind: "tarball", range: null };
  if (s === "" || s === "*" || s === "x") return { target: name, kind: "registry", range: "*" };
  if (/^[a-z][\w.-]*$/i.test(s) && !/^v?\d/.test(s)) return { target: name, kind: "tag", range: s };
  return { target: name, kind: "registry", range: s };
}

/** This function changes a workspace glob into a regular expression for a folder path. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        out += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** This function gives the folders of the workspace packages, from the globs and the folders that hold a `package.json`. */
export function matchWorkspaces(globs: readonly string[], dirs: readonly string[]): string[] {
  const include = globs.filter((g) => !g.startsWith("!")).map(globToRegExp);
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1)));
  return dirs
    .filter((d) => d !== "" && !d.split("/").includes("node_modules"))
    .filter((d) => include.some((r) => r.test(d)) && !exclude.some((r) => r.test(d)))
    .sort();
}

/** This function reads the package globs of `pnpm-workspace.yaml`. */
export function parsePnpmWorkspace(text: string): string[] {
  const doc = parseYaml(text) as { packages?: unknown } | null;
  return Array.isArray(doc?.packages) ? doc.packages.filter((p): p is string => typeof p === "string") : [];
}

/** This function reads the workspace globs of a root `package.json` (npm and Yarn). */
export function manifestWorkspaces(m: Manifest): string[] {
  if (Array.isArray(m.workspaces)) return m.workspaces;
  return m.workspaces?.packages ?? [];
}

function cleanVersion(v: string): string {
  // pnpm adds the peer set in parentheses: "1.2.3(react@19.0.0)".
  const i = v.indexOf("(");
  return (i >= 0 ? v.slice(0, i) : v).trim();
}

type LockSection = Record<string, string | { version?: string; specifier?: string }>;

/**
 * This function reads the resolved version of each direct dependency of each importer of `pnpm-lock.yaml`.
 * It reads the format with `importers` and the old format without it.
 * pnpm 11 and later write two YAML documents. The first holds the environment. The second holds the dependencies.
 */
export function parsePnpmLock(text: string): Resolved {
  const out: Resolved = {};
  for (const d of parseAllDocuments(text)) {
    if ("errors" in d && d.errors.length > 0) throw d.errors[0];
    const doc = d.toJS({ maxAliasCount: -1 }) as Record<string, unknown> | null;
    if (!doc || typeof doc !== "object") continue;
    const importers = (doc["importers"] as Record<string, Record<string, LockSection>> | undefined) ?? {
      ".": doc as Record<string, LockSection>,
    };
    for (const [key, imp] of Object.entries(importers)) {
      const path = key === "." ? "" : key.replace(/^\.\//, "");
      const deps: Record<string, string> = { ...out[path] };
      for (const t of DEP_TYPES) {
        const section = imp?.[t];
        if (!section || typeof section !== "object") continue;
        for (const [name, val] of Object.entries(section)) {
          const v = typeof val === "string" ? val : val?.version;
          if (typeof v === "string") deps[name] = cleanVersion(v);
        }
      }
      out[path] = deps;
    }
  }
  return out;
}

/** This function reads the resolved versions of `package-lock.json` (format 2 or 3) for the given importers. */
export function parseNpmLock(text: string, importerPaths: readonly string[], names: readonly string[]): Resolved {
  const doc = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
  const pkgs = doc.packages ?? {};
  const out: Resolved = {};
  for (const p of importerPaths) {
    const deps: Record<string, string> = {};
    for (const n of names) {
      const local = pkgs[`${p ? `${p}/` : ""}node_modules/${n}`]?.version;
      const hoisted = pkgs[`node_modules/${n}`]?.version;
      const v = local ?? hoisted;
      if (v) deps[n] = v;
    }
    out[p] = deps;
  }
  return out;
}
