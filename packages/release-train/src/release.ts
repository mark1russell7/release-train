import { gunzipSync } from "node:zlib";
import semver from "semver";

/** The release type of a version bump. */
export type ReleaseType = "patch" | "minor" | "major";

/** The suffixes of the files that hold types: declaration files and TypeScript sources. */
const TYPED = [".d.ts", ".d.mts", ".d.cts", ".ts", ".mts", ".cts", ".tsx"];

/**
 * This function reads the typed files of an npm tarball (a gzip tar file). It gives the path and the text of each file.
 * It reads only the files with a type suffix and skips the test files.
 */
export function typedFiles(tgz: Uint8Array, maxBytes = 50_000_000): Map<string, string> {
  const tar = gunzipSync(tgz, { maxOutputLength: maxBytes });
  const out = new Map<string, string>();
  let pos = 0;
  let longName: string | null = null;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number): string => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end < 0 ? len : end).toString("utf8");
    };
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const body = tar.subarray(pos + 512, pos + 512 + size);
    if (type === "L") longName = body.toString("utf8").split("\0")[0] ?? null;
    else if ((type === "0" || type === "") && TYPED.some((s) => name.endsWith(s)) && !name.includes(".test.") && !name.includes(".spec.")) {
      out.set(name, body.toString("utf8"));
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** This function tells if a text names a module specifier of a package: `"dep"`, `'dep'`, `"dep/sub"` or `'dep/sub'`. */
export function namesModule(text: string, dep: string): boolean {
  for (const q of ['"', "'"]) {
    if (text.includes(`${q}${dep}${q}`) || text.includes(`${q}${dep}/`)) return true;
  }
  return false;
}

/** The input of the decision of the release type of a dependent. */
export interface BumpInput {
  /** The version of the dependent on npm. */
  from: string;
  /** The typed files of the release `from` of the dependent, or null when npm did not give them. */
  files: Map<string, string> | null;
  /** The dependencies whose range changes in a breaking way, with the section of the range. */
  changes: readonly { dep: string; type: string }[];
}

/** The decision: the release type, the new version and the reason. */
export interface BumpDecision {
  type: ReleaseType;
  to: string;
  why: string;
}

/**
 * This function decides the release type of a dependent from its public types. A change breaks the API when a peer range
 * changes, or when the published types of the dependent name a changed dependency (the types of that dependency can then
 * reach the users). It is a patch when the published types name no changed dependency. When the types are not available,
 * the case is not clear, so the change counts as a break. A break of the API gives MINOR before `1.0.0` and MAJOR after.
 */
export function decideBump(i: BumpInput): BumpDecision {
  const deps = i.changes.map((c) => c.dep);
  const breaking = (why: string): BumpDecision => {
    const type: ReleaseType = semver.major(i.from) === 0 ? "minor" : "major";
    return { type, to: semver.inc(i.from, type) as string, why };
  };
  const peer = i.changes.find((c) => c.type === "peerDependencies");
  if (peer) return breaking(`The peer range of ${peer.dep} changes.`);
  if (i.files === null || i.files.size === 0) return breaking("The published types are not available, so the change counts as breaking.");
  const named = deps.filter((d) => [...i.files!.values()].some((t) => namesModule(t, d)));
  if (named.length > 0) return breaking(`The public types name ${named.join(", ")}, so its new major version can change them.`);
  return { type: "patch", to: semver.inc(i.from, "patch") as string, why: `The public types do not name ${deps.join(", ")}.` };
}

/** This function sets the `version` field of a `package.json` text. It keeps the other text. It gives null when it finds no field. */
export function setManifestVersion(text: string, to: string): string | null {
  const key = '"version"';
  const at = text.indexOf(key);
  if (at < 0) return null;
  const colon = text.indexOf(":", at + key.length);
  const open = text.indexOf('"', colon + 1);
  const close = open < 0 ? -1 : text.indexOf('"', open + 1);
  if (colon < 0 || open < 0 || close < 0 || text.slice(at + key.length, colon).trim() !== "" || text.slice(colon + 1, open).trim() !== "") return null;
  return `${text.slice(0, open + 1)}${to}${text.slice(close)}`;
}

/** This function gives the text of a changeset file. */
export function changesetText(packages: readonly { name: string; type: ReleaseType }[], summary: string): string {
  return ["---", ...packages.map((p) => `"${p.name}": ${p.type}`), "---", "", summary, ""].join("\n");
}

/** The input of the wait for a release. */
export interface AwaitInput {
  /** The public package versions that a release workflow publishes. */
  inFlight: readonly { name: string; version: string }[];
  /** This function tells if npm has a version of a package. */
  published: (name: string, version: string) => Promise<boolean>;
  /** This function waits the given time. */
  sleep: (ms: number) => Promise<void>;
  /** The maximum time of the wait. */
  maxMs: number;
  /** The time between two checks. */
  intervalMs: number;
}

/**
 * This function waits until npm has one of the versions in flight, or the time ends. It gives the first published
 * version, or null. A published version starts the next wave of the train.
 */
export async function awaitRelease(i: AwaitInput): Promise<{ name: string; version: string } | null> {
  if (i.inFlight.length === 0) return null;
  for (let waited = 0; ; waited += i.intervalMs) {
    for (const x of i.inFlight) if (await i.published(x.name, x.version)) return x;
    if (waited + i.intervalMs > i.maxMs) return null;
    await i.sleep(i.intervalMs);
  }
}
