// All repository and package names in these tests are made up.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseArgs, runMoveCheck } from "./cli.ts";
import type { FetchFn } from "./collect.ts";
import { compareMove, integrityMatches, integrityOf, isTarballPath, moveCheck, moveSummary, repositoryOf } from "./move.ts";
import type { MoveReport } from "./move.ts";
import { tarFiles } from "./release.ts";

/** This function makes a gzip tar file with the given files. A name longer than 100 bytes gets a long-name entry. */
function tgz(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const entry = (name: string, type: string, body: Buffer): void => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "utf8");
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    h.write(type, 156, "ascii");
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  };
  for (const [name, text] of Object.entries(files)) {
    if (Buffer.byteLength(name) > 100) entry("././@LongLink", "L", Buffer.from(`${name}\0`, "utf8"));
    entry(name, "0", Buffer.from(text, "utf8"));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

const NAME = "@ex/thing";
const OLD = "ex-org/old-home";
const NEW = "ex-org/new-home";

function manifest(version: string, repo: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: NAME, version, main: "./dist/index.js", repository: { type: "git", url: `git+https://github.com/${repo}.git`, directory: "packages/thing" }, ...extra });
}

const BASE = { "package/dist/index.js": "export const a = 1;\n", "package/dist/index.d.ts": "export declare const a = 1;\n", "package/README.md": "# thing\n" };

function before(): Uint8Array {
  return tgz({ ...BASE, "package/package.json": manifest("0.1.8", OLD) });
}

function after(files: Record<string, string> = {}, pkg: string = manifest("0.1.9", NEW)): Uint8Array {
  return tgz({ ...BASE, "package/package.json": pkg, ...files });
}

const PROVENANCE = { repository: `https://github.com/${NEW}`, workflow: ".github/workflows/release.yml" };

function compare(to: Uint8Array, opts: { provenance?: typeof PROVENANCE | null; allowFields?: string[]; allowFiles?: string[]; file?: boolean } = {}): MoveReport {
  return compareMove({
    name: NAME,
    repo: NEW,
    from: { source: "npm", tgz: before(), provenance: null },
    to: { source: opts.file ? "thing.tgz" : "npm", tgz: to, provenance: opts.provenance === undefined ? PROVENANCE : opts.provenance, provenanceChecked: !opts.file },
    ...(opts.allowFields ? { allowFields: opts.allowFields } : {}),
    ...(opts.allowFiles ? { allowFiles: opts.allowFiles } : {}),
  });
}

describe("the tar reader", () => {
  it("gives the bytes of each regular file and reads a long name", () => {
    const long = `package/${"d/".repeat(60)}x.js`;
    const files = tarFiles(tgz({ "package/a.js": "a", [long]: "long" }));
    expect([...files.keys()]).toEqual(["package/a.js", long]);
    expect(Buffer.from(files.get(long) ?? new Uint8Array()).toString("utf8")).toBe("long");
  });
});

describe("the repository of a package.json", () => {
  it("reads each form of the field", () => {
    for (const v of [
      "ex-org/new-home",
      "github:ex-org/new-home",
      "https://github.com/ex-org/new-home",
      "git+https://github.com/Ex-Org/new-home.git",
      "git://github.com/ex-org/new-home.git",
      "git+ssh://git@github.com/ex-org/new-home.git",
      "git@github.com:ex-org/new-home.git",
      { type: "git", url: "https://github.com/ex-org/new-home/" },
      `https://github.com/ex-org/new-home${"/".repeat(100_000)}`,
    ]) {
      expect(repositoryOf(v)).toBe(NEW);
    }
  });

  it("gives null for a field that names no GitHub repository", () => {
    for (const v of [undefined, null, 3, {}, "https://gitlab.com/ex-org/new-home", "not a repository at all"]) expect(repositoryOf(v)).toBeNull();
  });
});

describe("the integrity of a tarball", () => {
  it("agrees with the sha512 entry of an SRI text and ignores the other hashes", () => {
    const bytes = before();
    expect(integrityMatches(bytes, `sha1-abc ${integrityOf(bytes)}`)).toBe(true);
    expect(integrityMatches(bytes, integrityOf(after()))).toBe(false);
    expect(integrityMatches(bytes, "sha1-abc")).toBe(false);
  });
});

describe("the comparison of a move", () => {
  it("passes when only the version and the repository of package.json change", () => {
    const r = compare(after());
    expect(r.faults).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.files).toEqual({ same: 3, changed: [], added: [], removed: [], allowed: [] });
    expect(r.packageJson).toEqual({ changed: [], allowed: ["repository", "version"] });
    expect(r.from).toMatchObject({ version: "0.1.8", repository: OLD });
    expect(r.to).toMatchObject({ version: "0.1.9", repository: NEW, provenance: PROVENANCE });
    expect(r.from.integrity).toBe(integrityOf(before()));
  });

  it("fails on a planted change of one byte and names the file", () => {
    const r = compare(after({ "package/dist/index.js": "export const a = 2;\n" }));
    expect(r.pass).toBe(false);
    expect(r.files.changed).toEqual(["dist/index.js"]);
    expect(r.faults).toEqual(["The bytes of dist/index.js changed."]);
  });

  it("fails on an added file and on a removed file", () => {
    const pkg = manifest("0.1.9", NEW);
    const r = compareMove({
      name: NAME,
      repo: NEW,
      from: { source: "npm", tgz: before(), provenance: null },
      to: { source: "npm", tgz: tgz({ "package/dist/index.js": BASE["package/dist/index.js"], "package/README.md": "# thing\n", "package/dist/extra.js": "x", "package/package.json": pkg }), provenance: PROVENANCE, provenanceChecked: true },
    });
    expect(r.files.added).toEqual(["dist/extra.js"]);
    expect(r.files.removed).toEqual(["dist/index.d.ts"]);
    expect(r.faults).toHaveLength(2);
  });

  it("accepts a changed file only when --allow-file names it, and lists it", () => {
    const changed = after({ "package/README.md": "# thing, in its new home\n" });
    expect(compare(changed).pass).toBe(false);
    const r = compare(changed, { allowFiles: ["README.md"] });
    expect(r.pass).toBe(true);
    expect(r.files.allowed).toEqual(["README.md"]);
  });

  it("fails on a change of another field of package.json, unless --allow-field names it", () => {
    const pkg = manifest("0.1.9", NEW, { main: "./dist/other.js" });
    expect(compare(after({}, pkg)).faults).toEqual(["The field main of package.json changed."]);
    expect(compare(after({}, pkg), { allowFields: ["main"] }).pass).toBe(true);
  });

  it("compares package.json by value, not by the order of its keys", () => {
    const m = JSON.parse(manifest("0.1.9", NEW)) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(m).reverse()));
    expect(compare(after({}, reordered)).pass).toBe(true);
  });

  it("fails when package.json does not name the new repository", () => {
    const r = compare(after({}, manifest("0.1.9", OLD)), { provenance: PROVENANCE });
    expect(r.faults).toEqual([`The repository of the new package.json is ${OLD}, not ${NEW}.`]);
  });

  it("fails when package.json names another package", () => {
    const r = compare(after({}, manifest("0.1.9", NEW, { name: "@ex/other" })));
    expect(r.packageJson.changed).toEqual(["name"]);
    expect(r.faults).toContain("The new package.json names @ex/other, not @ex/thing.");
  });

  it("fails when npm has no provenance of the new release, or a provenance of another repository", () => {
    expect(compare(after(), { provenance: null }).faults).toEqual(["npm has no SLSA provenance of the new release."]);
    expect(compare(after(), { provenance: { repository: `https://github.com/${OLD}`, workflow: "w" } }).faults).toEqual([`The provenance of the new release names ${OLD}, not ${NEW}.`]);
  });

  it("does not check the provenance of a tarball file, and says so", () => {
    const r = compare(after(), { provenance: null, file: true });
    expect(r.pass).toBe(true);
    expect(r.notChecked).toHaveLength(1);
    expect(moveSummary(r)).toContain("not checked: provenance");
  });

  it("gives a summary with the result and each fault", () => {
    const text = moveSummary(compare(after({ "package/dist/index.js": "changed" })));
    expect(text.split("\n")[0]).toBe(`Move of ${NAME} to ${NEW}: FAIL`);
    expect(text).toContain("fault: The bytes of dist/index.js changed.");
  });
});

/** This function makes a fake registry with one version document, tarball and attestation for each entry. */
function registry(entries: Record<string, { tgz: Uint8Array; integrity?: string; repo?: string }>): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchFn = async (url) => {
    urls.push(url);
    const base = "https://reg.example";
    const enc = NAME.replaceAll("/", "%2f");
    for (const [version, e] of Object.entries(entries)) {
      if (url === `${base}/${enc}/${version}`) return Response.json({ dist: { tarball: `${base}/t/${version}.tgz`, integrity: e.integrity ?? integrityOf(e.tgz) } });
      if (url === `${base}/t/${version}.tgz`) return new Response(e.tgz);
      if (url === `${base}/-/npm/v1/attestations/${enc}@${version}` && e.repo) {
        const statement = { predicate: { buildDefinition: { externalParameters: { workflow: { repository: `https://github.com/${e.repo}`, path: ".github/workflows/release.yml" } } } } };
        const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
        return Response.json({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload } } }] });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, urls };
}

describe("the check of a move on a registry", () => {
  it("passes for a release of the new repository with its provenance", async () => {
    const reg = registry({ "0.1.8": { tgz: before(), repo: OLD }, "0.1.9": { tgz: after(), repo: NEW } });
    const r = await moveCheck({ name: NAME, from: "0.1.8", to: "0.1.9", repo: NEW, fetch: reg.fetch, registry: "https://reg.example/" });
    expect(r.faults).toEqual([]);
    expect(r.from.provenance?.repository).toBe(`https://github.com/${OLD}`);
    expect(r.to.provenance?.repository).toBe(`https://github.com/${NEW}`);
  });

  it("gives a repository fault for the same release against the new repository", async () => {
    const reg = registry({ "0.1.8": { tgz: before(), repo: OLD } });
    const same = await moveCheck({ name: NAME, from: "0.1.8", to: "0.1.8", repo: OLD, fetch: reg.fetch, registry: "https://reg.example" });
    expect(same.pass).toBe(true);
    const moved = await moveCheck({ name: NAME, from: "0.1.8", to: "0.1.8", repo: NEW, fetch: reg.fetch, registry: "https://reg.example" });
    expect(moved.faults).toEqual([`The repository of the new package.json is ${OLD}, not ${NEW}.`, `The provenance of the new release names ${OLD}, not ${NEW}.`]);
  });

  it("stops when a tarball does not agree with its integrity", async () => {
    const reg = registry({ "0.1.8": { tgz: before(), integrity: integrityOf(after()) } });
    await expect(moveCheck({ name: NAME, from: "0.1.8", to: "0.1.8", repo: NEW, fetch: reg.fetch, registry: "https://reg.example" })).rejects.toThrow(/does not agree with its integrity/);
  });

  it("stops when npm does not have the version", async () => {
    const reg = registry({});
    await expect(moveCheck({ name: NAME, from: "0.1.8", to: "0.1.9", repo: NEW, fetch: reg.fetch, registry: "https://reg.example" })).rejects.toThrow(/HTTP 404/);
  });

  it("reads a tarball file for the new side and asks npm only for the old side", async () => {
    const reg = registry({ "0.1.8": { tgz: before(), repo: OLD } });
    const file = after();
    const r = await moveCheck({ name: NAME, from: "0.1.8", to: "out/thing-0.1.9.tgz", repo: NEW, fetch: reg.fetch, registry: "https://reg.example", readFile: () => file });
    expect(r.pass).toBe(true);
    expect(r.to.source).toBe("out/thing-0.1.9.tgz");
    expect(reg.urls.some((u) => u.includes("0.1.9"))).toBe(false);
    expect(isTarballPath("0.1.9")).toBe(false);
  });
});

describe("the command move-check", () => {
  it("reads its options", () => {
    const o = parseArgs(["move-check", "--package", NAME, "--from", "0.1.8", "--to", "0.1.9", "--repo", NEW, "--allow-field", "main", "--allow-file", "README.md", "--json"]);
    expect(o).toMatchObject({ command: "move-check", packageName: NAME, from: "0.1.8", to: "0.1.9", repo: NEW, allowFields: ["main"], allowFiles: ["README.md"], json: true });
  });

  it("exits with 2 without an option, 0 on a pass and 1 on a fault", async () => {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
      expect(await runMoveCheck(parseArgs(["move-check", "--package", NAME]))).toBe(2);
      const o = parseArgs(["move-check", "--package", NAME, "--from", "0.1.8", "--to", "0.1.9", "--repo", NEW]);
      expect(await runMoveCheck(o, async () => compare(after()))).toBe(0);
      expect(await runMoveCheck(o, async () => compare(after({ "package/dist/index.js": "x" })))).toBe(1);
      expect(await runMoveCheck(o, async () => Promise.reject(new Error("no network")))).toBe(1);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  });
});
