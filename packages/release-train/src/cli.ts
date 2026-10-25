import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { collect } from "./collect.ts";
import { writeDb } from "./db.ts";
import { buildGraph, publicView } from "./graph.ts";
import { plan } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { addProgress } from "./progress.ts";
import type { Progress } from "./progress.ts";

/** The options of the command line. */
export interface CliOptions {
  command: string;
  owner: string;
  json: boolean;
  out: string | null;
  writeDb: string | null;
  publicOnly: boolean;
  progress: boolean;
}

/** This function reads the arguments of the command line. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = { command: "plan", owner: "mark1russell7", json: false, out: null, writeDb: null, publicOnly: false, progress: true };
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

/** This function starts the command line. */
export async function main(argv: readonly string[]): Promise<number> {
  const o = parseArgs(argv);
  if (o.command !== "plan") {
    process.stderr.write(`Unknown command ${o.command}. The command is "plan".\n`);
    return 2;
  }
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
