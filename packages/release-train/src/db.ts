import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "./plan.ts";
import type { Progress } from "./progress.ts";

/** This function changes an id into a document id that the tracker site permits. */
export function docId(id: string): string {
  let s = id.replace(/\//g, "+").replace(/:/g, "~").replace(/[^A-Za-z0-9_\-.~@+]/g, "_");
  if (s.endsWith(".")) s = `${s.slice(0, -1)}root`;
  return s;
}

function writeDoc(dir: string, collection: string, id: string, body: unknown): void {
  const folder = join(dir, "db", collection);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${docId(id)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, file);
}

function readCollection(dir: string, collection: string): Map<string, Record<string, unknown>> {
  const folder = join(dir, "db", collection);
  const out = new Map<string, Record<string, unknown>>();
  let files: string[] = [];
  try {
    files = readdirSync(folder).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      out.set(f.slice(0, -5), JSON.parse(readFileSync(join(folder, f), "utf8")) as Record<string, unknown>);
    } catch {
      // A file that is not valid JSON is not in the result.
    }
  }
  return out;
}

function removeStale(dir: string, collection: string, keep: ReadonlySet<string>): void {
  for (const id of readCollection(dir, collection).keys()) {
    if (!keep.has(id)) rmSync(join(dir, "db", collection, `${id}.json`), { force: true });
  }
}

/**
 * This function writes the plan as documents of the tracker site. It writes `meta/summary`, a document in `nodes` for each node
 * and a document in `actions` for each action. An action of the last run that is not in this run goes to `done`.
 */
export function writeDb(dir: string, p: Plan, progress: Readonly<Record<string, Progress>> = {}, now: Date = new Date()): void {
  const at = now.toISOString();
  const previous = readCollection(dir, "actions");
  const actionIds = new Set(p.actions.map((a) => docId(a.id)));

  for (const [id, old] of previous) {
    if (actionIds.has(id)) continue;
    writeDoc(dir, "done", id, { ...old, doneAt: at, progress: { state: "done", detail: "The action is no longer necessary.", url: null } });
  }
  // An action that comes back is not done.
  for (const id of readCollection(dir, "done").keys()) if (actionIds.has(id)) rmSync(join(dir, "db", "done", `${id}.json`), { force: true });
  const done = [...readCollection(dir, "done").entries()].sort((a, b) => String(b[1]["doneAt"]).localeCompare(String(a[1]["doneAt"])));
  for (const [id] of done.slice(60)) rmSync(join(dir, "db", "done", `${id}.json`), { force: true });

  const edgesFrom = new Map<string, typeof p.edges>();
  for (const e of p.edges) edgesFrom.set(e.from, [...(edgesFrom.get(e.from) ?? []), e]);
  const nodeIds = new Set<string>();
  for (const n of p.nodes) {
    const importer = n.kind === "package" ? `${n.repo}:${n.path || "."}` : n.id;
    const deps = (edgesFrom.get(importer) ?? []).map((e) => ({
      to: e.to,
      type: e.type,
      spec: e.spec,
      kind: e.kind,
      range: e.range,
      resolved: e.resolved,
      target: e.target,
      status: e.status,
      why: e.why,
      action: e.action,
    }));
    nodeIds.add(docId(n.id));
    writeDoc(dir, "nodes", n.id, { ...n, deps, updatedAt: at });
  }
  removeStale(dir, "nodes", nodeIds);

  for (const a of p.actions) {
    writeDoc(dir, "actions", a.id, { ...a, progress: progress[a.id] ?? { state: "todo", detail: "No pull request yet.", url: null }, updatedAt: at });
  }
  removeStale(dir, "actions", actionIds);

  writeDoc(dir, "meta", "summary", {
    owner: p.owner,
    generatedAt: p.generatedAt,
    counts: p.counts,
    cycles: p.cycles,
    actionCycles: p.actionCycles,
    reposWithoutPnpmLock: p.reposWithoutPnpmLock,
    repos: p.repos,
    flags: p.flags.map((f) => ({ from: f.from, fromName: f.fromName, to: f.to, type: f.type, spec: f.spec, blocking: f.blocking })),
    warnings: p.warnings,
  });

  const stamp = at.replace(/[:.]/g, "-");
  writeDoc(dir, "history", stamp, { at, counts: p.counts.actions, nodes: p.counts.nodes, actions: p.actions.length });
  const hist = [...readCollection(dir, "history").keys()].sort();
  for (const id of hist.slice(0, Math.max(0, hist.length - 200))) rmSync(join(dir, "db", "history", `${id}.json`), { force: true });
}
