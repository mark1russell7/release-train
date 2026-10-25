import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { apply, applySummary, hashName, publicReport } from "./apply.ts";
import { collect } from "./collect.ts";
import { writeDb } from "./db.ts";
import { buildGraph, publicView } from "./graph.ts";
import { plan } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { gitHub } from "./github.ts";
import { addProgress } from "./progress.ts";
import type { Progress } from "./progress.ts";
import { awaitRelease } from "./release.ts";
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
  /** `await-release`: the maximum time of the wait, in minutes. */
  minutes: number;
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
    else if (a === "--report") o.report = value();
    else if (a === "--author") o.author = value();
    else if (a === "--show-private") o.showPrivate = true;
    else if (a === "--release-dispatch") o.releaseDispatch = true;
    else if (a === "--minutes") o.minutes = Number(value());
    else if (a !== undefined && !a.startsWith("-")) o.command = a;
    else throw new Error(`Unknown option ${a}.`);
  }
  return o;
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
  ];
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

/** This function starts the command line. */
export async function main(argv: readonly string[]): Promise<number> {
  const o = parseArgs(argv);
  if (o.command === "await-release") return runAwait(o);
  if (o.command !== "plan" && o.command !== "apply") {
    process.stderr.write(`Unknown command ${o.command}. The commands are "plan", "apply" and "await-release".\n`);
    return 2;
  }
  return o.command === "apply" ? runApply(o) : runPlan(o);
}

async function runPlan(o: CliOptions): Promise<number> {
  const tok = token();
  const log = (l: string): void => void process.stderr.write(`${l}\n`);
  const data = await collect({ owner: o.owner, token: tok, publicOnly: o.publicOnly, log });
  let graph = buildGraph({ owner: o.owner, repos: data.repos, npm: data.npm, warnings: data.warnings });
  if (o.publicOnly) graph = publicView(graph);
  const p = plan(graph);
  const progress = o.progress ? await addProgress(p, { owner: o.owner, token: tok }) : {};
  const full = { ...p, progress };
  if (o.out) writeFileSync(o.out, `${JSON.stringify(full, null, 2)}\n`);
  if (o.writeDb) writeDb(o.writeDb, p, progress);
  process.stdout.write(o.json ? `${JSON.stringify(full, null, 2)}\n` : `${summary(p, progress)}\n`);
  return 0;
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
  const key = process.env["RELEASE_TRAIN_HASH_KEY"] ?? "";
  const secrets = new Set<string>();
  const hide = (names: Iterable<string>): void => {
    for (const n of names) {
      if (!n || secrets.has(n)) continue;
      secrets.add(n);
      if (inActions) process.stdout.write(`::add-mask::${n}\n`);
    }
  };
  const redact = (text: string): string => {
    if (o.showPrivate) return text;
    let t = text;
    for (const n of [...secrets].sort((a, b) => b.length - a.length)) t = redactName(t, n, hashName(n, key));
    return t;
  };
  const log = (l: string): void => void process.stderr.write(`${redact(l)}\n`);
  try {
    const data = await collect({
      owner: o.owner,
      token: tok,
      log,
      onRepos: (repos) => hide(repos.filter((r) => r.private).map((r) => r.name)),
    });
    const graph = buildGraph({ owner: o.owner, repos: data.repos, npm: data.npm, warnings: data.warnings });
    hide(graph.importers.filter((i) => i.repoPrivate).map((i) => i.name ?? ""));
    const p = plan(graph);
    const report = await apply({
      owner: o.owner,
      plan: p,
      gh: gitHub({ token: tok }),
      updater: gitUpdater({ owner: o.owner, token: tok, author: parseAuthor(o.author) }),
      dryRun: o.dryRun,
      only: o.only,
      releaseDispatch: o.releaseDispatch,
      log,
      label: (repo, priv) => (priv && !o.showPrivate ? hashName(repo, key) : repo),
    });
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
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${encodeURIComponent(version)}`, { headers: { accept: "application/json" } });
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
