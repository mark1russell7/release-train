import semver from "semver";

/**
 * The scopes of the packages of the owner. The release train updates these packages, so the release age check
 * of pnpm (`minimumReleaseAge`) does not apply to them. The check stays for all other packages.
 */
export function ownScopes(owner: string): string[] {
  return [`@${owner}/*`, "@procedures/*"];
}

const KEY = "minimumReleaseAgeExclude";
const SCOPE_COMMENT = "# Our own packages: the release train updates them, so the release age check of pnpm does not apply to them.";

/** This function matches a text against a pattern in which `*` stands for any text. It uses no regular expression. */
export function globMatch(pattern: string, text: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === text;
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let pos = first.length;
  const end = text.length - last.length;
  for (const p of parts.slice(1, -1)) {
    const i = text.indexOf(p, pos);
    if (i < 0 || i + p.length > end) return false;
    pos = i + p.length;
  }
  return true;
}

/** This function gives the value of one YAML list item line ("  - '@scope/name@1.0.0'  # note"), without quotes. */
function itemValue(line: string): string {
  let v = line.trim().slice(1).trim();
  const hash = v.indexOf(" #");
  if (hash >= 0) v = v.slice(0, hash).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

/** This function gives the package name of an exclude entry: `@scope/name@1.0.0` gives `@scope/name`. */
function entryName(entry: string): string {
  const at = entry.indexOf("@", 1);
  return at > 0 ? entry.slice(0, at) : entry;
}

/** The result of the change of `pnpm-workspace.yaml`. */
export interface AgeRuleEdit {
  text: string;
  changed: boolean;
  /** The entries that the scope patterns cover. The change removes them. */
  removed: string[];
}

/**
 * This function puts the scope patterns into `minimumReleaseAgeExclude` of a `pnpm-workspace.yaml` text and removes
 * each entry that a scope pattern covers (for example `@owner/cue@1.0.2`). It keeps the other lines, the comments and
 * the line endings. A null text gives a new file with only this setting.
 */
export function ageRuleEdit(yaml: string | null, scopes: readonly string[]): AgeRuleEdit {
  const source = yaml ?? "";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const start = lines.findIndex((l) => l.startsWith(`${KEY}:`));
  const covered = (v: string): boolean => !scopes.includes(v) && scopes.some((s) => globMatch(s, entryName(v)));

  if (start < 0) {
    const block = [SCOPE_COMMENT, `${KEY}:`, ...scopes.map((s) => `  - "${s}"`)];
    const out = lines.length > 0 ? [...lines, "", ...block] : block;
    return { text: `${out.join(eol)}${eol}`, changed: true, removed: [] };
  }

  // The entries of the list: an inline list, or the lines of a block list (items, comments and empty lines).
  const head = lines[start] ?? "";
  const inline = head.slice(KEY.length + 1).trim();
  let end = start + 1;
  let body: string[] = [];
  if (inline.startsWith("[") && inline.endsWith("]")) {
    body = inline.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean).map((s) => `  - ${s}`);
  } else {
    while (end < lines.length) {
      const l = lines[end] ?? "";
      const t = l.trim();
      if (t !== "" && l === l.trimStart() && !t.startsWith("-")) break;
      end++;
    }
    while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end--;
    body = lines.slice(start + 1, end);
  }

  const items = body.filter((l) => l.trim().startsWith("-"));
  const indent = /^\s*/.exec(items[0] ?? "  ")?.[0] || "  ";
  const quote = items.some((l) => itemValue(l) !== l.trim().slice(1).trim() && l.includes("'")) ? "'" : '"';
  const removed: string[] = [];
  const kept: string[] = [];
  let comments: string[] = [];
  for (const l of body) {
    const t = l.trim();
    if (t.startsWith("#") || t === "") {
      comments.push(l);
      continue;
    }
    const v = itemValue(l);
    if (covered(v) || scopes.includes(v)) {
      if (covered(v)) removed.push(v);
      comments = [];
      continue;
    }
    kept.push(...comments, l);
    comments = [];
  }
  kept.push(...comments.filter((c) => c.trim() !== ""));
  const present = new Set(items.map(itemValue));
  const missing = scopes.filter((s) => !present.has(s));
  if (removed.length === 0 && missing.length === 0 && !inline.startsWith("[")) return { text: source, changed: false, removed: [] };

  const scopeLines = [`${indent}${SCOPE_COMMENT}`, ...scopes.map((s) => `${indent}- ${quote}${s}${quote}`)];
  const before = lines.slice(0, start);
  // A comment right above the key that only explains the removed entries is stale when no other entry stays.
  if (kept.length === 0 && removed.length > 0) {
    while (before.length > 0 && (before[before.length - 1] ?? "").startsWith("#")) before.pop();
  }
  const out = [...before, `${KEY}:`, ...scopeLines, ...kept, ...lines.slice(end)];
  return { text: `${out.join(eol)}${eol}`, changed: true, removed };
}

/** This function tells if a repository needs the age rule: it uses pnpm, and its settings do not have the rule yet. */
export function needsAgeRule(o: { lockKind: string; pnpmWorkspace: string | null; packageManager: string | null }, scopes: readonly string[]): boolean {
  if (o.lockKind !== "pnpm") return false;
  if (o.pnpmWorkspace !== null) return ageRuleEdit(o.pnpmWorkspace, scopes).changed;
  // Without the file, only pnpm 11 and later have a release age check (1 day by default).
  const pm = o.packageManager ?? "";
  const major = pm.startsWith("pnpm@") ? semver.coerce(pm.slice(5))?.major ?? 0 : 0;
  return major >= 11;
}
