import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { attestationsUrl, workflowProvenance, type Attestations } from "./attest.ts";
import type { FetchFn } from "./collect.ts";
import { tarFiles } from "./release.ts";
import type { Provenance } from "./types.ts";

/**
 * The fields of `package.json` that a move can change: the version and the fields that name the repository.
 * Each other field must stay equal. `--allow-field` adds a field.
 */
export const MOVE_FIELDS: readonly string[] = ["version", "repository", "gitHead", "homepage", "bugs"];

/** One side of a move: the release before the move or the release after it. */
export interface MoveSide {
  /** `npm` for a release on the registry, or the path of a tarball file. */
  source: string;
  /** The version in `package.json` of the tarball. */
  version: string | null;
  /** The SRI integrity of the tarball: `sha512-` and the base64 digest. */
  integrity: string;
  /** The repository that `package.json` names, as `owner/name`, or null. */
  repository: string | null;
  /** The repository and the workflow of the SLSA provenance on npm, or null. */
  provenance: Provenance | null;
}

/** The result of the gate of a move. */
export interface MoveReport {
  package: string;
  /** The repository after the move, as `owner/name`. */
  repo: string;
  from: MoveSide;
  to: MoveSide;
  files: {
    /** The count of the files with the same bytes. */
    same: number;
    changed: string[];
    added: string[];
    removed: string[];
    /** The changed files that `--allow-file` names. They are not faults. */
    allowed: string[];
  };
  packageJson: {
    /** The different top-level fields that the gate does not permit. */
    changed: string[];
    /** The different fields that the gate permits. */
    allowed: string[];
  };
  /** The causes of a failed gate. The gate passes only with no fault. */
  faults: string[];
  /** The checks that the gate did not do, with the reason. */
  notChecked: string[];
  pass: boolean;
}

/** This function gives the SRI integrity of some bytes with SHA-512. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** This function tells if the bytes agree with an SRI integrity text. The text can hold more hashes. Only `sha512` counts. */
export function integrityMatches(bytes: Uint8Array, sri: string): boolean {
  const want = sri.split(/\s+/).filter((h) => h.startsWith("sha512-"));
  return want.length > 0 && want.includes(integrityOf(bytes));
}

/**
 * This function gives the GitHub repository of a `repository` field as `owner/name` in lower case, or null.
 * It reads `owner/name`, `github:owner/name`, the https, git and ssh URLs, with or without `.git`.
 */
export function repositoryOf(field: unknown): string | null {
  const raw = typeof field === "string" ? field : typeof field === "object" && field !== null ? (field as { url?: unknown }).url : undefined;
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m =
    /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(text) ??
    /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com[:/]([\w.-]+)\/([\w.-]+)$/.exec(text) ??
    /^git@github\.com:([\w.-]+)\/([\w.-]+)$/.exec(text);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** This function gives the repository of a provenance URL, as `owner/name` in lower case, or null. */
function provenanceRepo(p: Provenance | null): string | null {
  return p ? repositoryOf(p.repository) : null;
}

/** This function writes a JSON value with the keys of each object in order, so two equal values give the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/** This function removes the first folder of each path of a tarball. npm puts each file in the folder `package/`. */
function unrooted(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [name, body] of files) out.set(name.slice(name.indexOf("/") + 1), body);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

function manifestOf(files: Map<string, Uint8Array>): Record<string, unknown> | null {
  const body = files.get("package.json");
  if (!body) return null;
  try {
    const v = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The input of `compareMove`: the two tarballs and what the gate knows about them. */
export interface CompareInput {
  name: string;
  repo: string;
  from: { source: string; tgz: Uint8Array; provenance: Provenance | null };
  to: { source: string; tgz: Uint8Array; provenance: Provenance | null; provenanceChecked: boolean };
  allowFields?: readonly string[];
  allowFiles?: readonly string[];
}

/**
 * This function compares the tarball of a release before a move with the tarball after it.
 * Each file except `package.json` must have the same bytes. In `package.json`, only the fields of `MOVE_FIELDS`
 * and `allowFields` can change. The repository of `package.json` and of the provenance must be `repo`.
 */
export function compareMove(input: CompareInput): MoveReport {
  const repo = input.repo.toLowerCase();
  const faults: string[] = [];
  const notChecked: string[] = [];
  const before = unrooted(tarFiles(input.from.tgz));
  const after = unrooted(tarFiles(input.to.tgz));
  const allowFiles = new Set(input.allowFiles ?? []);
  const files: MoveReport["files"] = { same: 0, changed: [], added: [], removed: [], allowed: [] };
  for (const [name, body] of before) {
    const other = after.get(name);
    if (name === "package.json") continue;
    if (other === undefined) files.removed.push(name);
    else if (sameBytes(body, other)) files.same++;
    else if (allowFiles.has(name)) files.allowed.push(name);
    else files.changed.push(name);
  }
  for (const name of after.keys()) if (!before.has(name) && name !== "package.json") files.added.push(name);
  for (const k of ["changed", "added", "removed", "allowed"] as const) files[k].sort();
  for (const n of files.changed) faults.push(`The bytes of ${n} changed.`);
  for (const n of files.added) faults.push(`The new tarball adds ${n}.`);
  for (const n of files.removed) faults.push(`The new tarball does not have ${n}.`);

  const m0 = manifestOf(before);
  const m1 = manifestOf(after);
  const allowFields = new Set([...MOVE_FIELDS, ...(input.allowFields ?? [])]);
  const packageJson: MoveReport["packageJson"] = { changed: [], allowed: [] };
  if (!m0) faults.push("The old tarball has no package.json that parses.");
  if (!m1) faults.push("The new tarball has no package.json that parses.");
  if (m0 && m1) {
    for (const k of [...new Set([...Object.keys(m0), ...Object.keys(m1)])].sort()) {
      if (canonical(m0[k]) === canonical(m1[k])) continue;
      (allowFields.has(k) ? packageJson.allowed : packageJson.changed).push(k);
    }
    for (const k of packageJson.changed) faults.push(`The field ${k} of package.json changed.`);
    for (const [label, m] of [["old", m0], ["new", m1]] as const) {
      if (m["name"] !== input.name) faults.push(`The ${label} package.json names ${String(m["name"])}, not ${input.name}.`);
    }
  }
  const toRepo = m1 ? repositoryOf(m1["repository"]) : null;
  if (m1 && toRepo !== repo) faults.push(`The repository of the new package.json is ${toRepo ?? "absent"}, not ${repo}.`);

  const toProvenance = provenanceRepo(input.to.provenance);
  if (!input.to.provenanceChecked) notChecked.push("provenance: the new tarball is a file, so npm has no provenance of it.");
  else if (toProvenance === null) faults.push("npm has no SLSA provenance of the new release.");
  else if (toProvenance !== repo) faults.push(`The provenance of the new release names ${toProvenance}, not ${repo}.`);

  const side = (s: { source: string; tgz: Uint8Array; provenance: Provenance | null }, m: Record<string, unknown> | null): MoveSide => ({
    source: s.source,
    version: typeof m?.["version"] === "string" ? m["version"] : null,
    integrity: integrityOf(s.tgz),
    repository: m ? repositoryOf(m["repository"]) : null,
    provenance: s.provenance,
  });
  return {
    package: input.name,
    repo,
    from: side(input.from, m0),
    to: side(input.to, m1),
    files,
    packageJson,
    faults,
    notChecked,
    pass: faults.length === 0,
  };
}

/** The options of `moveCheck`. */
export interface MoveCheckOptions {
  /** The npm name of the package. */
  name: string;
  /** The version on npm before the move. */
  from: string;
  /** The version on npm after the move, or the path of a tarball file (a name that ends in `.tgz`). */
  to: string;
  /** The repository after the move, as `owner/name`. */
  repo: string;
  allowFields?: readonly string[];
  allowFiles?: readonly string[];
  fetch?: FetchFn;
  registry?: string;
  readFile?: (path: string) => Uint8Array;
}

/** This function tells if the `to` of a move names a tarball file and not a version. */
export function isTarballPath(to: string): boolean {
  return to.endsWith(".tgz");
}

/**
 * This function examines a move of a package from one repository to another. It downloads the old release from npm
 * and examines its integrity. It reads the new tarball from npm or from a file. It gives the report of `compareMove`.
 */
export async function moveCheck(opts: MoveCheckOptions): Promise<MoveReport> {
  const f = opts.fetch ?? fetch;
  const registry = (opts.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const headers = { "user-agent": "release-train" };
  const encoded = opts.name.replaceAll("/", "%2f");
  const download = async (version: string): Promise<Uint8Array> => {
    const res = await f(`${registry}/${encoded}/${encodeURIComponent(version)}`, { headers });
    if (!res.ok) throw new Error(`npm gave HTTP ${res.status} for ${opts.name}@${version}.`);
    const doc = (await res.json()) as { dist?: { tarball?: unknown; integrity?: unknown } };
    const url = doc.dist?.tarball;
    const sri = doc.dist?.integrity;
    if (typeof url !== "string" || typeof sri !== "string") throw new Error(`npm gives no tarball or integrity for ${opts.name}@${version}.`);
    const tar = await f(url, { headers });
    if (!tar.ok) throw new Error(`npm gave HTTP ${tar.status} for the tarball of ${opts.name}@${version}.`);
    const bytes = new Uint8Array(await tar.arrayBuffer());
    if (!integrityMatches(bytes, sri)) throw new Error(`The tarball of ${opts.name}@${version} does not agree with its integrity ${sri}.`);
    return bytes;
  };
  const provenance = async (version: string): Promise<Provenance | null> => {
    const res = await f(attestationsUrl(registry, opts.name, version), { headers });
    return res.ok ? workflowProvenance((await res.json()) as Attestations) : null;
  };
  const fromTgz = await download(opts.from);
  const fromProvenance = await provenance(opts.from);
  const file = isTarballPath(opts.to);
  const toTgz = file ? (opts.readFile ?? ((p: string) => new Uint8Array(readFileSync(p))))(opts.to) : await download(opts.to);
  const toProvenance = file ? null : await provenance(opts.to);
  return compareMove({
    name: opts.name,
    repo: opts.repo,
    from: { source: "npm", tgz: fromTgz, provenance: fromProvenance },
    to: { source: file ? opts.to : "npm", tgz: toTgz, provenance: toProvenance, provenanceChecked: !file },
    ...(opts.allowFields ? { allowFields: opts.allowFields } : {}),
    ...(opts.allowFiles ? { allowFiles: opts.allowFiles } : {}),
  });
}

/** This function gives a short text of the report of a move. */
export function moveSummary(r: MoveReport): string {
  const to = r.to.source === "npm" ? `${r.to.version ?? "?"} on npm` : `${r.to.version ?? "?"} from ${r.to.source}`;
  const lines = [
    `Move of ${r.package} to ${r.repo}: ${r.pass ? "PASS" : "FAIL"}`,
    `from ${r.from.version ?? "?"} (${r.from.repository ?? "no repository"}) ${r.from.integrity}`,
    `to   ${to} (${r.to.repository ?? "no repository"}) ${r.to.integrity}`,
    `files: ${r.files.same} same, ${r.files.changed.length} changed, ${r.files.added.length} added, ${r.files.removed.length} removed, ${r.files.allowed.length} allowed`,
    `package.json: ${r.packageJson.changed.length} changed fields, allowed changes: ${r.packageJson.allowed.join(", ") || "none"}`,
    `provenance: ${r.to.provenance ? `${r.to.provenance.repository} ${r.to.provenance.workflow}` : "none"}`,
  ];
  for (const n of r.notChecked) lines.push(`not checked: ${n}`);
  for (const fault of r.faults) lines.push(`fault: ${fault}`);
  return lines.join("\n");
}
