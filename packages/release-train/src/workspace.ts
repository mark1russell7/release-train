import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import semver from "semver";
import { changesetText, decideBump, setManifestVersion, typedFiles } from "./release.ts";
import { ageRuleEdit, globMatch } from "./settings.ts";
import type { LockChange, ReleaseDone, RepoUpdate, UpdateResult, Updater, YoungItem } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { TRAIN_BRANCH } from "./apply.ts";
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

function tail(s: string, n = 800): string {
  const t = s.trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
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
                if (readyAt > now()) youngBy.set(dep, { dep, version: i.to, readyAt: new Date(readyAt).toISOString() });
              }
            }
          }
        }
        const young = [...youngBy.values()];
        const u: RepoUpdate = { ...u0, items: u0.items.filter((i) => !youngBy.has(i.dep)) };
        if (u.items.length === 0 && !settingsChanged) return { status: "young", sha: null, changes: [], unresolved: [], young, tool, error: null };

        // The cascade: each published package with a breaking range change gets its version bump in the same commit.
        // The public types decide the release type. A repository with changesets gets a changeset, else a new version.
        const added: string[] = newSettingsFile ? ["pnpm-workspace.yaml"] : [];
        const releases: ReleaseDone[] = [];
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
            }
          }
          if (viaChangeset) {
            const deps = [...new Set(rels.flatMap((r) => r.changes.map((c) => c.dep)))];
            const summary = `The release train: the ranges of ${deps.join(", ")} change to a version outside the old range.`;
            writeFileSync(join(dir, ".changeset", "release-train-cascade.md"), changesetText(releases, summary));
            added.push(".changeset/release-train-cascade.md");
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
        const after = read();

        // 3. The check: each item must have its target version in the lockfile.
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

        // 4. One commit on the newest default branch.
        const subject = names.length === 0
          ? "chore(pnpm): no release age wait for the packages of the owner"
          : `chore(deps): release train update of ${names.length === 1 ? names[0] : `${names.length} packages`}`;
        const msg = [
          subject,
          "",
          ...u.items.map((i) => `- ${i.dep} in ${i.path || "."}: ${i.newRange ? `${i.range} -> ${i.newRange}` : i.range}, lockfile -> ${after[i.path]?.[i.dep] ?? i.to}`),
          ...releases.map((r) => `- release ${r.name}: ${r.from} -> ${r.to} (${r.type}, ${r.via === "changeset" ? "changeset" : "package.json"})`),
          ...(settingsChanged ? [`- pnpm-workspace.yaml: ${(u.ageScopes ?? []).join(", ")} in minimumReleaseAgeExclude`] : []),
        ].join("\n");
        await sh("git", ["add", "-u"], "git add");
        if (added.length > 0) await sh("git", ["add", "--", ...added], "git add");
        await sh("git", ["-c", `user.name=${o.author.name}`, "-c", `user.email=${o.author.email}`, "commit", "--quiet", "--no-verify", "-m", msg], "git commit");

        // 5. No push when the branch already has the same content in the files of the train.
        const pushed = await pushHead(dir, sh, TRAIN_BRANCH, remote, ctx.rebuild);
        return { status: pushed.status, sha: pushed.sha, changes, unresolved, young, tool, error: null, releases };
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
