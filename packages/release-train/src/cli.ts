import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { extensionFaults, holdsOfFile, readHolds } from "./holds.ts";
import type { HoldReading, LagHold } from "./holds.ts";
import { applyHolds, lagOver, lagReport, lagSummary } from "./lag.ts";
import type { LagReport } from "./lag.ts";
import { apply, applySummary, busyRunners, hashName, MAX_PUSHES, pendingVersions, publicReport } from "./apply.ts";
import { collect, listRepos, pool } from "./collect.ts";
import { writeDb } from "./db.ts";
import { buildGraph, publicView } from "./graph.ts";
import { plan } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { type GitHub, gitHub, pageRead, readRateLimit } from "./github.ts";
import { moveCheck, moveSummary } from "./move.ts";
import { addProgress } from "./progress.ts";
import type { Progress } from "./progress.ts";
import { awaitRelease } from "./release.ts";
import { takeReplaced } from "./urgent.ts";
import { needStarts, readState } from "./state.ts";
import { SYNC_RULES, apiFiles, renovateDays, syncFacts, syncRepo, syncSummary } from "./sync.ts";
import type { SyncPlanItem, WorkflowsMode } from "./sync.ts";
import { backfillTags, checkWriteWindow, defaultSince, ghCommand, tagRepos, tagsSummary, validDate } from "./tags.ts";
import { versionFixRun, versionFixSummary } from "./version-fix.ts";
import { gitUpdater } from "./workspace.ts";

/** The options of the command line. */
export interface CliOptions {
  command: string;
  owner: string;
  json: boolean;
  out: string | null;
  writeDb: string | null;
  publicOnly: boolean;
  progress: boolean;
  /** `apply`: this option shows the changes and changes nothing. */
  dryRun: boolean;
  /** `apply`: the run changes only these repositories. */
  only: string[] | null;
  /** `apply`: the file for the report without private names. */
  report: string | null;
  /** `apply`: the author of the commits, as "Name <email>". */
  author: string | null;
  /** `apply`: this option shows the names of the private repositories in the output. */
  showPrivate: boolean;
  /** `apply`: the run starts the release workflows that start only by hand, and merges their version pull requests. */
  releaseDispatch: boolean;
  /** `apply`: the repositories whose breaking adoptions carry a cascade release, or "all". */
  cascade: string[] | "all";
  /** `await-release`: the maximum time of the wait, in minutes. */
  minutes: number;
  /** `plan` and `apply`: this option is false with `--no-sync`. Then the run does not sync the template files. */
  sync: boolean;
  /** `plan` and `apply`: can the GitHub App change workflow files? `auto`: the first push that GitHub refuses tells. */
  workflows: WorkflowsMode;
  /** `apply`: the most branches that one run pushes, for the update pushes and the sync pushes together. */
  maxPushes: number;
  /** `apply`: the public packages with a security fix. Their updates go first and pass the limit of pushes. */
  urgent: string[] | null;
  /** `apply`: the run takes the urgent names of each run that it replaced. Only a live run sets this option. */
  takeReplaced: boolean;
  /** `tags`: the start date, as `YYYY-MM-DD`. The command does not examine a version from before it. */
  since: string;
  /** `tags`: this option makes the missing releases. Without it, the command makes no write. */
  write: boolean;
  /** `lag`: the command exits with 1 when a row is over its limit. */
  gate: boolean;
  /** `lag`, `holds` and `apply`: the file of the holds. */
  holds?: string;
  /** `apply`: the state file of the train. The run reads it at the start and writes it at the end. */
  state?: string;
  /** `lag`: a saved report. The command then reads no repository. */
  fromReport?: string;
  /** `holds`: the earlier file of the holds. */
  before?: string;
  /** `lag` and `holds`: the time of the run, for a test. */
  now?: Date;
  /** `move-check`: the npm name of the package that moves. */
  packageName?: string;
  /** `move-check`: the version on npm before the move. */
  from?: string;
  /** `move-check`: the version on npm after the move, or the path of a tarball file. */
  to?: string;
  /** `move-check`: the repository after the move, as `owner/name`. */
  repo?: string;
  /** `move-check`: more fields of `package.json` that the move can change. */
  allowFields: string[];
  /** `move-check`: the files whose bytes the move can change. */
  allowFiles: string[];
}

/** This function reads the arguments of the command line. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = {
    command: "plan",
    owner: "mark1russell7",
    json: false,
    out: null,
    writeDb: null,
    publicOnly: false,
    progress: true,
    dryRun: false,
    only: null,
    report: null,
    author: null,
    showPrivate: false,
    releaseDispatch: false,
    minutes: 20,
    cascade: "all",
    sync: true,
    workflows: "auto",
    maxPushes: MAX_PUSHES,
    urgent: null,
    takeReplaced: false,
    since: defaultSince(),
    write: false,
    gate: false,
    allowFields: [],
    allowFiles: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === "--json") o.json = true;
    else if (a === "--out") o.out = value();
    else if (a === "--write-db") o.writeDb = value();
    else if (a === "--owner") o.owner = value();
    else if (a === "--public-only") o.publicOnly = true;
    else if (a === "--no-progress") o.progress = false;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--only") o.only = [...(o.only ?? []), ...value().split(",").map((x) => x.trim()).filter(Boolean)];
    else if (a === "--urgent") o.urgent = [...(o.urgent ?? []), ...value().split(",").map((x) => x.trim()).filter(Boolean)];
    else if (a === "--report") o.report = value();
    else if (a === "--author") o.author = value();
    else if (a === "--show-private") o.showPrivate = true;
    else if (a === "--release-dispatch") o.releaseDispatch = true;
    else if (a === "--minutes") o.minutes = Number(value());
    else if (a === "--no-sync") o.sync = false;
    else if (a === "--take-replaced") o.takeReplaced = true;
    else if (a === "--write") o.write = true;
    else if (a === "--gate") o.gate = true;
    else if (a === "--holds") o.holds = value();
    else if (a === "--state") o.state = value();
    else if (a === "--from-report") o.fromReport = value();
    else if (a === "--before") o.before = value();
    else if (a === "--package") o.packageName = value();
    else if (a === "--from") o.from = value();
    else if (a === "--to") o.to = value();
    else if (a === "--repo") o.repo = value();
    else if (a === "--allow-field") o.allowFields.push(value());
    else if (a === "--allow-file") o.allowFiles.push(value());
    else if (a === "--now") {
      const v = new Date(value());
      if (Number.isNaN(v.getTime())) throw new Error("--now needs a time.");
      o.now = v;
    }
    else if (a === "--since") {
      const v = value().trim();
      if (!validDate(v)) throw new Error(`--since needs a date of the form YYYY-MM-DD, not ${v}.`);
      o.since = v;
    }
    else if (a === "--max-pushes") {
      const v = Number(value());
      if (!Number.isInteger(v) || v < 0) throw new Error(`--max-pushes needs a whole number of 0 or more.`);
      o.maxPushes = v;
    }
    else if (a === "--workflows") {
      const v = value().trim();
      if (v !== "auto" && v !== "yes" && v !== "no") throw new Error(`--workflows needs auto, yes or no, not ${v}.`);
      o.workflows = v;
    }
    else if (a === "--cascade") {
      const v = value().trim();
      o.cascade = v === "all" ? "all" : v.split(",").map((x) => x.trim()).filter(Boolean);
    }
    else if (a !== undefined && !a.startsWith("-")) o.command = a;
    else throw new Error(`Unknown option ${a}.`);
  }
  if (o.write) checkWriteWindow(o.since);
  return o;
}

/**
 * This function gives the urgent names of a run: its own names, and the names of each run that it replaced. A failed read
 * does not stop the run. The function writes a warning, so a person sees that a replaced run can have urgent names.
 */
async function urgentNames(o: CliOptions, gh: GitHub, log: (l: string) => void): Promise<string[] | null> {
  const repo = process.env["GITHUB_REPOSITORY"];
  const self = Number(process.env["GITHUB_RUN_ID"]);
  if (!o.takeReplaced || repo === undefined || !Number.isInteger(self)) return o.urgent;
  try {
    const taken = await takeReplaced(gh, repo, self);
    if (taken.names.length === 0) return o.urgent;
    const line = `Urgent names from the replaced runs ${taken.runs.join(", ")}: ${taken.names.join(", ")}.`;
    log(line);
    const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryFile) appendFileSync(summaryFile, `\n${line}\n`);
    return [...new Set([...(o.urgent ?? []), ...taken.names])];
  } catch (e) {
    log(`::warning::The run cannot read the replaced runs, so it takes no urgent names from them: ${e instanceof Error ? e.message : String(e)}`);
    return o.urgent;
  }
}

/** This function gives the options of `apply` for the pace of the pushes. */
export function paceOptions(o: Pick<CliOptions, "maxPushes" | "urgent">): { maxPushes: number; urgent: string[] | null } {
  return { maxPushes: o.maxPushes, urgent: o.urgent };
}

/** This function gives a short text summary of the plan. */
export function summary(p: Plan, progress: Readonly<Record<string, Progress>> = {}): string {
  const c = p.counts;
  const lines = [
    `Release train plan for ${p.owner} at ${p.generatedAt}`,
    `${c.repos} repositories, ${c.packages} packages, ${c.edges} edges`,
    `Actions: ${c.actions["new-package"]} new-package, ${c.actions.release} release, ${c.actions["adopt-breaking"]} adopt-breaking, ${c.actions["adopt-in-range"]} adopt-in-range`,
    `Nodes: ${Object.entries(c.nodes).map(([k, v]) => `${v} ${k}`).join(", ")}`,
    `Flags: ${c.flags} git/file/link specifiers, ${c.blockingFlags} block a release`,
    `Versions: ${c.taken} not free, ${c.behind} published ranges behind`,
  ];
  for (const t of p.taken) lines.push(`taken: ${t.name}@${t.version} (${[t.repo, ...t.pulls.map((n) => `#${n}`)].join(" ")}). ${t.why}`);
  for (const b of p.behind) lines.push(`behind: ${b.name} has ${b.dep}@${b.range} on npm, but ${b.dep} goes to ${b.version}. ${b.name} gets a cascade release in ${b.repo}.`);
  if (p.cycles.length > 0) lines.push(`Cycles: ${p.cycles.map((cy) => `${cy.packages.join(" <-> ")}${cy.runtime ? " (runtime)" : " (dev)"}`).join("; ")}`);
  if (p.actionCycles.length > 0) lines.push(`Action cycles: ${p.actionCycles.map((cy) => cy.join(" <-> ")).join("; ")}`);
  if (p.reposWithoutPnpmLock.length > 0) lines.push(`No pnpm lockfile: ${p.reposWithoutPnpmLock.join(", ")}`);
  lines.push("", "Next actions:");
  for (const a of p.actions.slice(0, 15)) {
    const pr = progress[a.id];
    const state = pr && pr.state !== "todo" ? ` [${pr.state}]` : "";
    const block = a.blocked ? " [BLOCKED]" : "";
    const wait = a.dependsOn.length > 0 ? ` (after ${a.dependsOn.join(", ")})` : "";
    lines.push(`${String(a.order).padStart(3)}. w${a.wave} ${a.kind.padEnd(14)} ${a.repo}${block}${state}${wait}`);
    lines.push(`       ${a.why}`);
  }
  if (p.actions.length > 15) lines.push(`  ... and ${p.actions.length - 15} more`);
  for (const w of p.warnings.slice(0, 10)) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

function token(): string | null {
  const env = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * This function gives the key of the hashes of the private names, from the environment.
 * It refuses a PEM private key, because a public hash must not depend on the key that signs the app tokens.
 * In GitHub Actions, it refuses an empty key: a hash with no key gives each private name to a dictionary attack.
 */
export function hashKey(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = env["RELEASE_TRAIN_HASH_KEY"] ?? "";
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(key)) {
    throw new Error("RELEASE_TRAIN_HASH_KEY holds a PEM private key. Give it a separate random key.");
  }
  if (key === "" && env["GITHUB_ACTIONS"] === "true") {
    throw new Error("RELEASE_TRAIN_HASH_KEY is empty. In GitHub Actions, the hashes of the private names need a secret key.");
  }
  return key;
}

/** This function gives the hash key for a run, or null after it writes the reason. A run that shows the private names needs no key. */
function runKey(o: Pick<CliOptions, "showPrivate">): string | null {
  if (o.showPrivate) return "";
  try {
    return hashKey();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/** This function reads an author of the form "Name <email>". */
export function parseAuthor(text: string | null): { name: string; email: string } {
  const lt = text?.indexOf("<") ?? -1;
  const gt = text?.lastIndexOf(">") ?? -1;
  const name = text && lt > 0 ? text.slice(0, lt).trim() : "";
  const email = text && gt > lt + 1 ? text.slice(lt + 1, gt).trim() : "";
  return name && email ? { name, email } : { name: "release-train", email: "release-train@users.noreply.github.com" };
}

/** This function replaces each whole occurrence of a name in a text. A longer word that holds the name does not change. */
export function redactName(text: string, name: string, by: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\w-])${esc}(?![\\w-])`, "g"), by);
}

/** This function replaces each given name in a text with its hash. A longer name goes first. */
export function redactNames(text: string, names: Iterable<string>, key: string): string {
  let t = text;
  for (const n of [...names].sort((a, b) => b.length - a.length)) t = redactName(t, n, hashName(n, key));
  return t;
}

/** This function starts the command line. */
export async function main(argv: readonly string[]): Promise<number> {
  const o = parseArgs(argv);
  if (o.command === "await-release") return runAwait(o);
  if (o.command === "tags") return runTags(o);
  if (o.command === "lag") return runLag(o);
  if (o.command === "holds") return runHolds(o);
  if (o.command === "move-check") return runMoveCheck(o);
  if (o.command === "version-fix") return runVersionFix(o);
  if (o.command !== "plan" && o.command !== "apply") {
    process.stderr.write(`Unknown command ${o.command}. The commands are "plan", "apply", "await-release", "tags", "lag", "holds", "move-check" and "version-fix".\n`);
    return 2;
  }
  return o.command === "apply" ? runApply(o) : runPlan(o);
}

/**
 * The version-fix command: it reads the open pull requests of the repositories of the token. When the release check of an
 * automated dependency update fails only because a version is on npm, the command adds the PATCH (version-fix.ts).
 * `--dry-run` shows the decisions and changes nothing. Its output gives each private repository only as a hash, with no
 * package name. In GitHub Actions, it also masks the private names.
 */
async function runVersionFix(o: CliOptions): Promise<number> {
  const tok = token();
  if (!tok) {
    process.stderr.write("version-fix needs a token in GH_TOKEN.\n");
    return 2;
  }
  const inActions = process.env["GITHUB_ACTIONS"] === "true";
  const key = runKey(o);
  if (key === null) return 2;
  const secrets = new Set<string>();
  const redact = (text: string): string => (o.showPrivate ? text : redactNames(text, secrets, key));
  const log = (l: string): void => void process.stderr.write(`${redact(l)}\n`);
  try {
    const gh = gitHub({ token: tok });
    const all = await listRepos(pageRead(gh), { owner: o.owner, token: tok, publicOnly: false });
    for (const r of all.filter((x) => x.private)) {
      if (secrets.has(r.name)) continue;
      secrets.add(r.name);
      if (inActions) process.stdout.write(`::add-mask::${r.name}\n`);
    }
    const repos = all.filter((r) => o.only === null || o.only.includes(r.name)).map((r) => ({ name: r.name, private: r.private }));
    log(`version fix: ${repos.length} repositories, ${repos.filter((r) => r.private).length} of them private${o.dryRun ? ", dry run" : ""}`);
    const author = parseAuthor(o.author);
    const rows = await versionFixRun({
      gh,
      owner: o.owner,
      repos,
      fixer: o.dryRun ? null : gitUpdater({ owner: o.owner, token: tok, author }),
      // The login of the App is the name of its commit author, for example "name[bot]".
      trainLogin: o.author === null ? null : author.name,
      log,
      label: (repo, priv) => (priv && !o.showPrivate ? hashName(repo, key) : repo),
    });
    const text = redact(versionFixSummary(rows, o.dryRun));
    const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryFile) appendFileSync(summaryFile, ["", "```", text, "```", ""].join("\n"));
    process.stdout.write(`${text}\n`);
    return rows.some((r) => r.action === "error") ? 1 : 0;
  } catch (e) {
    process.stderr.write(`${redact(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

async function runPlan(o: CliOptions): Promise<number> {
  const tok = token();
  const log = (l: string): void => void process.stderr.write(`${l}\n`);
  const data = await collect({ owner: o.owner, token: tok, publicOnly: o.publicOnly, log });
  let graph = buildGraph({ owner: o.owner, repos: data.repos, npm: data.npm, warnings: data.warnings });
  if (o.publicOnly) graph = publicView(graph);
  const p = plan(graph);
  const progress = o.progress ? await addProgress(p, { owner: o.owner, token: tok }) : {};
  const sync = o.sync ? await planSync(p, tok, o.workflows, log) : null;
  const full = { ...p, progress, ...(sync ? { sync } : {}) };
  if (o.out) writeFileSync(o.out, `${JSON.stringify(full, null, 2)}\n`);
  if (o.writeDb) writeDb(o.writeDb, p, progress);
  const text = `${summary(p, progress)}${sync ? `\n${syncSummary(sync)}` : ""}`;
  process.stdout.write(o.json ? `${JSON.stringify(full, null, 2)}\n` : `${text}\n`);
  return 0;
}

/** This function gives the template sync of each repository of a plan, with no change: the dry run of the sync. */
async function planSync(p: Plan, tok: string | null, workflows: WorkflowsMode, log: (l: string) => void): Promise<SyncPlanItem[] | null> {
  const gh = gitHub({ token: tok });
  const facts = await syncFacts({ gh, owner: p.owner });
  if (!facts) {
    log("Template sync: the template is not readable.");
    return null;
  }
  const pending = pendingVersions(p);
  const read = await pool(p.repos, 6, async (r) => ({ repo: r.name, files: await apiFiles(gh, p.owner, r.name) }));
  const filesOf = new Map(read.map((x) => [x.repo, x.files]));
  const runFacts = { ...facts, renovateDay: await renovateDays(read, facts) };
  const items = await pool(p.repos, 6, async (r): Promise<SyncPlanItem | null> => {
    const files = filesOf.get(r.name) ?? null;
    if (!files) return null;
    const releaseInFlight = pending.has(r.name) || (r.pendingChangesets ?? 0) > 0;
    const result = await syncRepo(files, { ...runFacts, repo: r.name, releaseInFlight }, SYNC_RULES, workflows !== "no");
    return { repo: r.name, private: r.private, result };
  });
  return items.filter((i): i is SyncPlanItem => i !== null);
}

/**
 * The apply command: it plans with all repositories of the token, then applies the adoptions of the current wave.
 * Its output and its report give each private repository only as a hash. In GitHub Actions, it also masks the private names.
 */
async function runApply(o: CliOptions): Promise<number> {
  const tok = token();
  if (!tok) {
    process.stderr.write("apply needs a token in GH_TOKEN.\n");
    return 2;
  }
  const inActions = process.env["GITHUB_ACTIONS"] === "true";
  const key = runKey(o);
  if (key === null) return 2;
  const secrets = new Set<string>();
  const hide = (names: Iterable<string>): void => {
    for (const n of names) {
      if (!n || secrets.has(n)) continue;
      secrets.add(n);
      if (inActions) process.stdout.write(`::add-mask::${n}\n`);
    }
  };
  const redact = (text: string): string => {
    return o.showPrivate ? text : redactNames(text, secrets, key);
  };
  const log = (l: string): void => void process.stderr.write(`${redact(l)}\n`);
  try {
    const read = o.state === undefined ? null : readState(o.state);
    if (read?.note) log(read.note);
    const gh = gitHub({ token: tok });
    // The reads of the rate limit at the start and at the end give the GitHub requests of the run. A failed read is no read.
    const rateStart = await readRateLimit(gh);
    const data = await collect({
      owner: o.owner,
      token: tok,
      log,
      onRepos: (repos) => hide(repos.filter((r) => r.private).map((r) => r.name)),
      ...(read ? { npmTimes: read.state.npm } : {}),
    });
    const graph = buildGraph({ owner: o.owner, repos: data.repos, npm: data.npm, warnings: data.warnings });
    hide(graph.importers.filter((i) => i.repoPrivate).map((i) => i.name ?? ""));
    const p = plan(graph);
    // Without a state file the train keeps no first sight of a need, so the run gives no start for a need with no publish time.
    const starts = read ? needStarts(data.npm, read.state.seen, (o.now ?? new Date()).toISOString(), (k) => hashName(k, key)) : null;
    const updater = gitUpdater({ owner: o.owner, token: tok, author: parseAuthor(o.author) });
    const report = await apply({
      owner: o.owner,
      plan: p,
      gh,
      updater,
      sync: o.sync
        ? {
            updater,
            facts: await syncFacts({ gh, owner: o.owner }),
            workflows: o.workflows,
          }
        : null,
      ...paceOptions({ ...o, urgent: await urgentNames(o, gh, log) }),
      runnersBusy: busyRunners(gh, o.owner, data.repos.map((r) => r.name)),
      dryRun: o.dryRun,
      only: o.only,
      releaseDispatch: o.releaseDispatch,
      cascade: o.cascade,
      holds: applyHolding(o, log),
      log,
      label: (repo, priv) => (priv && !o.showPrivate ? hashName(repo, key) : repo),
      ...(starts ? { needSince: (u) => starts.since(u.repo, u.items) } : {}),
    });
    report.rateLimit = { start: rateStart, end: await readRateLimit(gh) };
    if (o.state !== undefined && starts) {
      writeFileSync(o.state, `${JSON.stringify({ version: 1, npm: data.npmTimes ?? {}, seen: starts.seen() })}\n`);
      const c = starts.counts();
      log(`need starts: ${c.npm} from npm, ${c.state} from the state`);
    }
    const out = o.showPrivate ? report : publicReport(report, key);
    const text = redact(applySummary(out));
    if (o.report) writeFileSync(o.report, `${redact(JSON.stringify(out, null, 2))}\n`);
    const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryFile) appendFileSync(summaryFile, ["", "```", text, "```", ""].join("\n"));
    process.stdout.write(`${text}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${redact(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

/**
 * The tags command: it finds each published version with no git tag, and with `--write` it makes each missing release.
 * Its output gives each private repository and package only as a hash. `--dry-run` wins over `--write`.
 */
/**
 * The lag command: it reports each change with no release, and each red pull request of the train. It makes no write.
 * With `--gate`, a row over its limit with no hold, or a fault of the holds, gives the exit code 1.
 */
async function runLag(o: CliOptions): Promise<number> {
  const read = o.fromReport === undefined ? await readLag(o) : (JSON.parse(readFileSync(o.fromReport, "utf8")) as LagReport);
  const report = o.holds === undefined ? read : applyHolds(read, holdsFromFile(o.holds, o.now ?? new Date()));
  if (o.out) writeFileSync(o.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(o.json ? `${JSON.stringify(report, null, 2)}\n` : `${lagSummary(report)}\n`);
  return o.gate && lagOver(report) ? 1 : 0;
}

/**
 * This function gives the valid holds for the command `apply`. A hold with a fault holds nothing, so its update goes. The
 * run writes the fault, and the lag gate fails on it.
 */
export function applyHolding(o: Pick<CliOptions, "holds" | "now">, log: (line: string) => void): readonly LagHold[] {
  if (o.holds === undefined) return [];
  const reading = holdsFromFile(o.holds, o.now ?? new Date());
  for (const fault of reading.faults) log(`A fault of the holds: ${fault}`);
  return reading.holds;
}

/** This function reads the file of the holds. A file that the command cannot read is a fault, so it does not hide a row. */
function holdsFromFile(file: string, now: Date): HoldReading {
  try {
    return readHolds(JSON.parse(readFileSync(file, "utf8")), now);
  } catch (error) {
    return { holds: [], faults: [`The file ${file} of the holds gives this error: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** The holds command: it examines the file of the holds, and with `--before` it examines each change of a date. */
function runHolds(o: CliOptions): number {
  if (o.holds === undefined) {
    process.stderr.write("The command holds needs --holds <file>.\n");
    return 2;
  }
  const reading = holdsFromFile(o.holds, o.now ?? new Date());
  const before = o.before === undefined ? [] : holdsOfFile(JSON.parse(readFileSync(o.before, "utf8")));
  const faults = [...reading.faults, ...extensionFaults(before, reading.holds)];
  for (const fault of faults) process.stderr.write(`${fault}\n`);
  process.stdout.write(`${reading.holds.length} valid holds, ${faults.length} faults.\n`);
  return faults.length === 0 ? 0 : 1;
}

/** This function reads the lag from the repositories and npm. */
async function readLag(o: CliOptions): Promise<LagReport> {
  const tok = token();
  const log = (l: string): void => void process.stderr.write(`${l}\n`);
  const data = await collect({ owner: o.owner, token: tok, publicOnly: o.publicOnly, log });
  const graph = buildGraph({ owner: o.owner, repos: data.repos, npm: data.npm, warnings: data.warnings });
  return lagReport({
    owner: o.owner,
    gh: gitHub({ token: tok }),
    packages: graph.packages,
    branches: new Map(data.repos.map((r) => [r.name, r.defaultBranch])),
    publicOnly: o.publicOnly,
    log,
  });
}

async function runTags(o: CliOptions): Promise<number> {
  const key = runKey(o);
  if (key === null) return 2;
  const secrets = new Set<string>();
  const redact = (text: string): string => (o.showPrivate ? text : redactNames(text, secrets, key));
  const log = (l: string): void => void process.stderr.write(`${redact(l)}\n`);
  try {
    const data = await collect({
      owner: o.owner,
      token: token(),
      publicOnly: o.publicOnly,
      log,
      onRepos: (repos) => {
        for (const r of repos) if (r.private) secrets.add(r.name);
      },
    });
    const graph = buildGraph({ owner: o.owner, repos: data.repos, npm: data.npm, warnings: data.warnings });
    for (const p of graph.packages) if (p.repoPrivate) secrets.add(p.name);
    const report = await backfillTags({
      owner: o.owner,
      repos: tagRepos(data.repos, graph.packages, o.only),
      gh: ghCommand,
      since: o.since,
      write: o.write && !o.dryRun,
      log,
    });
    const json = `${redact(JSON.stringify(report, null, 2))}\n`;
    if (o.out) writeFileSync(o.out, json);
    process.stdout.write(o.json ? json : `${redact(tagsSummary(report))}\n`);
    return report.rows.some((r) => r.state === "failed" || r.state === "error") ? 1 : 0;
  } catch (e) {
    process.stderr.write(`${redact(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

/**
 * The move-check command: the gate of a move of a package to another repository. It exits with 1 on a fault,
 * and with 2 on a missing option.
 */
export async function runMoveCheck(o: CliOptions, check: typeof moveCheck = moveCheck): Promise<number> {
  if (!o.packageName || !o.from || !o.to || !o.repo) {
    process.stderr.write("move-check needs --package <name> --from <version> --to <version or file.tgz> --repo <owner/name>.\n");
    return 2;
  }
  try {
    const report = await check({ name: o.packageName, from: o.from, to: o.to, repo: o.repo, allowFields: o.allowFields, allowFiles: o.allowFiles });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (o.out) writeFileSync(o.out, json);
    process.stdout.write(o.json ? json : `${moveSummary(report)}\n`);
    return report.pass ? 0 : 1;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/**
 * The await-release command: it reads the versions in flight from the apply report and waits until npm has one of them.
 * Then it sends the `released` event of `repository_dispatch` to the repository of the train, so the next wave starts.
 */
async function runAwait(o: CliOptions): Promise<number> {
  if (!o.report) {
    process.stderr.write("await-release needs --report <file>.\n");
    return 2;
  }
  const report = JSON.parse(readFileSync(o.report, "utf8")) as { dryRun?: boolean; inFlight?: { name: string; version: string }[] };
  const inFlight = report.inFlight ?? [];
  if (report.dryRun || inFlight.length === 0) {
    process.stdout.write("No release is in flight.\n");
    return 0;
  }
  const published = async (name: string, version: string): Promise<boolean> => {
    const res = await fetch(`https://registry.npmjs.org/${name.replaceAll("/", "%2F")}/${encodeURIComponent(version)}`, { headers: { accept: "application/json" } });
    return res.ok;
  };
  const first = await awaitRelease({
    inFlight,
    published,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    maxMs: Math.max(0, o.minutes) * 60_000,
    intervalMs: 30_000,
  });
  if (!first) {
    process.stdout.write(`npm has no version in flight after ${o.minutes} minutes. The next scheduled run continues.\n`);
    return 0;
  }
  const tok = token();
  const repo = process.env["GITHUB_REPOSITORY"] ?? `${o.owner}/release-train`;
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok ?? ""}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ event_type: "released", client_payload: { name: first.name, version: first.version } }),
  });
  if (!res.ok) {
    process.stderr.write(`npm has ${first.name}@${first.version}, but the dispatch failed (HTTP ${res.status}).\n`);
    return 1;
  }
  process.stdout.write(`npm has ${first.name}@${first.version}. The train starts the next wave.\n`);
  return 0;
}
