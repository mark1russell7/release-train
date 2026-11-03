/**
 * The page of the plan explorer. After each change of the visitor, the page starts the real planner of the library again.
 * Then it draws the result: the train of actions in waves, the state of each package, and each wait and block.
 */

import type { Action, EdgeState, NodeState, Plan } from "@release-train/release-train/src/plan.ts";
import type { Bump } from "@release-train/release-train/src/plan.ts";
import { actionLine, BOX, dependencyDrawing, KIND_LABEL, semverReason, STATUS_LABEL, trainDrawing } from "./layout.ts";
import type { Drawing } from "./layout.ts";
import { depKey, mainVersion, planFor, SAMPLE, SCENARIOS, short } from "./world.ts";
import type { Choices } from "./world.ts";
import "./style.css";

type View = "train" | "deps";
type Child = Node | string | null | undefined | false;

const state: { choices: Choices; scenario: string | null; view: View; selected: string | null; plan: Plan } = {
  choices: (SCENARIOS[0] as (typeof SCENARIOS)[number]).choices(),
  scenario: (SCENARIOS[0] as (typeof SCENARIOS)[number]).id,
  view: "train",
  selected: null,
  plan: undefined as unknown as Plan,
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const SVG = "http://www.w3.org/2000/svg";
function svg(tag: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`The page has no #${id}.`);
  return node as T;
}

function wave(n: number): string {
  return `Wave ${n + 1}`;
}

function nodeOf(name: string): NodeState | undefined {
  return state.plan.nodes.find((n) => n.id === name || n.name === name);
}

// The controls.

function renderScenarios(): void {
  const box = byId("scenarios");
  box.replaceChildren(
    ...SCENARIOS.map((s) => el("button", { type: "button", "data-scenario": s.id, "aria-pressed": String(state.scenario === s.id), title: s.hint }, s.label)),
  );
  const hint = SCENARIOS.find((s) => s.id === state.scenario)?.hint ?? "Your own changes. Choose a scenario to start again.";
  byId("hint").textContent = hint;
}

const BUMPS: { id: Bump | "none"; label: string; title: string }[] = [
  { id: "none", label: "none", title: "No bump on main" },
  { id: "patch", label: "patch", title: "A bug fix" },
  { id: "minor", label: "minor", title: "A new feature" },
  { id: "major", label: "major", title: "A breaking change" },
];

function renderPackages(): void {
  const list = byId("packages-list");
  list.replaceChildren(
    ...SAMPLE.map((p) => {
      const node = nodeOf(p.app ? `${p.repo}:.` : p.name);
      const status = node?.status ?? "up-to-date";
      const main = mainVersion(p, state.choices);
      const chosen = state.choices.bumps[p.name];
      const versions = p.app
        ? el("span", { class: "ver" }, "app, not on npm")
        : el("span", { class: "ver" }, p.npm ? `npm ${p.npm}` : "not on npm", main !== p.npm ? el("b", {}, ` → main ${main}`) : null);
      const next = node?.next && node.next !== p.npm ? ` ${node.next}` : "";
      const deps = p.deps.filter((d) => d.type !== "devDependencies" && !d.spec.startsWith("workspace:"));
      return el(
        "li",
        { class: `pkg s-${status}`, "data-name": p.name, "aria-current": state.selected === (node?.id ?? "") ? "true" : undefined },
        el(
          "div",
          { class: "pkg-head" },
          el("button", { type: "button", class: "pkg-name", "data-select": node?.id ?? p.name, title: `Show ${p.name}` }, short(p.name)),
          el("span", { class: `badge s-${status} status` }, `${STATUS_LABEL[status]}${status === "release" || status === "blocked" ? next : ""}`),
        ),
        el("div", { class: "pkg-meta" }, el("span", { class: "role" }, p.role), versions),
        p.app || !p.npm
          ? null
          : el(
              "div",
              { class: "pkg-controls" },
              el(
                "div",
                { class: "seg", role: "group", "aria-label": `Bump of ${p.name}` },
                ...BUMPS.map((b) =>
                  el(
                    "button",
                    { type: "button", "data-bump": `${p.name}:${b.id}`, "aria-pressed": String((chosen ?? "none") === b.id), title: b.title },
                    b.label,
                  ),
                ),
              ),
              el(
                "label",
                { class: "prov", title: "The latest npm version was built by release.yml of its own repository" },
                el("input", { type: "checkbox", "data-prov": p.name, checked: !state.choices.noProvenance.includes(p.name) }),
                "provenance",
              ),
            ),
        deps.length === 0
          ? null
          : el(
              "div",
              { class: "deps" },
              el("span", { class: "deps-label" }, "uses"),
              ...deps.map((d) => {
                const git = state.choices.git.includes(depKey(p.name, d.name));
                return el(
                  "button",
                  {
                    type: "button",
                    class: "dep",
                    "data-git": depKey(p.name, d.name),
                    "aria-pressed": String(git),
                    title: git ? "Use the npm range again" : "Use a github: specifier",
                  },
                  `${short(d.name)} `,
                  el("code", {}, git ? "github:" : d.spec),
                );
              }),
            ),
      );
    }),
  );
}

// The summary.

function renderSummary(): void {
  const p = state.plan;
  const waves = p.actions.length ? Math.max(...p.actions.map((a) => a.wave)) + 1 : 0;
  const blocked = p.actions.filter((a) => a.blocked).length + p.nodes.filter((n) => n.status === "blocked" && !n.actions.length).length;
  const waits = p.edges.filter((e) => e.status === "waiting" && e.why.includes("provenance")).length;
  const releases = p.actions.filter((a) => a.kind === "release").reduce((n, a) => n + a.packages.length, 0);
  const tile = (id: string, value: number, label: string, tone = ""): HTMLElement =>
    el("div", { class: `tile ${tone}`, id }, el("span", { class: "num" }, String(value)), el("span", { class: "lbl" }, label));
  byId("summary").replaceChildren(
    tile("sum-actions", p.actions.length, p.actions.length === 1 ? "action" : "actions"),
    tile("sum-waves", waves, waves === 1 ? "wave" : "waves"),
    tile("sum-releases", releases, releases === 1 ? "new version" : "new versions"),
    tile("sum-blocked", blocked + waits, "blocked or held", blocked + waits > 0 ? "warn" : ""),
  );
}

// The drawings.

function boxLabel(id: string): { title: string; kind: string; line: string; tone: string; aria: string } {
  if (state.view === "train") {
    const a = state.plan.actions.find((x) => x.id === id) as Action;
    const tone = a.blocked ? "blocked" : a.kind;
    const kind = a.blocked ? `Blocked ${KIND_LABEL[a.kind].toLowerCase()}` : KIND_LABEL[a.kind];
    return { title: a.repo, kind, line: actionLine(a), tone, aria: `${wave(a.wave)}, ${kind} of ${a.repo}` };
  }
  const n = state.plan.nodes.find((x) => x.id === id) as NodeState;
  const version = n.kind === "app" ? "app" : n.next ? `${n.npmLatest ?? "new"} → ${n.next}` : (n.npmLatest ?? n.version ?? "");
  return { title: short(n.name), kind: STATUS_LABEL[n.status], line: version, tone: n.status, aria: `${n.name}: ${STATUS_LABEL[n.status]}` };
}

function renderCanvas(): void {
  const d: Drawing = state.view === "train" ? trainDrawing(state.plan) : dependencyDrawing(state.plan);
  const root = svg("svg", { viewBox: `0 0 ${d.width} ${d.height}`, role: "group", "aria-label": state.view === "train" ? "The train of actions, one column for each wave" : "The packages, one column for each level of dependencies" }) as SVGSVGElement;
  root.style.width = `clamp(${Math.round(d.width * 0.72)}px, 100%, ${d.width}px)`;
  const defs = svg("defs");
  for (const tone of ["wait", "blocked", "current", "adopt", "breaking", "workspace", "waiting", "flagged", "unlocked"]) {
    const m = svg("marker", { id: `arrow-${tone}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    m.append(svg("path", { d: "M0 0 L10 5 L0 10 z", class: `tip e-${tone}` }));
    defs.append(m);
  }
  root.append(defs);
  for (let c = 0; c < d.columns; c++) {
    const x = BOX.pad + c * (BOX.w + BOX.gapX);
    root.append(svg("text", { x, y: 16, class: "col-label" }, state.view === "train" ? wave(c) : c === 0 ? "No dependency" : `Level ${c}`));
  }
  const hot = new Set<string>();
  const sel = state.selected;
  const arrows = svg("g", { class: "arrows" });
  for (const a of d.arrows) {
    const on = sel !== null && (a.from === sel || a.to === sel);
    if (on) {
      hot.add(a.from);
      hot.add(a.to);
    }
    arrows.append(svg("path", { d: a.d, class: `arrow e-${a.status}${on ? " hot" : ""}`, "marker-end": `url(#arrow-${a.status})` }));
  }
  root.append(arrows);
  for (const b of d.boxes) {
    const info = boxLabel(b.id);
    const g = svg("g", {
      class: `box t-${info.tone}${b.id === sel ? " sel" : ""}${hot.has(b.id) && b.id !== sel ? " near" : ""}`,
      transform: `translate(${b.x} ${b.y})`,
      tabindex: 0,
      role: "button",
      "data-id": b.id,
      "aria-label": info.aria,
    });
    g.append(
      svg("rect", { width: BOX.w, height: BOX.h, rx: 9, class: "card-bg" }),
      svg("rect", { width: 5, height: BOX.h - 16, x: 7, y: 8, rx: 2.5, class: "stripe" }),
      svg("text", { x: 20, y: 21, class: "box-title" }, clip(info.title, 17)),
      svg("text", { x: 20, y: 38, class: "box-kind" }, clip(info.kind, 20)),
      svg("text", { x: 20, y: 55, class: "box-line" }, clip(info.line, 18)),
    );
    root.append(g);
  }
  byId("canvas").replaceChildren(root);
  for (const b of byId("view-tabs").querySelectorAll<HTMLButtonElement>("[data-view]")) b.setAttribute("aria-selected", String(b.dataset["view"] === state.view));
  byId("legend-train").hidden = state.view !== "train";
  byId("legend-deps").hidden = state.view !== "deps";
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

// The detail of the selected action or package.

function actionCard(a: Action, full: boolean): HTMLElement {
  const deps = a.dependsOn.map((d) => state.plan.actions.find((x) => x.id === d)).filter((x): x is Action => Boolean(x));
  return el(
    "article",
    {
      class: `action k-${a.kind}${a.blocked ? " blocked" : ""}${state.selected === a.id ? " sel" : ""}`,
      "data-id": a.id,
      "data-kind": a.kind,
      "data-wave": String(a.wave),
    },
    el(
      "header",
      {},
      el("span", { class: "order" }, String(a.order)),
      el("span", { class: `badge t-${a.blocked ? "blocked" : a.kind}` }, a.blocked ? "Blocked" : KIND_LABEL[a.kind]),
      el("button", { type: "button", class: "repo", "data-select": a.id }, a.repo),
    ),
    el("p", { class: "why" }, a.why),
    a.packages.length
      ? el(
          "ul",
          { class: "lines" },
          ...a.packages.map((p) =>
            el(
              "li",
              {},
              el("code", {}, short(p.name)),
              " ",
              el("span", { class: "from" }, p.from ?? "new"),
              " → ",
              el("b", { class: "to" }, p.to ?? "?"),
              el("span", { class: "reason" }, semverReason(p, state.choices.bumps[p.name])),
              full ? el("span", { class: "note" }, p.why) : null,
            ),
          ),
        )
      : null,
    a.items.length
      ? el(
          "ul",
          { class: "lines" },
          ...a.items.map((i) =>
            el(
              "li",
              {},
              el("code", {}, short(i.dependent ?? a.repo)),
              " uses ",
              el("code", {}, short(i.dep)),
              " ",
              el("span", { class: "from" }, i.range),
              " → ",
              el("b", { class: "to" }, i.newRange ?? i.to),
              el("span", { class: "reason" }, i.newRange ? "the range changes" : "in range: only the lockfile"),
              full ? el("span", { class: "note" }, i.why) : null,
            ),
          ),
        )
      : null,
    a.blockers.length ? el("ul", { class: "blockers" }, ...a.blockers.map((b) => el("li", {}, b))) : null,
    deps.length ? el("p", { class: "after" }, "Waits for ", ...joinNodes(deps.map((d) => el("button", { type: "button", class: "link", "data-select": d.id }, `${KIND_LABEL[d.kind].toLowerCase()} of ${d.repo}`)))) : null,
  );
}

function joinNodes(nodes: Node[]): (Node | string)[] {
  return nodes.flatMap((n, i) => (i === 0 ? [n] : [i === nodes.length - 1 ? " and " : ", ", n]));
}

function edgeLine(e: EdgeState): HTMLElement {
  const dependent = e.fromName ? short(e.fromName) : e.from;
  return el("li", { class: `e-${e.status}` }, el("span", { class: `badge t-${e.status}` }, e.status), " ", el("code", {}, dependent), " → ", el("code", {}, short(e.to)), el("span", { class: "note" }, e.why));
}

function renderDetail(): void {
  const box = byId("detail");
  const id = state.selected;
  const a = state.plan.actions.find((x) => x.id === id);
  if (a) {
    box.replaceChildren(el("p", { class: "eyebrow" }, `${wave(a.wave)} · step ${a.order} of ${state.plan.actions.length}`), actionCard(a, true));
    return;
  }
  const n = state.plan.nodes.find((x) => x.id === id);
  if (n) {
    const out = state.plan.edges.filter((e) => e.from === `${n.repo}:${n.path || "."}`);
    box.replaceChildren(
      el("p", { class: "eyebrow" }, n.kind === "app" ? "An app" : `A package of the repository ${n.repo}`),
      el("h3", {}, n.name, " ", el("span", { class: `badge t-${n.status}` }, STATUS_LABEL[n.status])),
      el("p", { class: "why" }, n.why),
      el("p", {}, n.kind === "app" ? "Not on npm." : `npm ${n.npmLatest ?? "none"} · main ${n.version ?? "none"}${n.next ? ` · next ${n.next}` : ""}`),
      out.length ? el("ul", { class: "edges" }, ...out.map(edgeLine)) : el("p", { class: "note" }, "It depends on no package of the sample."),
      n.actions.length
        ? el("p", { class: "after" }, "Its actions: ", ...joinNodes(n.actions.map((x) => el("button", { type: "button", class: "link", "data-select": x }, x))))
        : "",
    );
    return;
  }
  box.replaceChildren(el("p", { class: "note" }, "Select a box in the drawing to see why the planner made it."));
}

function renderWaves(): void {
  const p = state.plan;
  const box = byId("waves");
  if (p.actions.length === 0) {
    box.replaceChildren(el("p", { class: "note" }, "The plan has no action. Each package and each lockfile is current."));
    return;
  }
  const groups: Action[][] = [];
  for (const a of p.actions) (groups[a.wave] ??= []).push(a);
  box.replaceChildren(
    ...groups.map((g, i) =>
      el("section", { class: "wave", "data-wave": String(i) }, el("h3", {}, wave(i), el("span", { class: "count" }, ` · ${g.length} ${g.length === 1 ? "action" : "actions"}`)), ...g.map((a) => actionCard(a, false))),
    ),
  );
}

function renderIssues(): void {
  const list = state.plan.edges.filter((e) => e.status === "blocked" || e.status === "flagged" || (e.status === "waiting" && e.why.includes("provenance")));
  const box = byId("issues");
  box.replaceChildren(
    list.length
      ? el("ul", { class: "edges" }, ...list.map(edgeLine))
      : el("p", { class: "note" }, "Nothing is blocked or held. Clear a provenance box or press a dependency to make a github: specifier."),
  );
}

// The update loop.

function render(): void {
  state.plan = planFor(state.choices);
  const ids = new Set([...state.plan.actions.map((a) => a.id), ...state.plan.nodes.map((n) => n.id)]);
  if (state.selected === null || !ids.has(state.selected)) {
    state.selected = state.view === "train" ? (state.plan.actions.find((a) => a.kind !== "new-package")?.id ?? state.plan.actions[0]?.id ?? null) : (state.plan.nodes[0]?.id ?? null);
  }
  renderScenarios();
  renderSummary();
  renderPackages();
  renderCanvas();
  renderDetail();
  renderWaves();
  renderIssues();
}

function change(fn: (c: Choices) => void): void {
  fn(state.choices);
  state.scenario = null;
  render();
}

function select(id: string): void {
  state.selected = id;
  const isAction = state.plan.actions.some((a) => a.id === id);
  const view: View = isAction ? "train" : "deps";
  state.view = view;
  renderPackages();
  renderCanvas();
  renderDetail();
  renderWaves();
}

document.addEventListener("click", (ev) => {
  const t = ev.target instanceof Element ? ev.target : null;
  if (!t) return;
  const scen = t.closest<HTMLElement>("[data-scenario]");
  if (scen) {
    const s = SCENARIOS.find((x) => x.id === scen.dataset["scenario"]);
    if (s) {
      state.choices = s.choices();
      state.scenario = s.id;
      state.selected = null;
      state.view = "train";
      render();
    }
    return;
  }
  const bump = t.closest<HTMLElement>("[data-bump]");
  if (bump) {
    const raw = bump.dataset["bump"] ?? "";
    const i = raw.lastIndexOf(":");
    const name = raw.slice(0, i);
    const kind = raw.slice(i + 1);
    change((c) => {
      if (kind === "none") delete c.bumps[name];
      else c.bumps[name] = kind as Bump;
    });
    return;
  }
  const git = t.closest<HTMLElement>("[data-git]");
  if (git) {
    const key = git.dataset["git"] ?? "";
    change((c) => {
      c.git = c.git.includes(key) ? c.git.filter((k) => k !== key) : [...c.git, key];
    });
    return;
  }
  const view = t.closest<HTMLElement>("[data-view]");
  if (view) {
    state.view = view.dataset["view"] === "deps" ? "deps" : "train";
    state.selected = null;
    render();
    return;
  }
  const pick = t.closest<HTMLElement | SVGElement>("[data-select], svg [data-id]");
  if (pick) {
    const id = pick.getAttribute("data-select") ?? pick.getAttribute("data-id");
    if (id) select(id);
  }
});

document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t instanceof HTMLInputElement && t.dataset["prov"]) {
    const name = t.dataset["prov"];
    change((c) => {
      c.noProvenance = t.checked ? c.noProvenance.filter((n) => n !== name) : [...c.noProvenance, name];
    });
  }
});

document.addEventListener("keydown", (ev) => {
  const t = ev.target instanceof Element ? ev.target.closest("svg [data-id]") : null;
  if (t && (ev.key === "Enter" || ev.key === " ")) {
    ev.preventDefault();
    const id = t.getAttribute("data-id");
    if (id) select(id);
  }
});

// The theme: auto, light or dark. The choice stays in the browser.

const THEME_KEY = "release-train-theme";
function applyTheme(t: string): void {
  if (t === "light" || t === "dark") document.documentElement.dataset["theme"] = t;
  else delete document.documentElement.dataset["theme"];
  byId("theme").textContent = `Theme: ${t === "light" || t === "dark" ? t : "auto"}`;
}
function readTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? "auto";
  } catch {
    return "auto";
  }
}
let theme = readTheme();
byId("theme").addEventListener("click", () => {
  const order = ["auto", "light", "dark"];
  theme = order[(order.indexOf(theme) + 1) % order.length] ?? "auto";
  try {
    if (theme === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A browser with no storage keeps the theme until the next load.
  }
  applyTheme(theme);
});
applyTheme(theme);

byId("build").textContent = `${__BUILD__.sha} · ${__BUILD__.date}`;
render();
