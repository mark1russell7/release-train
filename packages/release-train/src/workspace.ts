import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import semver from "semver";
import { addChangelogSection, changesetText, decideBump, setManifestVersion, typedFiles } from "./release.ts";
import { ageExcludeAdd, ageRuleEdit, globMatch, ownScopes } from "./settings.ts";
import type { LockChange, ReleaseDone, RepoUpdate, UpdateResult, Updater, YoungItem } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { TRAIN_BRANCH } from "./apply.ts";

/**
 * This function gives the name of the changeset file of an update. The name holds the fingerprint of the update, so a
 * rebuild of the branch writes the same file. A name that the default branch has already (an unreleased changeset of an
 * earlier run) gets a number: the Changesets check of the pull request needs a new file.
 */
export function changesetName(exists: (name: string) => boolean, fingerprint: string): string {
  const base = `release-train-${fingerprint.slice(0, 8)}`;
  let name = `${base}.md`;
  for (let n = 2; exists(name); n++) name = `${base}-${n}.md`;
  return name;
}
import { parseNpmLock, parsePnpmLock } from "./parse.ts";
import { SYNC_BRANCH, syncCommitMessage, syncRepo, workflowsRefused } from "./sync.ts";
import type { RepoFiles, SyncJob, SyncPush, SyncResult, SyncUpdater } from "./sync.ts";
import type { Resolved } from "./types.ts";

/** The result of one command. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The function that starts one command. Tests give a mock. */
export type RunFn = (cmd: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<RunResult>;

const runCommand: RunFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32", timeout: 15 * 60 * 1000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** This function replaces the range in a dependency specifier, also in an `npm:` alias. It gives null when it cannot. */
export function replaceRange(spec: string, range: string, newRange: string): string | null {
  const s = spec.trim();
  if (s === range) return newRange;
  if (s.startsWith("npm:") && s.endsWith(`@${range}`)) return `${s.slice(0, s.length - range.length)}${newRange}`;
  return null;
}

/** This function changes the ranges of the breaking items in the `package.json` text of one folder. It keeps the indent. */
export function editManifest(text: string, edits: readonly { type: string; dep: string; range: string; newRange: string }[]): { text: string; failed: string[] } {
  const m = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const failed: string[] = [];
  for (const e of edits) {
    const section = m[e.type];
    const spec = section?.[e.dep];
    const next = spec === undefined ? null : replaceRange(spec, e.range, e.newRange);
    if (!section || next === null) {
      failed.push(e.dep);
      continue;
    }
    section[e.dep] = next;
  }
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = JSON.stringify(m, null, indent);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (text.endsWith("\n")) out += eol;
  return { text: out, failed };
}

/** This function lists the changes of the resolved versions between two lockfile states. */
export function lockChanges(before: Resolved, after: Resolved, intended: ReadonlySet<string>): LockChange[] {
  const out: LockChange[] = [];
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const path of paths) {
    const b = before[path] ?? {};
    const a = after[path] ?? {};
    for (const dep of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (b[dep] === a[dep]) continue;
      out.push({ path, dep, from: b[dep] ?? null, to: a[dep] ?? null, intended: intended.has(`${path}|${dep}`) });
    }
  }
  return out;
}

/** The minimumReleaseAge policy of pnpm in one repository. */
export interface ReleaseAgePolicy {
  /** The minimum age of a version in minutes. 0 means no policy. */
  minutes: number;
  /** The patterns of `minimumReleaseAgeExclude`, for example `@scope/*` or `name@1.2.3`. */
  exclude: string[];
}

/**
 * This function reads the minimumReleaseAge policy from `pnpm-workspace.yaml` and `.npmrc`.
 * When the files do not set it, pnpm 11 and later use 1440 minutes (1 day), and older versions use 0.
 */
export function releaseAgePolicy(workspaceYaml: string, npmrc: string, pnpmVersion: string): ReleaseAgePolicy {
  const lines = workspaceYaml.split(/\r?\n/);
  const fromYaml = settingOf(lines, "minimumReleaseAge", ":");
  const fromRc = settingOf(npmrc.split(/\r?\n/), "minimum-release-age", "=");
  const major = semver.coerce(pnpmVersion)?.major ?? 0;
  const number = (v: string | null): number | null => (v !== null && /^\d+$/.test(v) ? Number(v) : null);
  const minutes = number(fromYaml) ?? number(fromRc) ?? (major >= 11 ? 1440 : 0);
  const exclude: string[] = [];
  const list = settingOf(lines, "minimumReleaseAgeExclude", ":");
  if (list !== null && list.startsWith("[") && list.endsWith("]")) exclude.push(...list.slice(1, -1).split(","));
  else if (list === "") {
    const start = lines.findIndex((l) => l.trim().startsWith("minimumReleaseAgeExclude"));
    for (const l of lines.slice(start + 1)) {
      const t = l.trim();
      if (t === "" || t.startsWith("#")) continue;
      if (!t.startsWith("-") || (l === l.trimStart() && !t.startsWith("-"))) break;
      const hash = t.indexOf(" #");
      exclude.push(hash >= 0 ? t.slice(1, hash) : t.slice(1));
    }
  }
  return { minutes, exclude: exclude.map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean) };
}

/** This function gives the value of a "key: value" or "key=value" line, or null. */
function settingOf(lines: readonly string[], key: string, sep: string): string | null {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith(key)) continue;
    const rest = line.slice(key.length).trimStart();
    if (rest.startsWith(sep)) return rest.slice(sep.length).trim();
  }
  return null;
}

/** This function tells if a pattern of `minimumReleaseAgeExclude` matches a version of a package. */
export function ageExcluded(patterns: readonly string[], name: string, version: string): boolean {
  return patterns.some((p) => {
    const at = p.indexOf("@", 1);
    const namePart = at > 0 ? p.slice(0, at) : p;
    const versions = at > 0 ? p.slice(at + 1).split("||").map((s) => s.trim()) : null;
    return globMatch(namePart, name) && (versions === null || versions.includes(version));
  });
}

/** The options of the updater that uses git and the package manager of the repository. */
export interface GitUpdaterOptions {
  owner: string;
  token: string;
  author: { name: string; email: string };
  run?: RunFn;
  tmpRoot?: string;
  /** The function that reads the publish times from the npm registry. Tests give a mock. */
  fetch?: FetchFn;
  registry?: string;
  now?: () => number;
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** The package of the shared conventions, and its first version with `conventions fix`. */
export const CONVENTIONS = "@mark1russell7/conventions";
export const FIX_SINCE = "0.8.2";

/** The root script that checks the API reports, and the report of a package when the repository names no other file. */
export const API_SCRIPT = "check:api";
export const API_REPORT = "test/api/public-api.txt";
/** The package of the reports. A new version can change the form of each report. */
export const API_REPORT_PACKAGE = "@mark1russell7/api-report";

function tail(s: string, n = 800): string {
  const t = s.trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

/**
 * This function gives the lines of a tool output that tell a failure. A line that names an error stays. When that
 * line ends with a colon, the indented lines below it stay too, because they hold the reason (`api-report` prints so).
 */
function errorLines(text: string): string[] {
  const kept: string[] = [];
  let heading = false;
  for (const line of text.split("\n")) {
    const named = /error/i.test(line);
    heading = (heading && /^\s+\S/.test(line)) || (named && line.trimEnd().endsWith(":"));
    if (named || heading) kept.push(line);
  }
  return kept;
}

/** This function reads the scripts of a package.json. It gives undefined when the file has none or does not parse. */
function readScripts(file: string): Record<string, unknown> | undefined {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> }).scripts;
  } catch {
    return undefined;
  }
}

/** The lockfiles: the package manager writes them, so the formatter of the repository does not change them. */
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock"]);

/** The result of `conventions fix` in a clone: the files that it changed, and the fix that the train removed because it broke the typecheck. */
interface FixOutcome {
  fixed: string[];
  reverted: string[];
  error: string | null;
  /** The step that failed with the fix, when it is not `typecheck`. */
  step?: string;
}

/**
 * This function makes the updater that works in a shallow clone of each repository. For pnpm, it first sets each range to the
 * exact target version and starts `pnpm install --lockfile-only`. Then it sets each range to its final value and starts the install
 * again and a frozen check. For npm, it uses the npm equivalents. Then it checks the lockfile and pushes one commit to the branch
 * of the train. The token goes to git in the environment, not in a URL.
 */
export function gitUpdater(o: GitUpdaterOptions): Updater & SyncUpdater {
  const run = o.run ?? runCommand;
  const f: FetchFn = o.fetch ?? ((u, i) => fetch(u, i));
  const registry = o.registry ?? "https://registry.npmjs.org";
  const now = o.now ?? Date.now;
  interface Packument {
    time?: Record<string, string>;
    versions?: Record<string, { dist?: { tarball?: string } }>;
  }
  const packuments = new Map<string, Promise<Packument>>();
  /** This function reads the document of a package from the npm registry. It gives an empty document on an error. */
  const packument = (dep: string): Promise<Packument> => {
    const known = packuments.get(dep);
    if (known) return known;
    const p = (async (): Promise<Packument> => {
      try {
        const res = await f(`${registry}/${dep.replaceAll("/", "%2f")}`, { headers: { accept: "application/json" } });
        return res.ok ? ((await res.json()) as Packument) : {};
      } catch {
        return {};
      }
    })();
    packuments.set(dep, p);
    return p;
  };
  const publishTimes = async (dep: string): Promise<Record<string, string>> => (await packument(dep)).time ?? {};
  /** This function reads the typed files of a published version. It gives null when npm does not give them. */
  const publishedTypes = async (name: string, version: string): Promise<Map<string, string> | null> => {
    const url = (await packument(name)).versions?.[version]?.dist?.tarball;
    if (!url) return null;
    try {
      const res = await f(url, {});
      return res.ok ? typedFiles(new Uint8Array(await res.arrayBuffer())) : null;
    } catch {
      return null;
    }
  };
  const basic = Buffer.from(`x-access-token:${o.token}`).toString("base64");
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|_KEY$|^RELEASE_TRAIN_/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });

  type Sh = (cmd: string, args: string[], what: string) => Promise<RunResult>;
  /** This function gives the command helper of one clone folder. It throws on an exit code that is not 0. */
  const shell = (dir: string): Sh => async (cmd, args, what) => {
    const r = await run(cmd, args, { cwd: dir, env });
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`);
    return r;
  };
  /** This function clones the default branch and fetches a branch of the train. It gives the remote ref and if the branch exists. */
  const checkout = async (dir: string, sh: Sh, repo: string, branch: string, defaultBranch: string): Promise<{ remoteRef: string; hasRemote: boolean }> => {
    await sh("git", ["clone", "--quiet", "--depth", "1", "--no-tags", "--branch", defaultBranch, `https://github.com/${o.owner}/${repo}.git`, "."], "git clone");
    const remoteRef = `refs/remotes/origin/${branch}`;
    const fetched = await run("git", ["fetch", "--quiet", "--depth", "2", "origin", `+refs/heads/${branch}:${remoteRef}`], { cwd: dir, env });
    return { remoteRef, hasRemote: fetched.code === 0 };
  };
  /** This function pushes the commit to a branch. When the branch already has the same content in the changed files, it does not push. */
  const pushHead = async (dir: string, sh: Sh, branch: string, remote: { remoteRef: string; hasRemote: boolean }, rebuild: boolean): Promise<{ status: "same" | "pushed"; sha: string }> => {
    const { remoteRef, hasRemote } = remote;
    const head = (await sh("git", ["rev-parse", "HEAD"], "git rev-parse")).stdout.trim();
    if (hasRemote && !rebuild) {
      const ours = (await sh("git", ["diff", "--name-only", "HEAD~1", "HEAD"], "git diff")).stdout.split("\n");
      const theirs = (await run("git", ["diff", "--name-only", `${remoteRef}~1`, remoteRef], { cwd: dir, env })).stdout.split("\n");
      const files = [...new Set([...ours, ...theirs].map((f) => f.trim()).filter(Boolean))];
      const same = await run("git", ["diff", "--quiet", remoteRef, "HEAD", "--", ...files], { cwd: dir, env });
      if (same.code === 0) return { status: "same", sha: (await sh("git", ["rev-parse", remoteRef], "git rev-parse")).stdout.trim() };
    }
    await sh("git", ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`], "git push");
    return { status: "pushed", sha: head };
  };

  /**
   * This function starts `conventions fix` of the target version, when the update moves the repository to a version that
   * has the command. It gives the changed files. A break that stays does not stop the update: CI of the pull request shows it.
   * The rules read the repository from GITHUB_REPOSITORY, so it names the repository of the clone, not the train.
   * The rule typed-files reads the tsconfig files with the typescript of the repository, so the packages are installed
   * first, with no install scripts. The install and the fix get no git credentials: they need none.
   *
   * A fix can break the build of a repository that its tests did not know (conventions 0.12.0: TS6059 and TS9037). So
   * when the repository has a `typecheck` script, the function starts it after the fix. When it fails, the function
   * starts it again without the fix. When it then passes, the fix caused the failure: the function removes the fix and
   * gives the files in `reverted`, with the first error lines. Else the failure is not from the fix, and the fix stays.
   *
   * A fix can add the script `check:api`. That script fails until the repository has its reports.
   * So the function writes the first reports in the same commit. It updates the lockfile, builds and starts `api-report update`. When a step
   * fails, the root `package.json` and the lockfile go back. Thus an update cannot add the script without its reports.
   * The build follows CI: the root script when the repository has one, else the script of each package.
   */
  /** This function gives the steps that write the API reports: the lockfile, the install, the build as CI does it, and `api-report update`. */
  const reportSteps = (dir: string, u: RepoUpdate): readonly (readonly [string, readonly string[]])[] => {
    const manifest = join(dir, "package.json");
    const npm = u.lockKind === "npm";
    const quiet = ["--ignore-scripts", "--no-audit", "--no-fund"];
    const workspaces = (JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown }).workspaces !== undefined;
    const eachBuild: readonly (readonly [string, readonly string[]])[] = npm ? (workspaces ? [["npm", ["run", "build", "--workspaces", "--if-present"]]] : []) : [["pnpm", ["-r", "--if-present", "run", "build"]]];
    return [
      npm ? ["npm", ["install", "--package-lock-only", ...quiet]] : ["pnpm", ["install", "--lockfile-only"]],
      npm ? ["npm", ["ci", ...quiet]] : ["pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]],
      ...(typeof readScripts(manifest)?.["build"] === "string" ? [[npm ? "npm" : "pnpm", ["run", "build"]] as const] : eachBuild),
      npm ? ["npm", ["exec", "--", "api-report", "update"]] : ["pnpm", ["exec", "api-report", "update"]],
    ];
  };

  /** This function gives the path of a report inside a package: the file that the repository names, or the default. */
  const reportFile = (manifest: string): string => {
    const config = (JSON.parse(readFileSync(manifest, "utf8")) as { apiReport?: { report?: unknown } }).apiReport?.report;
    return typeof config === "string" ? config.replace(/^\.\//, "") : API_REPORT;
  };

  /**
   * A new version of `api-report` can change the form of each report, and then `check:api` fails with no change to the API.
   * So an update that moves the tool in a repository with the script writes the reports in the same commit. The default branch
   * passed `check:api` with the old tool, so a difference in the commit comes from the tool. When a step fails, the update
   * stays and the function gives the reason. Then `check:api` is red on the pull request, and its body tells the step.
   */
  const reportUpdate = async (dir: string, u: RepoUpdate, fixEnv: NodeJS.ProcessEnv, fixed: readonly string[]): Promise<{ reports: string[]; error: string | null; step?: string }> => {
    const manifest = join(dir, "package.json");
    if (!u.items.some((i) => i.dep === API_REPORT_PACKAGE) || typeof readScripts(manifest)?.[API_SCRIPT] !== "string") return { reports: [], error: null };
    const report = reportFile(manifest);
    const isReport = (file: string): boolean => file === report || file.endsWith(`/${report}`);
    // The fix wrote the first reports after the lockfile moved, so they have the new form.
    if (fixed.some(isReport)) return { reports: [], error: null };
    for (const [cmd, args] of reportSteps(dir, u)) {
      const result = await run(cmd, [...args], { cwd: dir, env: fixEnv });
      if (result.code !== 0) {
        const error = errorLines(`${result.stdout}\n${result.stderr}`).slice(0, 5).join("\n");
        return { reports: [], error: error === "" ? tail(result.stdout || result.stderr, 500) : error, step: `${cmd} ${args.join(" ")}` };
      }
    }
    const listed = await run("git", ["ls-files", "--modified", "--others", "--exclude-standard"], { cwd: dir, env: fixEnv });
    return { reports: listed.stdout.split("\n").filter(isReport), error: null };
  };

  const conventionsFix = async (dir: string, u: RepoUpdate, fixEnv: NodeJS.ProcessEnv, install: () => Promise<void>): Promise<FixOutcome> => {
    const none: FixOutcome = { fixed: [], reverted: [], error: null };
    const to = u.items.find((i) => i.dep === CONVENTIONS)?.to;
    if (to === undefined || semver.valid(to) === null || semver.lt(to, FIX_SINCE)) return none;
    const manifest = join(dir, "package.json");
    const hadApiCheck = typeof readScripts(manifest)?.[API_SCRIPT] === "string";
    await install();
    // The tree of the files before the fix, from a separate index, so the index of the clone does not change
    const snapshot = async (): Promise<string | null> => {
      const index = join(dir, ".git", "rt-fix-index");
      rmSync(index, { force: true });
      const indexEnv = { ...fixEnv, GIT_INDEX_FILE: index };
      const added = await run("git", ["add", "-A"], { cwd: dir, env: indexEnv });
      const tree = added.code === 0 ? await run("git", ["write-tree"], { cwd: dir, env: indexEnv }) : added;
      rmSync(index, { force: true });
      return tree.code === 0 ? tree.stdout.trim() : null;
    };
    const restore = async (tree: string, files: readonly string[]): Promise<void> => {
      for (const file of files) {
        const shown = await run("git", ["show", `${tree}:${file}`], { cwd: dir, env: fixEnv });
        if (shown.code === 0) writeFileSync(join(dir, file), shown.stdout);
        else rmSync(join(dir, file), { force: true });
      }
    };
    const before = await snapshot();
    const args = [`${CONVENTIONS}@${to}`, "fix", "--json"];
    const r = u.lockKind === "npm" ? await run("npx", ["--yes", ...args], { cwd: dir, env: fixEnv }) : await run("pnpm", ["dlx", ...args], { cwd: dir, env: fixEnv });
    let fixed: string[];
    try {
      const changed = (JSON.parse(r.stdout) as { changed?: unknown }).changed;
      fixed = Array.isArray(changed) ? changed.filter((file): file is string => typeof file === "string") : [];
    } catch {
      return none;
    }
    const firstLines = (result: RunResult): string => {
      const error = errorLines(`${result.stdout}\n${result.stderr}`).slice(0, 5).join("\n");
      return error === "" ? tail(result.stdout || result.stderr, 500) : error;
    };
    const scripts = readScripts(manifest);
    /** This function keeps the fix when the typecheck passes, or when the fix is not the cause. */
    const typechecked = async (): Promise<FixOutcome> => {
      if (fixed.length === 0 || before === null || typeof scripts?.["typecheck"] !== "string") return { ...none, fixed };
      const typecheck = (): Promise<RunResult> => run(u.lockKind === "npm" ? "npm" : "pnpm", ["run", "typecheck"], { cwd: dir, env: fixEnv });
      const withFix = await typecheck();
      if (withFix.code === 0) return { ...none, fixed };
      const after = await snapshot();
      await restore(before, fixed);
      if ((await typecheck()).code !== 0 && after !== null) {
        await restore(after, fixed);
        return { ...none, fixed };
      }
      return { fixed: [], reverted: fixed, error: firstLines(withFix) };
    };
    const outcome = await typechecked();
    if (hadApiCheck || before === null || typeof readScripts(manifest)?.[API_SCRIPT] !== "string") return outcome;
    const npm = u.lockKind === "npm";
    const steps = reportSteps(dir, u);
    const untracked = async (): Promise<string[]> => {
      const listed = await run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: dir, env: fixEnv });
      return listed.stdout.split("\n").filter((file) => file !== "");
    };
    const known = new Set(await untracked());
    const failed = async (name: string, result: RunResult): Promise<FixOutcome> => {
      const lockfile = npm ? "package-lock.json" : "pnpm-lock.yaml";
      await restore(before, ["package.json", lockfile]);
      for (const file of await untracked()) if (!known.has(file)) rmSync(join(dir, file), { force: true });
      return { fixed: outcome.fixed.filter((file) => file !== "package.json"), reverted: ["package.json"], error: firstLines(result), step: name };
    };
    for (const [cmd, args] of steps) {
      const result = await run(cmd, [...args], { cwd: dir, env: fixEnv });
      if (result.code !== 0) return failed(`the first API report (${cmd} ${args.join(" ")})`, result);
    }
    const report = reportFile(manifest);
    const reports = (await untracked()).filter((file) => !known.has(file) && (file === report || file.endsWith(`/${report}`)));
    return { ...outcome, fixed: [...new Set([...outcome.fixed, ...reports])] };
  };

  /** The environment of a script of the repository: no git credentials, no step summary, and the repository of the clone in GITHUB_REPOSITORY. */
  const scriptEnv = (repo: string): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...env, GITHUB_REPOSITORY: `${o.owner}/${repo}` };
    for (const key of Object.keys(e)) if (key.startsWith("GIT_CONFIG_")) delete e[key];
    delete e["GITHUB_STEP_SUMMARY"];
    return e;
  };

  /** This function gives the install of one clone: the packages with no install scripts, at most one time. */
  const installer = (dir: string, u: RepoUpdate, e: NodeJS.ProcessEnv): (() => Promise<void>) => {
    let done: Promise<void> | null = null;
    return () =>
      (done ??= (async () => {
        if (u.lockKind === "npm") await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, env: e });
        else await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: dir, env: e });
      })());
  };

  /**
   * This function starts the `version` script of each package that got a new version, as `npm version` does. There a
   * repository keeps the other copies of its version in step. Examples are a `VERSION` constant, an API report, a registry
   * entry and the version of a package that releases with it. In crawler (11-02), a test compared the constant with package.json, and the
   * train changed only package.json. The function gives the folders of the scripts that ran, or the first error.
   */
  const versionScripts = async (dir: string, u: RepoUpdate, paths: readonly string[], e: NodeJS.ProcessEnv, install: () => Promise<void>): Promise<{ ran: string[]; error: string | null }> => {
    const ran: string[] = [];
    for (const path of paths) {
      if (typeof readScripts(join(dir, path, "package.json"))?.["version"] !== "string") continue;
      await install();
      const r = await run(u.lockKind === "npm" ? "npm" : "pnpm", ["run", "version"], { cwd: join(dir, path), env: e });
      if (r.code !== 0) return { ran, error: `The version script of ${path || "."}/package.json failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}` };
      ran.push(path || ".");
    }
    return { ran, error: null };
  };

  /**
   * This function gives each file that the train changed the format of the repository, when the repository uses Prettier, so
   * its format check passes (crawler, 11-02: a line that conventions fix wrote was longer than the print width). Prettier reads
   * the configuration and the ignore file of the repository. The lockfiles do not change.
   */
  const formatChanged = async (dir: string, u: RepoUpdate, extra: readonly string[], e: NodeJS.ProcessEnv, install: () => Promise<void>): Promise<void> => {
    let manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof manifest;
    } catch {
      return;
    }
    if (manifest.devDependencies?.["prettier"] === undefined && manifest.dependencies?.["prettier"] === undefined) return;
    const changed = (await run("git", ["diff", "--name-only"], { cwd: dir, env: e })).stdout.split("\n");
    const files = [...new Set([...changed, ...extra].map((f) => f.trim()))].filter((f) => f !== "" && !LOCKFILES.has(basename(f)) && existsSync(join(dir, f)));
    if (files.length === 0) return;
    await install();
    const args = ["prettier", "--write", "--ignore-unknown", "--", ...files];
    await run(u.lockKind === "npm" ? "npx" : "pnpm", u.lockKind === "npm" ? ["--no-install", ...args] : ["exec", ...args], { cwd: dir, env: e });
  };

  return {
    async update(u0: RepoUpdate, ctx: { defaultBranch: string; rebuild: boolean }): Promise<UpdateResult> {
      const dir = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "rt-"));
      const fail = (error: string): UpdateResult => ({ status: "failed", sha: null, changes: [], unresolved: [], young: [], tool: null, error });
      const sh = shell(dir);
      try {
        const remote = await checkout(dir, sh, u0.repo, TRAIN_BRANCH, ctx.defaultBranch);

        // 0. The minimumReleaseAge of pnpm: CI refuses a lockfile with a younger version. Such an item waits.
        let tool: string | null = null;
        const youngBy = new Map<string, YoungItem>();
        const urgentAge = new Set<string>();
        // The scopes of the owner go into minimumReleaseAgeExclude first, so the check below reads the new settings.
        let settingsChanged = false;
        let newSettingsFile = false;
        const wsFile = join(dir, "pnpm-workspace.yaml");
        if (u0.lockKind === "pnpm" && u0.ageScopes && u0.ageScopes.length > 0) {
          const existed = existsSync(wsFile);
          const e = ageRuleEdit(existed ? readFileSync(wsFile, "utf8") : null, u0.ageScopes);
          if (e.changed) {
            writeFileSync(wsFile, e.text);
            settingsChanged = true;
            newSettingsFile = !existed;
          }
        }
        if (u0.lockKind === "pnpm") {
          const v = (await run("pnpm", ["--version"], { cwd: dir, env })).stdout.trim();
          tool = `pnpm ${v || "?"}`;
          const policy = releaseAgePolicy(readText(join(dir, "pnpm-workspace.yaml")), readText(join(dir, ".npmrc")), v);
          if (policy.minutes > 0) {
            for (const dep of [...new Set(u0.items.map((i) => i.dep))]) {
              const times = await publishTimes(dep);
              for (const i of u0.items.filter((x) => x.dep === dep)) {
                const t = Date.parse(times[i.to] ?? "");
                if (Number.isNaN(t) || ageExcluded(policy.exclude, dep, i.to)) continue;
                const readyAt = t + policy.minutes * 60_000;
                if (readyAt <= now()) continue;
                if (u0.urgentDeps?.includes(dep)) urgentAge.add(`${dep}@${i.to}`);
                else youngBy.set(dep, { dep, version: i.to, readyAt: new Date(readyAt).toISOString() });
              }
            }
          }
        }
        // A person named these versions as urgent. Only the exact version passes the age rule, in this repository.
        if (urgentAge.size > 0) {
          const existed = existsSync(wsFile);
          writeFileSync(wsFile, ageExcludeAdd(existed ? readFileSync(wsFile, "utf8") : null, ownScopes(o.owner), [...urgentAge].sort()));
          settingsChanged = true;
          newSettingsFile ||= !existed;
        }
        const young = [...youngBy.values()];
        const u: RepoUpdate = { ...u0, items: u0.items.filter((i) => !youngBy.has(i.dep)) };
        if (u.items.length === 0 && !settingsChanged) return { status: "young", sha: null, changes: [], unresolved: [], young, tool, error: null };

        // The cascade: each published package with a breaking range change gets its version bump in the same commit.
        // The public types decide the release type. A repository with changesets gets a changeset, else a new version.
        const added: string[] = newSettingsFile ? ["pnpm-workspace.yaml"] : [];
        const releases: ReleaseDone[] = [];
        const bumped: string[] = [];
        const rels = (u.releases ?? [])
          .map((r) => ({ ...r, changes: r.changes.filter((c) => u.items.some((i) => i.dep === c.dep)) }))
          .filter((r) => r.changes.length > 0);
        if (rels.length > 0) {
          const viaChangeset = existsSync(join(dir, ".changeset", "config.json"));
          for (const r of rels) {
            const d = decideBump({ from: r.from, files: await publishedTypes(r.name, r.from), changes: r.changes });
            const file = join(dir, r.path, "package.json");
            // A version on main that is already as high as the new version stays: it holds the change already.
            const current = viaChangeset ? null : ((JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version ?? null);
            const keep = typeof current === "string" && semver.valid(current) !== null && semver.gte(current, d.to);
            releases.push({ name: r.name, from: r.from, to: keep ? (current as string) : d.to, type: d.type, why: d.why, via: viaChangeset ? "changeset" : "version" });
            if (!viaChangeset && !keep) {
              const text = setManifestVersion(readFileSync(file, "utf8"), d.to);
              if (text === null) return fail(`${r.path || "."}/package.json has no version field.`);
              writeFileSync(file, text);
              bumped.push(r.path);
              // Each version has its section. The owner can add text to the section before the merge.
              const log = join(dir, r.path, "CHANGELOG.md");
              if (existsSync(log)) {
                const ranges = r.changes.map((c) => `\`${c.dep}\``).join(", ");
                const section = addChangelogSection(readFileSync(log, "utf8"), d.to, `The release train changes the range of ${ranges} to a version outside the old range. ${d.why}`);
                if (section !== null) writeFileSync(log, section);
              }
            }
          }
          if (viaChangeset) {
            const deps = [...new Set(rels.flatMap((r) => r.changes.map((c) => c.dep)))];
            const summary = `The release train: the ranges of ${deps.join(", ")} change to a version outside the old range.`;
            const name = changesetName((n) => existsSync(join(dir, ".changeset", n)), u.fingerprint);
            writeFileSync(join(dir, ".changeset", name), changesetText(releases, summary));
            added.push(`.changeset/${name}`);
          }
        }

        // 1. The lockfile and the ranges. The package manager of the repository makes the lockfile.
        const lockFile = u.lockKind === "pnpm" ? "pnpm-lock.yaml" : u.lockKind === "npm" ? "package-lock.json" : null;
        const paths = [...new Set(u.items.map((i) => i.path))];
        const names = [...new Set(u.items.map((i) => i.dep))];
        const read = (): Resolved => {
          if (!lockFile || !existsSync(join(dir, lockFile))) return {};
          const text = readFileSync(join(dir, lockFile), "utf8");
          return u.lockKind === "pnpm" ? parsePnpmLock(text) : parseNpmLock(text, paths, names);
        };
        const before = read();
        /** This function changes ranges in the manifests. It gives the "path|dep" keys that it could not change. */
        const editAll = (edits: readonly { path: string; type: string; dep: string; range: string; newRange: string }[]): Set<string> => {
          const failed = new Set<string>();
          for (const path of [...new Set(edits.map((e) => e.path))]) {
            const file = join(dir, path, "package.json");
            const r = editManifest(readFileSync(file, "utf8"), edits.filter((e) => e.path === path));
            for (const d of r.failed) failed.add(`${path}|${d}`);
            writeFileSync(file, r.text);
          }
          return failed;
        };
        const notPlanRange = (keys: Iterable<string>): string =>
          `The range of ${[...keys].map((k) => `${k.split("|")[1]} in ${k.split("|")[0] || "."}/package.json`).join(", ")} is not the range of the plan.`;
        const breaking = u.items.filter((i) => i.newRange);
        const inRange = [...new Set(u.items.filter((i) => !i.newRange).map((i) => i.dep))];
        if (u.lockKind === "pnpm") {
          // First each range gets the exact target version, so pnpm resolves only these packages, to the version of the plan.
          // Then each range gets its final value, and pnpm keeps the locked version. `pnpm update` also updates the
          // dependencies of each package, so the train uses it only for a range that it cannot change (for example `catalog:`).
          const failed = editAll(u.items.map((i) => ({ path: i.path, type: i.type, dep: i.dep, range: i.range, newRange: i.to })));
          const failedBreaking = breaking.filter((i) => failed.has(`${i.path}|${i.dep}`)).map((i) => `${i.path}|${i.dep}`);
          if (failedBreaking.length > 0) return fail(notPlanRange(failedBreaking));
          await sh("pnpm", ["install", "--lockfile-only"], "pnpm install --lockfile-only");
          const done = u.items.filter((i) => !failed.has(`${i.path}|${i.dep}`));
          editAll(done.map((i) => ({ path: i.path, type: i.type, dep: i.dep, range: i.to, newRange: i.newRange ?? i.range })));
          const rest = [...new Set(u.items.filter((i) => failed.has(`${i.path}|${i.dep}`)).map((i) => `${i.dep}@${i.to}`))];
          if (rest.length > 0) {
            const recursive = existsSync(join(dir, "pnpm-workspace.yaml")) ? ["-r"] : [];
            await sh("pnpm", ["update", ...recursive, "--lockfile-only", "--no-save", ...rest], "pnpm update --lockfile-only");
          }
          await sh("pnpm", ["install", "--lockfile-only"], "pnpm install --lockfile-only");
          // The frozen check must pass, as in CI.
          await sh("pnpm", ["install", "--lockfile-only", "--frozen-lockfile"], "pnpm install --frozen-lockfile");
        } else if (u.lockKind === "npm") {
          const v = await run("npm", ["--version"], { cwd: dir, env });
          tool = `npm ${v.stdout.trim() || "?"}`;
          const failed = editAll(breaking.map((i) => ({ path: i.path, type: i.type, dep: i.dep, range: i.range, newRange: i.newRange ?? i.range })));
          if (failed.size > 0) return fail(notPlanRange(failed));
          const quiet = ["--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
          if (breaking.length > 0) await sh("npm", ["install", ...quiet], "npm install --package-lock-only");
          if (inRange.length > 0) await sh("npm", ["update", ...quiet, ...inRange], "npm update --package-lock-only");
        } else {
          const failed = editAll(breaking.map((i) => ({ path: i.path, type: i.type, dep: i.dep, range: i.range, newRange: i.newRange ?? i.range })));
          if (failed.size > 0) return fail(notPlanRange(failed));
        }
        // 2. The version script of each package with a new version. A script can change the version of another package of
        // the workspace, so the lockfile gets the new versions.
        const fixEnv = scriptEnv(u.repo);
        const install = installer(dir, u, fixEnv);
        const hooks = await versionScripts(dir, u, bumped, fixEnv, install);
        if (hooks.error !== null) return fail(hooks.error);
        if (hooks.ran.length > 0 && u.lockKind === "pnpm") await sh("pnpm", ["install", "--lockfile-only"], "pnpm install --lockfile-only");
        if (hooks.ran.length > 0 && u.lockKind === "npm") await sh("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], "npm install --package-lock-only");

        // 3. A new version of conventions brings the fixes of its rules. The train writes them in the same commit, so a new
        // rule does not block the update for a break that a script can fix. CI of the pull request checks the result.
        const { fixed, reverted, error: fixError, step: fixStep } = await conventionsFix(dir, u, fixEnv, install);
        const { reports: apiReports, error: apiReportError, step: apiReportStep } = await reportUpdate(dir, u, fixEnv, fixed);
        // 4. The files that the train wrote get the format of the repository.
        await formatChanged(dir, u, added, fixEnv, install);
        const after = read();

        // 5. The check: each item must have its target version in the lockfile.
        const unresolved = lockFile
          ? [...new Set(u.items.filter((i) => {
              const v = after[i.path]?.[i.dep];
              return !(v && semver.valid(v) && semver.gte(v, i.to));
            }).map((i) => i.dep))]
          : [];
        const changes = lockChanges(before, after, new Set(u.items.map((i) => `${i.path}|${i.dep}`)));
        const status = await sh("git", ["status", "--porcelain"], "git status");
        if (status.stdout.trim() === "" && unresolved.length === 0) return { status: "no-change", sha: null, changes, unresolved, young, tool, error: null, releases };
        if (status.stdout.trim() === "" || (lockFile && names.length > 0 && unresolved.length === names.length)) return { status: "unresolved", sha: null, changes, unresolved, young, tool, error: null, releases };

        // 6. One commit on the newest default branch.
        const subject = names.length === 0
          ? "chore(pnpm): no release age wait for the packages of the owner"
          : `chore(deps): release train update of ${names.length === 1 ? names[0] : `${names.length} packages`}`;
        const msg = [
          subject,
          "",
          ...u.items.map((i) => `- ${i.dep} in ${i.path || "."}: ${i.newRange ? `${i.range} -> ${i.newRange}` : i.range}, lockfile -> ${after[i.path]?.[i.dep] ?? i.to}`),
          ...releases.map((r) => `- release ${r.name}: ${r.from} -> ${r.to} (${r.type}, ${r.via === "changeset" ? "changeset" : "package.json"})`),
          ...(hooks.ran.length > 0 ? [`- version script: ${hooks.ran.map((p) => `${p}/package.json`).join(", ")}`] : []),
          ...(settingsChanged ? [`- pnpm-workspace.yaml: ${[...(u.ageScopes ?? []), ...urgentAge].join(", ")} in minimumReleaseAgeExclude`] : []),
          ...(fixed.length > 0 ? [`- conventions fix: ${fixed.join(", ")}`] : []),
          ...(reverted.length > 0 ? [`- conventions fix removed, it broke ${fixStep ?? "typecheck"}: ${reverted.join(", ")}`] : []),
          ...(apiReports.length > 0 ? [`- api-report update: ${apiReports.length} ${apiReports.length === 1 ? "report" : "reports"}`] : []),
          ...(apiReportError !== null ? [`- api-report update did not finish, it failed at ${apiReportStep ?? "a step"}`] : []),
        ].join("\n");
        await sh("git", ["add", "-u"], "git add");
        if (added.length > 0) await sh("git", ["add", "--", ...added], "git add");
        // A fix can write a new file (license-file writes LICENSE). `git add -u` does not see a new file, so the train
        // stages each file of the fix by name. With -A, a file that the fix removed is staged as removed (packing #232, 11-03).
        if (fixed.length > 0) await sh("git", ["add", "-A", "--", ...fixed], "git add");
        if (apiReports.length > 0) await sh("git", ["add", "-A", "--", ...apiReports], "git add");
        await sh("git", ["-c", `user.name=${o.author.name}`, "-c", `user.email=${o.author.email}`, "commit", "--quiet", "--no-verify", "-m", msg], "git commit");

        // 7. No push when the branch already has the same content in the files of the train.
        const pushed = await pushHead(dir, sh, TRAIN_BRANCH, remote, ctx.rebuild);
        return { status: pushed.status, sha: pushed.sha, changes, unresolved, young, tool, error: null, releases, ...(urgentAge.size > 0 ? { urgentAge: [...urgentAge].sort() } : {}), ...(fixed.length > 0 ? { fixed } : {}), ...(reverted.length > 0 ? { reverted, fixError, ...(fixStep === undefined ? {} : { fixStep }) } : {}), ...(apiReports.length > 0 ? { apiReports } : {}), ...(apiReportError !== null ? { apiReportError, ...(apiReportStep === undefined ? {} : { apiReportStep }) } : {}) };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    /**
     * The template sync: this function applies the sync rules to the files of a clone. When a rule asks for it, the package
     * manager of the repository updates the lockfile. Then the function pushes one commit to the sync branch.
     */
    async sync(job: SyncJob, ctx: { defaultBranch: string; rebuild: boolean }): Promise<SyncPush> {
      const dir = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "rt-"));
      const sh = shell(dir);
      let result: SyncResult | null = null;
      let tool: string | null = null;
      try {
        const remote = await checkout(dir, sh, job.repo, SYNC_BRANCH, ctx.defaultBranch);
        const paths = (await sh("git", ["ls-files", "-z"], "git ls-files")).stdout.split("\0").filter(Boolean);
        const files: RepoFiles = { paths, read: async (p) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null) };
        result = await syncRepo(files, job.facts, job.rules, job.workflows);
        for (const r of result.removes) rmSync(join(dir, r), { recursive: true, force: true });
        for (const [p, text] of Object.entries(result.writes)) {
          mkdirSync(dirname(join(dir, p)), { recursive: true });
          writeFileSync(join(dir, p), text);
        }
        if (result.install && existsSync(join(dir, "pnpm-lock.yaml"))) {
          tool = `pnpm ${(await run("pnpm", ["--version"], { cwd: dir, env })).stdout.trim() || "?"}`;
          await sh("pnpm", ["install", "--lockfile-only"], "pnpm install --lockfile-only");
          await sh("pnpm", ["install", "--lockfile-only", "--frozen-lockfile"], "pnpm install --frozen-lockfile");
        } else if (result.install && existsSync(join(dir, "package-lock.json"))) {
          tool = `npm ${(await run("npm", ["--version"], { cwd: dir, env })).stdout.trim() || "?"}`;
          await sh("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], "npm install --package-lock-only");
        }
        const status = await sh("git", ["status", "--porcelain"], "git status");
        if (status.stdout.trim() === "") return { status: "no-change", sha: null, result, tool, error: null };
        await sh("git", ["add", "-A"], "git add");
        await sh("git", ["-c", `user.name=${o.author.name}`, "-c", `user.email=${o.author.email}`, "commit", "--quiet", "--no-verify", "-m", syncCommitMessage(result)], "git commit");
        const pushed = await pushHead(dir, sh, SYNC_BRANCH, remote, ctx.rebuild);
        return { status: pushed.status, sha: pushed.sha, result, tool, error: null };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return { status: workflowsRefused(error) ? "workflows-denied" : "failed", sha: null, result, tool, error };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
