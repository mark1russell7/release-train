import { parse as parseYaml } from "yaml";
import { escapeRegExp as escapeRe } from "@mark1russell7/text";

/**
 * The permission gate of a pin move. GitHub refuses a called workflow that asks for more permissions than its caller job
 * grants: the run stops at its start (`startup_failure`). On 2026-11-26, the pins of a release workflow moved to a template
 * commit whose `reusable-release-version.yml` asked for `actions: write`. Then each release run of that repository failed.
 * The functions of this file find such a gap before the train pushes the pins.
 *
 * The rules of GitHub: the `permissions` of the caller job cap the called workflow. A caller job with no `permissions`
 * gets the `permissions` of its workflow. `write` covers `read`. `read-all` and `write-all` set each scope. In the called
 * workflow, a job with no `permissions` gets the `permissions` of its file. With none of the two, it asks for nothing more.
 */

/** The access of one permission scope. */
export type Access = "none" | "read" | "write";

/** The permissions of a job: the access of each named scope, and the access of each other scope. */
export interface Grant {
  /** The access of each scope that the block does not name. `read-all` gives `read`, `write-all` gives `write`, a map gives `none`. */
  readonly base: Access;
  readonly scopes: Readonly<Record<string, Access>>;
}

/** One scope that a called job asks for and that its caller does not grant. */
export interface MissingPermission {
  readonly scope: string;
  readonly asked: Access;
  readonly granted: Access;
}

/** One gap of the permission gate: a caller job, the called workflow, and the scopes of one called job that its caller does not grant. */
export interface PermissionGap {
  /** The job of the caller workflow. */
  readonly job: string;
  /** The path of the called workflow in the template. */
  readonly workflow: string;
  /** The commit of the called workflow. */
  readonly sha: string;
  /** The job of the called workflow that asks, with the jobs of the nested calls before it (`a > b`). Null for the file of the caller job. */
  readonly calledJob: string | null;
  readonly missing: readonly MissingPermission[];
  /** This value is true when the train cannot read the called file (`workflow` at `sha`). Then the gate cannot check it, so it holds. */
  readonly unread: boolean;
}

/** This function reads a file of the template at a commit, or gives null. */
export type ReadAt = (path: string, sha: string) => Promise<string | null>;

/** The scopes of the `GITHUB_TOKEN`. The report of a `write-all` ask names each of them. */
export const PERMISSION_SCOPES: readonly string[] = [
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
];

/** The most levels of nested called workflows that the gate follows. GitHub lets a run have four levels. */
const CALL_DEPTH = 4;

const RANK: Readonly<Record<Access, number>> = { none: 0, read: 1, write: 2 };

function access(value: unknown): Access {
  return value === "write" || value === "read" ? value : "none";
}

/**
 * This function reads a `permissions` value of a workflow or of a job. It gives null when the value is absent: then the
 * job inherits. `{}` gives no access. An unknown text gives no access.
 */
export function grantOf(value: unknown): Grant | null {
  if (value === undefined || value === null) return null;
  if (value === "write-all") return { base: "write", scopes: {} };
  if (value === "read-all") return { base: "read", scopes: {} };
  if (typeof value !== "object" || Array.isArray(value)) return { base: "none", scopes: {} };
  const scopes: Record<string, Access> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) scopes[k] = access(v);
  return { base: "none", scopes };
}

function level(g: Grant, scope: string): Access {
  return g.scopes[scope] ?? g.base;
}

/**
 * This function gives each scope that `asked` asks for and that `granted` does not cover, in the order of the scope names.
 * `write` covers `read`. An empty list is a pass.
 */
export function missingPermissions(granted: Grant, asked: Grant): MissingPermission[] {
  const names = new Set([...Object.keys(asked.scopes), ...Object.keys(granted.scopes)]);
  if (asked.base !== "none") for (const s of PERMISSION_SCOPES) names.add(s);
  const out: MissingPermission[] = [];
  for (const scope of [...names].sort()) {
    const a = level(asked, scope);
    const g = level(granted, scope);
    if (RANK[a] > RANK[g]) out.push({ scope, asked: a, granted: g });
  }
  return out;
}

interface WorkflowDoc {
  permissions?: unknown;
  jobs?: unknown;
}

interface JobDoc {
  permissions?: unknown;
  uses?: unknown;
}

function jobsOf(text: string): { doc: WorkflowDoc; jobs: [string, JobDoc][] } | null {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object") return null;
  const jobs = (doc as WorkflowDoc).jobs;
  if (jobs === null || typeof jobs !== "object") return { doc: doc as WorkflowDoc, jobs: [] };
  return { doc: doc as WorkflowDoc, jobs: Object.entries(jobs as Record<string, unknown>).map(([id, j]) => [id, (j ?? {}) as JobDoc]) };
}

/** One job of a caller workflow that calls a shared workflow of the template. */
export interface TemplateCall {
  readonly job: string;
  readonly path: string;
  readonly sha: string;
  /** The cap of the call: the `permissions` of the job, else of the workflow. Null when the file sets none: the cap is the default of the repository. */
  readonly grant: Grant | null;
}

/**
 * This function gives each job of a workflow text that calls a shared workflow of the template at a commit. A ref of a
 * composite action (`.github/actions/...`) has no permissions, so it is not in the list.
 */
export function templateCalls(text: string, owner: string, template = "template"): TemplateCall[] {
  const parsed = jobsOf(text);
  if (!parsed) return [];
  const re = new RegExp(`^${escapeRe(owner)}/${escapeRe(template)}/([^@\\s]+)@([0-9a-f]{40})$`);
  const top = grantOf(parsed.doc.permissions);
  const out: TemplateCall[] = [];
  for (const [job, j] of parsed.jobs) {
    if (typeof j.uses !== "string") continue;
    const m = re.exec(j.uses.trim());
    if (!m?.[1] || !m[2] || m[1].startsWith(".github/actions/")) continue;
    out.push({ job, path: m[1], sha: m[2], grant: grantOf(j.permissions) ?? top });
  }
  return out;
}

/**
 * This function gives the gaps of one call: each job of the called workflow (and of its nested calls) whose permissions
 * `cap` does not cover. A called file that `read` cannot give is one gap with no called job, so the gate holds.
 */
export async function callGaps(call: TemplateCall & { grant: Grant }, owner: string, read: ReadAt, template = "template"): Promise<PermissionGap[]> {
  const out: PermissionGap[] = [];
  const nested = new RegExp(`^${escapeRe(owner)}/${escapeRe(template)}/(\\.github/workflows/[^@\\s]+)@([0-9a-f]{40})$`);
  const walk = async (cap: Grant, path: string, sha: string, chain: string, depth: number): Promise<void> => {
    const text = await read(path, sha).catch(() => null);
    const parsed = text === null ? null : jobsOf(text);
    if (!parsed) {
      out.push({ job: call.job, workflow: path, sha, calledJob: chain === "" ? null : chain, missing: [], unread: true });
      return;
    }
    const top = grantOf(parsed.doc.permissions);
    for (const [id, j] of parsed.jobs) {
      const name = chain === "" ? id : `${chain} > ${id}`;
      const own = grantOf(j.permissions) ?? top;
      if (own !== null) {
        const missing = missingPermissions(cap, own);
        if (missing.length > 0) out.push({ job: call.job, workflow: call.path, sha: call.sha, calledJob: name, missing, unread: false });
      }
      if (typeof j.uses !== "string" || depth >= CALL_DEPTH) continue;
      const uses = j.uses.trim();
      // A local ref of a called workflow names a file of the same repository and commit.
      const local = uses.startsWith("./.github/workflows/") ? { path: uses.slice(2), sha } : null;
      const m = local ? null : nested.exec(uses);
      const next = local ?? (m?.[1] && m[2] ? { path: m[1], sha: m[2] } : null);
      // The own permissions of the job cap its nested call. A job with none passes the cap of its caller.
      if (next) await walk(own ?? cap, next.path, next.sha, name, depth + 1);
    }
  };
  await walk(call.grant, call.path, call.sha, "", 1);
  return out;
}

/**
 * This function gives the gaps of each template call of a workflow text. A call whose cap is the default of the repository
 * (no `permissions` in the job or in the workflow) is not examined, because the default is not known.
 */
export async function workflowGaps(text: string, owner: string, read: ReadAt, template = "template"): Promise<PermissionGap[]> {
  const out: PermissionGap[] = [];
  for (const call of templateCalls(text, owner, template)) {
    if (call.grant === null) continue;
    out.push(...(await callGaps({ ...call, grant: call.grant }, owner, read, template)));
  }
  return out;
}

/** This function gives one line of a gap for the report: the caller job, the called workflow and each missing permission. */
export function gapLine(path: string, g: PermissionGap): string {
  const at = `\`${g.workflow}\` at \`${g.sha.slice(0, 7)}\``;
  if (g.unread) {
    const through = g.calledJob === null ? "" : ` (through its job \`${g.calledJob}\`)`;
    return `\`${path}\` job \`${g.job}\` calls ${at}${through}, but the train cannot read it, so the permission gate cannot check it.`;
  }
  const list = g.missing.map((m) => `\`${m.scope}: ${m.asked}\` (the caller grants \`${m.granted}\`)`).join(", ");
  return `\`${path}\` job \`${g.job}\` calls ${at}. Its job \`${g.calledJob}\` asks for ${list}. GitHub refuses such a run at its start. Add the permissions to the caller job, or remove them from the template.`;
}
