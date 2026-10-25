import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import type { LockChange, RepoUpdate, UpdateResult, Updater, YoungItem } from "./apply.ts";
import type { FetchFn } from "./collect.ts";
import { TRAIN_BRANCH } from "./apply.ts";
import { parseNpmLock, parsePnpmLock } from "./parse.ts";
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
  const fromYaml = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(workspaceYaml)?.[1];
  const fromRc = /^\s*minimum-release-age\s*=\s*(\d+)\s*$/m.exec(npmrc)?.[1];
  const major = semver.coerce(pnpmVersion)?.major ?? 0;
  const minutes = Number(fromYaml ?? fromRc ?? (major >= 11 ? 1440 : 0));
  const exclude: string[] = [];
  const lines = workspaceYaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^minimumReleaseAgeExclude:/.test(l));
  if (start >= 0) {
    const inline = /^minimumReleaseAgeExclude:\s*\[(.*)\]\s*$/.exec(lines[start] ?? "")?.[1];
    if (inline !== undefined) exclude.push(...inline.split(",").map((s) => s.trim()));
    else {
      for (const l of lines.slice(start + 1)) {
        const m = /^\s+-\s*(.+?)\s*$/.exec(l);
        if (!m) break;
        exclude.push(m[1] ?? "");
      }
    }
  }
  return { minutes, exclude: exclude.map((s) => s.replace(/^["']|["']$/g, "")).filter(Boolean) };
}

/** This function tells if a pattern of `minimumReleaseAgeExclude` matches a version of a package. */
export function ageExcluded(patterns: readonly string[], name: string, version: string): boolean {
  return patterns.some((p) => {
    const at = p.indexOf("@", 1);
    const namePart = at > 0 ? p.slice(0, at) : p;
    const versions = at > 0 ? p.slice(at + 1).split("||").map((s) => s.trim()) : null;
    const re = new RegExp(`^${namePart.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
    return re.test(name) && (versions === null || versions.includes(version));
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
 * This function makes the updater that works in a shallow clone of each repository. It changes the ranges and starts
 * `pnpm update --lockfile-only --no-save <dep>@<version>`, `pnpm install --lockfile-only` and a frozen check (or the npm equivalents).
 * Then it checks the lockfile and pushes one commit to the branch of the train. The token goes to git in the environment, not in a URL.
 */
export function gitUpdater(o: GitUpdaterOptions): Updater {
  const run = o.run ?? runCommand;
  const f: FetchFn = o.fetch ?? ((u, i) => fetch(u, i));
  const registry = o.registry ?? "https://registry.npmjs.org";
  const now = o.now ?? Date.now;
  const publishTimes = async (dep: string): Promise<Record<string, string>> => {
    try {
      const res = await f(`${registry}/${dep.replace("/", "%2f")}`, { headers: { accept: "application/json" } });
      if (!res.ok) return {};
      return ((await res.json()) as { time?: Record<string, string> }).time ?? {};
    } catch {
      return {};
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

  return {
    async update(u0: RepoUpdate, ctx: { defaultBranch: string; rebuild: boolean }): Promise<UpdateResult> {
      const dir = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "rt-"));
      const fail = (error: string): UpdateResult => ({ status: "failed", sha: null, changes: [], unresolved: [], young: [], tool: null, error });
      const sh = async (cmd: string, args: string[], what: string): Promise<RunResult> => {
        const r = await run(cmd, args, { cwd: dir, env });
        if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`);
        return r;
      };
      try {
        await sh("git", ["clone", "--quiet", "--depth", "1", "--no-tags", "--branch", ctx.defaultBranch, `https://github.com/${o.owner}/${u0.repo}.git`, "."], "git clone");
        const remoteRef = `refs/remotes/origin/${TRAIN_BRANCH}`;
        const fetched = await run("git", ["fetch", "--quiet", "--depth", "2", "origin", `+refs/heads/${TRAIN_BRANCH}:${remoteRef}`], { cwd: dir, env });
        const hasRemote = fetched.code === 0;

        // 0. The minimumReleaseAge of pnpm: CI refuses a lockfile with a younger version. Such an item waits.
        let tool: string | null = null;
        const youngBy = new Map<string, YoungItem>();
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
        if (u.items.length === 0) return { status: "young", sha: null, changes: [], unresolved: [], young, tool, error: null };

        // 1. The ranges of the breaking items.
        const byPath = new Map<string, { type: string; dep: string; range: string; newRange: string }[]>();
        for (const i of u.items) {
          if (!i.newRange) continue;
          byPath.set(i.path, [...(byPath.get(i.path) ?? []), { type: i.type, dep: i.dep, range: i.range, newRange: i.newRange }]);
        }
        for (const [path, edits] of byPath) {
          const file = join(dir, path, "package.json");
          const { text, failed } = editManifest(readFileSync(file, "utf8"), edits);
          if (failed.length > 0) return fail(`The range of ${failed.join(", ")} in ${path || "."}/package.json is not the range of the plan.`);
          writeFileSync(file, text);
        }

        // 2. The lockfile, made by the package manager of the repository.
        const lockFile = u.lockKind === "pnpm" ? "pnpm-lock.yaml" : u.lockKind === "npm" ? "package-lock.json" : null;
        const paths = [...new Set(u.items.map((i) => i.path))];
        const names = [...new Set(u.items.map((i) => i.dep))];
        const read = (): Resolved => {
          if (!lockFile || !existsSync(join(dir, lockFile))) return {};
          const text = readFileSync(join(dir, lockFile), "utf8");
          return u.lockKind === "pnpm" ? parsePnpmLock(text) : parseNpmLock(text, paths, names);
        };
        const before = read();
        const inRange = [...new Set(u.items.filter((i) => !i.newRange).map((i) => i.dep))];
        if (u.lockKind === "pnpm") {
          const recursive = existsSync(join(dir, "pnpm-workspace.yaml")) ? ["-r"] : [];
          // An exact version gives the target of the plan. Step 0 left out each version younger than the minimumReleaseAge.
          const exact = [...new Map(u.items.map((i) => [i.dep, `${i.dep}@${i.to}`])).values()];
          await sh("pnpm", ["update", ...recursive, "--lockfile-only", "--no-save", ...exact], "pnpm update --lockfile-only");
          // This install aligns each other part of the lockfile with the changed ranges. Then the frozen check must pass, as in CI.
          await sh("pnpm", ["install", "--lockfile-only"], "pnpm install --lockfile-only");
          await sh("pnpm", ["install", "--lockfile-only", "--frozen-lockfile"], "pnpm install --frozen-lockfile");
        } else if (u.lockKind === "npm") {
          const v = await run("npm", ["--version"], { cwd: dir, env });
          tool = `npm ${v.stdout.trim() || "?"}`;
          const quiet = ["--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
          if (byPath.size > 0) await sh("npm", ["install", ...quiet], "npm install --package-lock-only");
          if (inRange.length > 0) await sh("npm", ["update", ...quiet, ...inRange], "npm update --package-lock-only");
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
        if (status.stdout.trim() === "" && unresolved.length === 0) return { status: "no-change", sha: null, changes, unresolved, young, tool, error: null };
        if (status.stdout.trim() === "" || (lockFile && unresolved.length === names.length)) return { status: "unresolved", sha: null, changes, unresolved, young, tool, error: null };

        // 4. One commit on the newest default branch.
        const msg = [
          `chore(deps): release train update of ${names.length === 1 ? names[0] : `${names.length} packages`}`,
          "",
          ...u.items.map((i) => `- ${i.dep} in ${i.path || "."}: ${i.newRange ? `${i.range} -> ${i.newRange}` : i.range}, lockfile -> ${after[i.path]?.[i.dep] ?? i.to}`),
        ].join("\n");
        await sh("git", ["add", "-u"], "git add");
        await sh("git", ["-c", `user.name=${o.author.name}`, "-c", `user.email=${o.author.email}`, "commit", "--quiet", "--no-verify", "-m", msg], "git commit");
        const head = (await sh("git", ["rev-parse", "HEAD"], "git rev-parse")).stdout.trim();

        // 5. No push when the branch already has the same content in the files of the train.
        if (hasRemote && !ctx.rebuild) {
          const ours = (await sh("git", ["diff", "--name-only", "HEAD~1", "HEAD"], "git diff")).stdout.split("\n");
          const theirs = (await run("git", ["diff", "--name-only", `${remoteRef}~1`, remoteRef], { cwd: dir, env })).stdout.split("\n");
          const files = [...new Set([...ours, ...theirs].map((f) => f.trim()).filter(Boolean))];
          const same = await run("git", ["diff", "--quiet", remoteRef, "HEAD", "--", ...files], { cwd: dir, env });
          if (same.code === 0) {
            const sha = (await sh("git", ["rev-parse", remoteRef], "git rev-parse")).stdout.trim();
            return { status: "same", sha, changes, unresolved, young, tool, error: null };
          }
        }
        await sh("git", ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${TRAIN_BRANCH}`], "git push");
        return { status: "pushed", sha: head, changes, unresolved, young, tool, error: null };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
