import { createHash } from "node:crypto";
import type { FetchFn } from "./collect.ts";
import type { GitHub } from "./github.ts";

/** The branch of each template sync pull request of the release train. */
export const SYNC_BRANCH = "release-train/template";
/** The title of each template sync pull request. */
export const SYNC_TITLE = "chore(template): keep the template files in sync";
/** The kind of a template sync result in the report of `apply`. */
export const SYNC_KIND = "template-sync";
/** The name of the template repository of the owner. The sync does not change it. */
export const TEMPLATE_REPO = "template";
/**
 * The merge commit of template pull request 50. From this commit, `reusable-release-build.yml` starts the release scripts
 * of its own template commit. Thus a repository that pins this commit or a later one does not use its own `scripts/release/`.
 */
export const RELEASE_SCRIPTS_COMMIT = "29ea70d75aee6c1a170c7324509c21eead9f52a1";
/** The text of a rule that waits because the GitHub App cannot change workflow files. */
export const WORKFLOWS_WAIT = "The change waits for the Workflows permission of the App.";
/** The root script of a repository with a copy of the template CLI in `packages/cli/`. */
export const CLI_COPY_SCRIPT = "tsx packages/cli/src/index.ts package";

/** `yes`: the App can change workflow files. `no`: it cannot. `auto`: the first refused push tells. */
export type WorkflowsMode = "auto" | "yes" | "no";

/** The files of one repository: the paths of the tracked files and a reader. */
export interface RepoFiles {
  readonly paths: readonly string[];
  read(path: string): Promise<string | null>;
}

/** The facts of one run that each repository shares: the template commit, its files and the npm version of its CLI. */
export interface RunFacts {
  owner: string;
  /** The commit of the template on `main`. */
  templateSha: string;
  /** The files and folders of the template at `templateSha`, or null when GitHub did not give the full tree. */
  templatePaths: ReadonlySet<string> | null;
  /** The `latest` version of `@<owner>/template-cli` on npm, or null. */
  cliVersion: string | null;
  /** This function tells if a template commit contains `RELEASE_SCRIPTS_COMMIT`. */
  contains(sha: string): Promise<boolean>;
  /**
   * This function gives the paths of the template that changed from `sha` to `templateSha`, or null when GitHub does not
   * give them all. Without it, each old pin moves.
   */
  changedSince?(sha: string): Promise<string[] | null>;
  /** This function reads a file of the template at `templateSha`, or gives null. Without it, each old pin moves. */
  readTemplate?(path: string): Promise<string | null>;
}

/** The facts that the rules read for one repository. */
export interface SyncFacts extends RunFacts {
  repo: string;
  /** This value is true when a version of the repository is in flight. Then `release.yml` keeps its pins. */
  releaseInFlight: boolean;
}

/** The file changes of one rule. A path in `remove` is a file or a folder. */
export interface SyncEdit {
  write?: Record<string, string>;
  remove?: string[];
  /** This value is true when the lockfile must change. The updater starts the install of the package manager. */
  install?: boolean;
}

/** The result of one rule for one repository. */
export interface RuleResult {
  /** One line for each change, for the pull request body and the fingerprint. */
  changes: string[];
  edit?: SyncEdit;
  /** The problems that a person must correct. The rule does not change them. */
  needs?: string[];
  /** The changes that wait for a later run. */
  waits?: string[];
}

/** One sync rule. A new rule is a new entry of `SYNC_RULES`: the engine has no code for a specific rule. */
export interface SyncRule {
  id: string;
  /** The reason of the rule, for the pull request body. */
  why: string;
  /** The repositories that the rule does not change. */
  except?: readonly string[];
  check(files: RepoFiles, facts: SyncFacts): Promise<RuleResult | null>;
}

/** `applied`: the changes go into the pull request. `held`: the changes wait. `report`: the rule only reports. */
export type RuleState = "applied" | "held" | "report";

/** The outcome of one rule for one repository. */
export interface RuleOutcome {
  rule: string;
  state: RuleState;
  changes: string[];
  needs: string[];
  waits: string[];
}

/** The result of the sync rules for one repository. */
export interface SyncResult {
  repo: string;
  outcomes: RuleOutcome[];
  /** The new text of each changed file. */
  writes: Record<string, string>;
  /** The files and folders to delete. */
  removes: string[];
  install: boolean;
  /** A short fingerprint of the applied changes. It is empty when no change applies. */
  fingerprint: string;
}

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

/** This function makes the pattern of a pinned `uses:` line of the template. The groups: prefix, quote, path, sha, rest. */
export function pinPattern(owner: string): RegExp {
  return new RegExp(`^(\\s*(?:-\\s+)?uses:\\s*)(["']?)${escapeRe(owner)}/${TEMPLATE_REPO}/([^@\\s"']+)@([0-9a-f]{40})\\2(.*)$`);
}

/** This function moves each pin of the template in a workflow text to `sha`. It gives the new text, the count and the unknown paths. */
export function movePins(text: string, owner: string, sha: string, known: ReadonlySet<string> | null): { text: string; moved: number; missing: string[] } {
  const re = pinPattern(owner);
  let moved = 0;
  const missing = new Set<string>();
  const out = text.split("\n").map((raw) => {
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    const m = re.exec(line);
    if (!m) return raw;
    const [, pre = "", quote = "", path = ""] = m;
    if (known && !known.has(path)) {
      missing.add(path);
      return raw;
    }
    const next = `${pre}${quote}${owner}/${TEMPLATE_REPO}/${path}@${sha}${quote} # main`;
    if (next === line) return raw;
    moved++;
    return `${next}${cr}`;
  });
  return { text: out.join("\n"), moved, missing: [...missing] };
}

/** This function gives each pin of the template in a workflow text: the path and the commit. */
export function pinsOf(text: string, owner: string): { path: string; sha: string }[] {
  const re = pinPattern(owner);
  const out: { path: string; sha: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m?.[3] && m[4]) out.push({ path: m[3], sha: m[4] });
  }
  return out;
}

/**
 * This function gives the surface of a pin: the paths of the template that the pinned workflow or action reads. A shared
 * workflow reads its own file and the `sparse-checkout` paths of each checkout of `job.workflow_repository`. An action
 * reads its folder. It gives null (the whole template) when a checkout has no `sparse-checkout`, or when the text of a
 * workflow is not known.
 */
export function pinSurface(path: string, text: string | null): string[] | null {
  if (path.startsWith(".github/actions/")) return [path.replace(/\/+$/, "")];
  if (text === null) return null;
  const lines = text.split(/\r?\n/).filter((l) => !isComment(l));
  const checkouts = lines.filter((l) => /repository:\s*\$\{\{\s*job\.workflow_repository\s*\}\}/.test(l)).length;
  const sparse: string[] = [];
  let sparseKeys = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)sparse-checkout:\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    sparseKeys++;
    const value = (m[2] ?? "").replace(/\s+#.*$/, "").trim();
    if (value !== "|" && value !== ">" && value !== "") {
      sparse.push(value.replace(/^["']|["']$/g, ""));
      continue;
    }
    const indent = (m[1] ?? "").length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (l.trim() === "") continue;
      if (l.length - l.trimStart().length <= indent) break;
      sparse.push(l.trim());
    }
  }
  if (sparseKeys < checkouts) return null;
  return [path, ...sparse.map((s) => s.replace(/^\/+|\/+$/g, ""))];
}

/** This function tells if a changed path is in a surface: the path itself, or a file in a folder of the surface. */
export function inSurface(changed: string, surface: readonly string[]): boolean {
  return surface.some((s) => changed === s || changed.startsWith(`${s}/`));
}

/**
 * This function tells if the pins of a repository are old: a pin that is not `templateSha` and whose surface changed since
 * its commit. A docs change of the template thus moves no pin, and starts no CI in each repository. When a fact is not
 * known, the pins are old, as before.
 */
export async function pinsStale(pins: readonly { path: string; sha: string }[], f: RunFacts): Promise<boolean> {
  const old = pins.filter((p) => p.sha !== f.templateSha);
  if (old.length === 0) return false;
  if (!f.changedSince || !f.readTemplate) return true;
  for (const p of old) {
    const changed = await f.changedSince(p.sha);
    if (changed === null) return true;
    if (changed.length === 0) continue;
    const surface = pinSurface(p.path, p.path.startsWith(".github/actions/") ? null : await f.readTemplate(p.path));
    if (surface === null || changed.some((c) => inSurface(c, surface))) return true;
  }
  return false;
}

/** This function gives the template commit of a pinned shared workflow in a workflow text, or null. */
export function pinOf(text: string, owner: string, shared: string): string | null {
  const re = pinPattern(owner);
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m && m[3] === `.github/workflows/${shared}`) return m[4] ?? null;
  }
  return null;
}

/** This function tells if a workflow text uses a shared workflow of the template, at any ref. */
export function callsShared(text: string, owner: string, shared: string): boolean {
  const needle = `${owner}/${TEMPLATE_REPO}/.github/workflows/${shared}@`;
  return text.split(/\r?\n/).some((l) => !isComment(l) && /^\s*(?:-\s+)?uses:/.test(l) && l.includes(needle));
}

/** This function gives the JSON text of a value in the format of the original text. It keeps the indent, the line ends and the last line end. */
export function formatJson(original: string, value: unknown): string {
  const indent = /^[ \t]+(?=")/m.exec(original)?.[0] ?? "  ";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let out = JSON.stringify(value, null, indent);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (original.endsWith("\n")) out += eol;
  return out;
}

interface RootManifest {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readJson(files: RepoFiles, path: string): Promise<{ text: string; value: RootManifest } | null> {
  const text = await files.read(path);
  if (text === null) return null;
  try {
    return { text, value: JSON.parse(text) as RootManifest };
  } catch {
    return null;
  }
}

/**
 * This function lists the places that refer to a text. These are the workflow lines that are not comments, and the scripts
 * of the root `package.json`. The manifest argument replaces the root `package.json` of the files.
 */
async function references(files: RepoFiles, needles: readonly string[], manifest?: RootManifest): Promise<string[]> {
  const out: string[] = [];
  const hit = (s: string): boolean => needles.some((n) => s.includes(n));
  for (const path of files.paths.filter((p) => WORKFLOW_FILE.test(p))) {
    const text = (await files.read(path)) ?? "";
    if (text.split(/\r?\n/).some((l) => !isComment(l) && hit(l))) out.push(`\`${path}\``);
  }
  const root = manifest ?? (await readJson(files, "package.json"))?.value;
  for (const [name, script] of Object.entries(root?.scripts ?? {})) {
    if (hit(script)) out.push(`the script \`${name}\` of \`package.json\``);
  }
  return out;
}

/** The release workflows of a repository: their pins wait while a version is in flight. */
const RELEASE_FILES = new Set([".github/workflows/release.yml", ".github/workflows/release.yaml"]);

/** Rule 1: each pin of the template moves to the commit of the template on `main`. */
const pinsRule: SyncRule = {
  id: "pins",
  why: "Each workflow uses the shared workflows and actions of the template commit on `main`.",
  except: [TEMPLATE_REPO],
  async check(files, f) {
    const changes: string[] = [];
    const write: Record<string, string> = {};
    const needs: string[] = [];
    const waits: string[] = [];
    const texts = new Map<string, string>();
    for (const path of files.paths.filter((p) => WORKFLOW_FILE.test(p))) {
      const text = await files.read(path);
      if (text !== null) texts.set(path, text);
    }
    // All pins move together or none moves, so that the pins of one repository stay one commit.
    const stale = await pinsStale([...texts.values()].flatMap((t) => pinsOf(t, f.owner)), f);
    for (const [path, text] of texts) {
      const r = movePins(text, f.owner, f.templateSha, f.templatePaths);
      for (const m of r.missing) needs.push(`\`${path}\` uses \`${m}\` of the template, but the template on \`main\` does not have it.`);
      if (r.moved === 0 || !stale) continue;
      if (f.releaseInFlight && RELEASE_FILES.has(path)) {
        waits.push(`\`${path}\` keeps its pins while a version is in flight.`);
        continue;
      }
      write[path] = r.text;
      changes.push(`\`${path}\`: ${r.moved} ${r.moved === 1 ? "pin moves" : "pins move"} to \`${f.templateSha.slice(0, 7)}\` (\`main\`).`);
    }
    if (changes.length === 0 && needs.length === 0 && waits.length === 0) return null;
    return { changes, edit: { write }, needs, waits };
  },
};

/** Rule 2: a repository whose release build starts the scripts of its template commit does not need `scripts/release/`. */
const releaseScriptsRule: SyncRule = {
  id: "release-scripts",
  why: "The release build of the template runs the release scripts of its own template commit, so the copy in `scripts/release/` is dead code.",
  except: [TEMPLATE_REPO],
  async check(files, f) {
    const copy = files.paths.filter((p) => p.startsWith("scripts/release/"));
    if (copy.length === 0) return null;
    let sha: string | null = null;
    for (const path of RELEASE_FILES) {
      const text = await files.read(path);
      if (text !== null) sha = pinOf(text, f.owner, "reusable-release-build.yml");
      if (sha) break;
    }
    if (!sha || !(await f.contains(sha))) return null;
    const refs = await references(files, ["scripts/release"]);
    if (refs.length > 0) return { changes: [], needs: refs.map((r) => `\`scripts/release/\` stays, because ${r} refers to it.`) };
    return { changes: [`\`scripts/release/\` is deleted (${copy.length} ${copy.length === 1 ? "file" : "files"}).`], edit: { remove: ["scripts/release"] } };
  },
};

/** Rule 3: a repository with a copy of the template CLI in `packages/cli/` uses the published CLI. */
const templateCliRule: SyncRule = {
  id: "template-cli",
  why: "The CLI of the template is on npm, so the copy in `packages/cli/` is not necessary.",
  except: [TEMPLATE_REPO],
  async check(files, f) {
    const root = await readJson(files, "package.json");
    if (!root || root.value.scripts?.["package"] !== CLI_COPY_SCRIPT) return null;
    const cli = `@${f.owner}/template-cli`;
    if (!f.cliVersion) return { changes: [], needs: [`npm has no version of \`${cli}\`, so \`packages/cli/\` stays.`] };
    const copy = await readJson(files, "packages/cli/package.json");
    if (copy && copy.value.private !== true) return { changes: [], needs: ["`packages/cli/` stays, because its package is not private."] };
    const m = structuredClone(root.value);
    const scripts = (m.scripts ??= {});
    scripts["package"] = "template package";
    const hasTemplate = Object.hasOwn(scripts, "template");
    if (hasTemplate) scripts["template"] = "template repo";
    const dev = m.devDependencies ?? {};
    if (!dev[cli]) {
      const keys = Object.keys(dev);
      const sorted = keys.every((k, i) => i === 0 || (keys[i - 1] as string).localeCompare(k) <= 0);
      dev[cli] = `^${f.cliVersion}`;
      m.devDependencies = sorted ? Object.fromEntries(Object.entries(dev).sort(([a], [b]) => a.localeCompare(b))) : dev;
    }
    const needles = ["packages/cli", ...(copy?.value.name ? [copy.value.name] : [])];
    const refs = await references(files, needles, m);
    if (refs.length > 0) return { changes: [], needs: refs.map((r) => `\`packages/cli/\` stays, because ${r} refers to it.`) };
    const scriptsText = hasTemplate ? "The scripts `package` and `template` start" : "The script `package` starts";
    return {
      changes: ["`packages/cli/` is deleted.", `${scriptsText} \`template\` of \`${cli}@${dev[cli] ?? `^${f.cliVersion}`}\`. The lockfile changes.`],
      edit: { remove: ["packages/cli"], write: { "package.json": formatJson(root.text, m) }, install: true },
    };
  },
};

/** The callers of the shared workflows that each repository must have. Rule 4 reports each one that is not correct. */
export const CALLERS: readonly { file: string; shared: string }[] = [
  { file: "release.yml", shared: "reusable-release-build.yml" },
  { file: "ci.yml", shared: "reusable-ci.yml" },
];

/** Rule 4: a report of each workflow of `CALLERS` that does not use its shared workflow. It changes no file. */
const callersRule: SyncRule = {
  id: "callers",
  why: "The standard workflows call the shared workflows of the template (`CI.md` of the template).",
  except: [TEMPLATE_REPO],
  async check(files, f) {
    const needs: string[] = [];
    for (const c of CALLERS) {
      const path = `.github/workflows/${c.file}`;
      const text = await files.read(path);
      if (text !== null && !callsShared(text, f.owner, c.shared)) needs.push(`\`${path}\` does not call \`${c.shared}\` of the template.`);
    }
    return needs.length > 0 ? { changes: [], needs } : null;
  },
};

/** The sync rules, in the sequence of their application. A later rule reads the files after the changes of the earlier rules. */
export const SYNC_RULES: readonly SyncRule[] = [pinsRule, releaseScriptsRule, templateCliRule, callersRule];

function isWorkflowPath(p: string): boolean {
  return p === ".github" || p === ".github/workflows" || p.startsWith(".github/workflows/");
}

function editPaths(e: SyncEdit | undefined): string[] {
  return [...Object.keys(e?.write ?? {}), ...(e?.remove ?? [])];
}

/** The files of a repository after the changes of the applied rules. */
class Overlay implements RepoFiles {
  readonly writes = new Map<string, string>();
  readonly removes: string[] = [];
  private readonly base: RepoFiles;
  constructor(base: RepoFiles) {
    this.base = base;
  }
  private gone(p: string): boolean {
    return this.removes.some((r) => p === r || p.startsWith(`${r}/`));
  }
  get paths(): string[] {
    return [...new Set([...this.base.paths.filter((p) => !this.gone(p)), ...this.writes.keys()])].sort();
  }
  async read(p: string): Promise<string | null> {
    const w = this.writes.get(p);
    if (w !== undefined) return w;
    return this.gone(p) ? null : this.base.read(p);
  }
  apply(e: SyncEdit): void {
    for (const r of e.remove ?? []) {
      this.removes.push(r);
      for (const k of [...this.writes.keys()]) if (k === r || k.startsWith(`${r}/`)) this.writes.delete(k);
    }
    for (const [k, v] of Object.entries(e.write ?? {})) this.writes.set(k, v);
  }
}

async function evaluate(files: RepoFiles, facts: SyncFacts, rules: readonly SyncRule[], workflows: boolean): Promise<{ overlay: Overlay; install: boolean; outcomes: RuleOutcome[] }> {
  const overlay = new Overlay(files);
  const outcomes: RuleOutcome[] = [];
  let install = false;
  for (const rule of rules) {
    if (rule.except?.includes(facts.repo)) continue;
    const r = await rule.check(overlay, facts);
    if (!r) continue;
    const hasEdit = r.changes.length > 0 && editPaths(r.edit).length > 0;
    const waits = [...(r.waits ?? [])];
    let state: RuleState = hasEdit ? "applied" : "report";
    if (hasEdit && !workflows && editPaths(r.edit).some(isWorkflowPath)) {
      state = "held";
      waits.push(WORKFLOWS_WAIT);
    } else if (hasEdit && r.edit) {
      overlay.apply(r.edit);
      install ||= r.edit.install === true;
    }
    const needs = r.needs ?? [];
    if (state === "report" && needs.length === 0 && waits.length === 0) continue;
    outcomes.push({ rule: rule.id, state, changes: hasEdit ? r.changes : [], needs, waits });
  }
  return { overlay, install, outcomes };
}

/** This function gives a short fingerprint of the applied changes of a sync. */
export function syncFingerprint(outcomes: readonly RuleOutcome[], install: boolean): string {
  const keys = outcomes.filter((o) => o.state === "applied").flatMap((o) => o.changes.map((c) => `${o.rule}|${c}`)).sort();
  if (keys.length === 0) return "";
  if (install) keys.push("install");
  return createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 12);
}

/**
 * This function applies the sync rules to the files of one repository. When the App cannot change workflow files, a rule
 * that changes them waits. A rule that needs the change of a waiting rule (for example `release-scripts` after `pins`) waits too.
 */
export async function syncRepo(files: RepoFiles, facts: SyncFacts, rules: readonly SyncRule[] = SYNC_RULES, workflows = true): Promise<SyncResult> {
  const real = await evaluate(files, facts, rules, workflows);
  let outcomes = real.outcomes;
  if (!workflows) {
    const full = await evaluate(files, facts, rules, true);
    outcomes = [];
    for (const rule of rules) {
      const a = real.outcomes.find((x) => x.rule === rule.id);
      const b = full.outcomes.find((x) => x.rule === rule.id);
      if (b?.state === "applied" && (!a || a.state === "report")) {
        outcomes.push({ ...b, state: "held", needs: a?.needs ?? b.needs, waits: [...(a?.waits ?? b.waits), WORKFLOWS_WAIT] });
      } else if (a) outcomes.push(a);
      // A problem that shows only after a waiting change is a problem for later too (for example a script that refers to `scripts/release/`).
      else if (b) outcomes.push(b);
    }
  }
  return {
    repo: facts.repo,
    outcomes,
    writes: Object.fromEntries(real.overlay.writes),
    removes: [...real.overlay.removes],
    install: real.install,
    fingerprint: syncFingerprint(outcomes, real.install),
  };
}

/** This function gives the problems of a sync result that a person must correct, and the waits, one line each. */
export function syncNeeds(r: SyncResult): string[] {
  return r.outcomes.flatMap((o) => [...o.needs.map((n) => `${o.rule}: ${n}`), ...o.waits.map((w) => `${o.rule} waits: ${w}`)]);
}

/** This function gives the body of a template sync pull request, without the last lines. `apply` adds the fingerprint and the last lines. */
export function syncBody(r: SyncResult, rules: readonly SyncRule[] = SYNC_RULES): string {
  const why = new Map(rules.map((x) => [x.id, x.why]));
  const lines = ["The release train keeps the files of the template in sync in this repository.", "", "## What changes", ""];
  for (const o of r.outcomes.filter((x) => x.state === "applied")) {
    lines.push(`### \`${o.rule}\``, "", why.get(o.rule) ?? "", "", ...o.changes.map((c) => `- ${c}`), "");
  }
  const waits = r.outcomes.filter((o) => o.waits.length > 0);
  if (waits.length > 0) {
    lines.push("## Changes that wait", "");
    for (const o of waits) {
      const what = o.state === "held" && o.changes.length > 0 ? ` (${o.changes.join(" ")})` : "";
      for (const w of o.waits) lines.push(`- \`${o.rule}\`: ${w}${what}`);
    }
    lines.push("");
  }
  const needs = r.outcomes.filter((o) => o.needs.length > 0);
  lines.push("## Needs a hand", "");
  if (needs.length === 0) lines.push("None.");
  else for (const o of needs) for (const n of o.needs) lines.push(`- \`${o.rule}\`: ${n}`);
  return lines.join("\n");
}

/** This function gives the commit message of a template sync. */
export function syncCommitMessage(r: SyncResult): string {
  const lines = r.outcomes.filter((o) => o.state === "applied").flatMap((o) => o.changes.map((c) => `- ${o.rule}: ${c.replaceAll("`", "")}`));
  return [SYNC_TITLE, "", ...lines].join("\n");
}

/** This function reads the files of a repository on its default branch from the GitHub API. It gives null for an empty repository. */
export async function apiFiles(gh: GitHub, owner: string, repo: string): Promise<RepoFiles | null> {
  const tree = await gh.request<{ tree: { path: string; type: string }[] }>("GET", `/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`);
  if (!tree.data) return null;
  const paths = tree.data.tree.filter((t) => t.type === "blob").map((t) => t.path);
  const known = new Set(paths);
  const cache = new Map<string, Promise<string | null>>();
  return {
    paths,
    read(path) {
      if (!known.has(path)) return Promise.resolve(null);
      let p = cache.get(path);
      if (!p) {
        p = gh
          .request<{ content?: string }>("GET", `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`)
          .then((res) => (res.data?.content !== undefined ? Buffer.from(res.data.content, "base64").toString("utf8") : null));
        cache.set(path, p);
      }
      return p;
    },
  };
}

/** This function reads the facts of a run: the template commit on `main`, its files and the npm version of the template CLI. It gives null when the template is not readable. */
export async function syncFacts(o: { gh: GitHub; owner: string; fetch?: FetchFn; registry?: string }): Promise<RunFacts | null> {
  const f: FetchFn = o.fetch ?? ((u, i) => fetch(u, i));
  const base = `/repos/${o.owner}/${TEMPLATE_REPO}`;
  const head = await o.gh.request<{ sha: string }>("GET", `${base}/commits/main`);
  const templateSha = head.data?.sha;
  if (!templateSha || !/^[0-9a-f]{40}$/.test(templateSha)) return null;
  const tree = await o.gh.request<{ tree: { path: string }[]; truncated?: boolean }>("GET", `${base}/git/trees/${templateSha}?recursive=1`);
  const templatePaths = tree.data && !tree.data.truncated ? new Set(tree.data.tree.map((t) => t.path)) : null;
  let cliVersion: string | null = null;
  try {
    const name = `@${o.owner}/template-cli`;
    const res = await f(`${o.registry ?? "https://registry.npmjs.org"}/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
    if (res.ok) cliVersion = ((await res.json()) as { "dist-tags"?: Record<string, string> })["dist-tags"]?.["latest"] ?? null;
  } catch {
    cliVersion = null;
  }
  const known = new Map<string, Promise<boolean>>();
  const contains = (sha: string): Promise<boolean> => {
    let p = known.get(sha);
    if (!p) {
      p = o.gh
        .request<{ status: string }>("GET", `${base}/compare/${RELEASE_SCRIPTS_COMMIT}...${sha}`)
        .then((res) => res.data?.status === "ahead" || res.data?.status === "identical");
      known.set(sha, p);
    }
    return p;
  };
  const changes = new Map<string, Promise<string[] | null>>();
  const changedSince = (sha: string): Promise<string[] | null> => {
    let p = changes.get(sha);
    if (!p) {
      // GitHub gives at most 300 files in a compare. A longer list may be cut, so it is not known.
      p = o.gh
        .request<{ status: string; files?: { filename: string; previous_filename?: string }[] }>("GET", `${base}/compare/${sha}...${templateSha}`)
        .then((res) => {
          const d = res.data;
          if (!d || (d.status !== "ahead" && d.status !== "identical") || !d.files || d.files.length >= 300) return null;
          return d.files.flatMap((x) => (x.previous_filename ? [x.filename, x.previous_filename] : [x.filename]));
        })
        .catch(() => null);
      changes.set(sha, p);
    }
    return p;
  };
  const texts = new Map<string, Promise<string | null>>();
  const readTemplate = (path: string): Promise<string | null> => {
    let p = texts.get(path);
    if (!p) {
      p = o.gh
        .request<{ content?: string }>("GET", `${base}/contents/${path}?ref=${templateSha}`)
        .then((res) => (res.data?.content !== undefined ? Buffer.from(res.data.content, "base64").toString("utf8") : null))
        .catch(() => null);
      texts.set(path, p);
    }
    return p;
  };
  return { owner: o.owner, templateSha, templatePaths, cliVersion, contains, changedSince, readTemplate };
}

/** The work of one template sync in a clone of a repository. */
export interface SyncJob {
  repo: string;
  facts: SyncFacts;
  /** This value is false when the App cannot change workflow files. */
  workflows: boolean;
  rules?: readonly SyncRule[];
}

/**
 * The result of a template sync in a clone. `pushed`: the branch has a new commit. `same`: the branch already has these
 * changes. `no-change`: no file changes. `workflows-denied`: GitHub refused the push because the App cannot change workflow files.
 */
export interface SyncPush {
  status: "pushed" | "same" | "no-change" | "workflows-denied" | "failed";
  sha: string | null;
  /** The result of the rules on the files of the clone. */
  result: SyncResult | null;
  tool: string | null;
  error: string | null;
}

/** The part of the train that changes the files of a template sync: a clone, the rules, the lockfile update and the push. */
export interface SyncUpdater {
  sync(job: SyncJob, ctx: { defaultBranch: string; rebuild: boolean }): Promise<SyncPush>;
}

/** This function tells if the error of a push is the refusal of a workflow change for a GitHub App without the Workflows permission. */
export function workflowsRefused(error: string | null | undefined): boolean {
  return /without `?workflows`? permission/i.test(error ?? "");
}

/** The sync result of one repository in the dry run of `plan`. */
export interface SyncPlanItem {
  repo: string;
  private: boolean;
  result: SyncResult;
}

/** This function gives a text summary of the sync results: the count of repositories of each rule and state, then each repository. */
export function syncSummary(items: readonly SyncPlanItem[], rules: readonly SyncRule[] = SYNC_RULES): string {
  const lines = ["", "Template sync:"];
  for (const rule of rules) {
    const of = (s: RuleState): number => items.filter((i) => i.result.outcomes.some((o) => o.rule === rule.id && o.state === s)).length;
    const needs = items.filter((i) => i.result.outcomes.some((o) => o.rule === rule.id && o.needs.length > 0)).length;
    lines.push(`  ${rule.id.padEnd(16)} ${of("applied")} change, ${of("held")} wait, ${needs} need a hand`);
  }
  for (const i of items) {
    if (i.result.outcomes.length === 0) continue;
    const parts = i.result.outcomes.map((o) => `${o.rule}=${o.state}`);
    lines.push(`  - ${i.repo}: ${parts.join(", ")}`);
    for (const c of i.result.outcomes.flatMap((o) => (o.state === "report" ? [] : o.changes.map((x) => `${o.rule}: ${x}`)))) lines.push(`      ${c.replaceAll("`", "")}`);
    for (const n of syncNeeds(i.result)) lines.push(`      needs a hand or waits: ${n.replaceAll("`", "")}`);
  }
  return lines.join("\n");
}
