/**
 * The positions of the two drawings of the explorer. The planner gives the order: the wave of each action and the
 * level of each package. This module only puts each box into its column and row.
 */

import type { Action, ActionKind, NodeState, NodeStatus, Plan } from "@release-train/release-train/src/plan.ts";
import { short } from "./world.ts";

/** One box of a drawing. */
export interface Box {
  id: string;
  x: number;
  y: number;
  column: number;
}

/** One arrow of a drawing, from the box `from` to the box `to`. */
export interface Arrow {
  from: string;
  to: string;
  d: string;
  status: string;
}

/** A drawing: its size, its boxes and its arrows. */
export interface Drawing {
  width: number;
  height: number;
  columns: number;
  boxes: Box[];
  arrows: Arrow[];
}

/** The size of a box and of the gaps between the boxes, in SVG units. */
export const BOX = { w: 168, h: 58, gapX: 44, gapY: 14, top: 30, pad: 8 } as const;

function place<T extends { id: string }>(groups: T[][]): Map<string, Box> {
  const out = new Map<string, Box>();
  groups.forEach((items, column) => {
    items.forEach((it, row) => {
      out.set(it.id, { id: it.id, column, x: BOX.pad + column * (BOX.w + BOX.gapX), y: BOX.top + row * (BOX.h + BOX.gapY) });
    });
  });
  return out;
}

function curve(a: Box, b: Box): string {
  const x1 = a.x + BOX.w;
  const y1 = a.y + BOX.h / 2;
  const x2 = b.x - 6;
  const y2 = b.y + BOX.h / 2;
  if (b.column <= a.column) {
    // An arrow inside one column (a cycle) goes around the right side.
    const r = BOX.gapX * 0.6;
    return `M${x1} ${y1} C${x1 + r} ${y1} ${x1 + r} ${b.y + BOX.h / 2} ${b.x + BOX.w + 6} ${b.y + BOX.h / 2}`;
  }
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
}

function drawing(groups: { id: string }[][], links: { from: string; to: string; status: string }[]): Drawing {
  const boxes = place(groups);
  const arrows: Arrow[] = [];
  for (const l of links) {
    const a = boxes.get(l.from);
    const b = boxes.get(l.to);
    if (a && b) arrows.push({ ...l, d: curve(a, b) });
  }
  const columns = Math.max(1, groups.length);
  const rows = Math.max(1, ...groups.map((g) => g.length));
  return {
    width: BOX.pad * 2 + columns * BOX.w + (columns - 1) * BOX.gapX,
    height: BOX.top + rows * BOX.h + (rows - 1) * BOX.gapY + BOX.pad,
    columns,
    boxes: [...boxes.values()],
    arrows,
  };
}

/**
 * This function gives the drawing of the train. Each wave is a column.
 * An arrow goes from each action to each action that waits for it.
 */
export function trainDrawing(p: Plan): Drawing {
  const waves: Action[][] = [];
  for (const a of p.actions) (waves[a.wave] ??= []).push(a);
  const groups = Array.from({ length: waves.length }, (_, i) => waves[i] ?? []);
  const links = p.actions.flatMap((a) => a.dependsOn.map((d) => ({ from: d, to: a.id, status: a.blocked ? "blocked" : "wait" })));
  return drawing(groups, links);
}

/** This function gives the drawing of the dependencies: one column for each level, and an arrow from each package to its dependents. */
export function dependencyDrawing(p: Plan): Drawing {
  const levels: NodeState[][] = [];
  for (const n of p.nodes) (levels[n.level] ??= []).push(n);
  const groups = Array.from({ length: levels.length }, (_, i) => (levels[i] ?? []).sort((a, b) => a.name.localeCompare(b.name)));
  const byImporter = new Map(p.nodes.map((n) => [`${n.repo}:${n.path || "."}`, n.id]));
  const links = p.edges.flatMap((e) => {
    const from = byImporter.get(e.from);
    return from ? [{ from: e.to, to: from, status: e.status }] : [];
  });
  return drawing(groups, links);
}

/** The words of each kind of action. */
export const KIND_LABEL: Record<ActionKind, string> = {
  "new-package": "New package",
  release: "Release",
  "adopt-breaking": "Change ranges",
  "adopt-in-range": "Update lockfile",
};

/** The words of each state of a package. */
export const STATUS_LABEL: Record<NodeStatus, string> = {
  blocked: "Blocked",
  "new-package": "New package",
  release: "Releases",
  breaking: "Range change",
  adopt: "Lockfile update",
  "up-to-date": "Up to date",
};

/** This function gives the short line under the title of an action box. */
export function actionLine(a: Action): string {
  if (a.kind === "release" || a.kind === "new-package") {
    const first = a.packages[0];
    const more = a.packages.length > 1 ? ` +${a.packages.length - 1}` : "";
    return first ? `${short(first.name)} ${first.to ?? "?"}${more}` : a.repo;
  }
  const n = a.items.length;
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

/** This function gives the SemVer reason of one package of a release action. */
export function semverReason(pkg: Action["packages"][number], chosen: string | undefined): string {
  if (pkg.from === null) return "first release";
  if (pkg.bump === "major") return pkg.to && /^0\./.test(pkg.to) ? "MINOR: a peer range changes (before 1.0.0)" : "MAJOR: a peer range changes";
  if (pkg.bump === "patch") return "PATCH or more: a dependency range changes";
  if (pkg.bump === "minor") return "MINOR: a dependency range changes";
  if (chosen === "major" && pkg.to && /^0\./.test(pkg.to)) return "MINOR: a break before 1.0.0";
  return chosen ? `${chosen.toUpperCase()}: the bump on main` : "the bump on main";
}
