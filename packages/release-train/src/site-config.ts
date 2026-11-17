/**
 * The move of the site values of a repository into `.github/site.json`, for the sync rule `site-config`. The rule
 * `site-check-in-ci` of `@mark1russell7/conventions` asks each repository that deploys a site with the shared Pages
 * workflow for four things:
 *
 * 1. The site values are in `.github/site.json`.
 * 2. The call of `reusable-pages.yml` gives no site value.
 * 3. No pull request starts the deploy.
 * 4. A job of `ci.yml` uses `reusable-pages-check.yml`, and the job `CI OK` needs it.
 *
 * This module changes the text of the workflows line by line, so each other line and each comment stays. It imports
 * nothing from `sync.ts`, so `sync.ts` can import it.
 */
import { PAGES_WORKFLOWS, pagesCalls } from "@mark1russell7/conventions";
import { resolveSiteConfig, SITE_CONFIG_KEYS, SITE_CONFIG_PATH, type SiteConfigKey } from "@mark1russell7/site-pages/config";
import { parse as parseYaml } from "yaml";

/** The check workflow of the template, without the owner. */
export const CHECK_WORKFLOW = "template/.github/workflows/reusable-pages-check.yml";

/** The first choice of the id of the new job of `ci.yml`. The move takes the id that `checkJobId()` gives. */
export const CHECK_JOB = "site";

/**
 * This function gives the id of the new job of the site check. It is `site` when no job of `ci.yml` has that id.
 * Else it is the first free id of `site-check`, `site-check-2`, `site-check-3` and the next ones. A repository can have
 * a job `site` of its own, for example the end-to-end tests of its site.
 */
export function checkJobId(taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(CHECK_JOB)) return CHECK_JOB;
  for (let count = 1; ; count += 1) {
    const id = count === 1 ? `${CHECK_JOB}-check` : `${CHECK_JOB}-check-${String(count)}`;
    if (!used.has(id)) return id;
  }
}

/** The name of the job that the ruleset of `main` names. */
export const GATE_NAME = "CI OK";

/** The id of a new job `CI OK`, for a `ci.yml` with no such job. */
export const GATE_JOB = "ci-ok";

/** The shared action of the step of a summary job, without the owner. */
export const GATE_ACTION = "template/.github/actions/gate-summary";

/** The inputs of a call of `reusable-pages.yml` that the call of `reusable-pages-check.yml` also takes. */
const CHECK_INPUTS: readonly string[] = ["site-config", "timeout-minutes", "artifact-prefix"];

/** The events of a pull request. */
const PULL_REQUEST: ReadonlySet<string> = new Set(["pull_request", "pull_request_target"]);

/** The value of `deploy` that only stops a deploy on a pull request. Without the event, the value is always true. */
const DEPLOY_UNLESS_PULL_REQUEST = /^\$\{\{\s*github\.event_name\s*!=\s*'pull_request'\s*\}\}$/;

/** The expressions that `.github/site.json` holds as `{owner}` and `{repo}`, in the order of the replacement. */
const REPOSITORY_EXPRESSIONS: readonly (readonly [RegExp, string])[] = [
  [/\$\{\{\s*github\.repository\s*\}\}/g, "{owner}/{repo}"],
  [/\$\{\{\s*github\.repository_owner\s*\}\}/g, "{owner}"],
  [/\$\{\{\s*github\.event\.repository\.name\s*\}\}/g, "{repo}"],
];

/** One workflow file of a repository. */
export interface WorkflowText {
  readonly path: string;
  readonly text: string;
}

/** The input of {@link moveSiteConfig}. */
export interface SiteMoveInput {
  /** The home account of the template. The new job pins the workflows of the template of this account. */
  readonly owner: string;
  /** The account of the repository. Absent: the account is `owner`. */
  readonly account?: string | undefined;
  readonly repo: string;
  /** The commit of the template on `main`. The new job pins its check workflow to it. */
  readonly templateSha: string;
  /** Each workflow file of the repository. */
  readonly workflows: readonly WorkflowText[];
  /** The text of `.github/site.json`, or null when the repository has no such file. */
  readonly config: string | null;
}

/** The result of {@link moveSiteConfig}. */
export interface SiteMove {
  /** The new site config, in the order of the inputs, or null when the file does not change. */
  readonly config: Record<string, unknown> | null;
  /** The new text of each changed workflow. */
  readonly writes: Record<string, string>;
  /** One line for each change. */
  readonly changes: string[];
  /** The problems that a person must correct. With a problem, the result changes nothing. */
  readonly needs: string[];
}

/** This function gives the count of spaces before the text of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** This function tells if a line has no YAML node: a blank line or a comment. */
function quiet(line: string): boolean {
  const text = line.trim();
  return text === "" || text.startsWith("#");
}

/** This function gives the key of a line of a block map with no quotes, or undefined. A list item (`- push`) gives its value. */
function keyOf(line: string): string | undefined {
  const match = /^\s*(?:-\s+)?([\w.-]+|"[^"]*"|'[^']*')\s*(?::(?:\s|$)|$)/.exec(line);
  return match?.[1]?.replace(/^["']|["']$/g, "");
}

/** This function gives the text after the colon of a line `key: value`, with no comment, or undefined. */
function valueAfter(line: string): string | undefined {
  const at = line.indexOf(":");
  if (at < 0) return undefined;
  return line.slice(at + 1).replace(/\s+#.*$/, "").trim();
}

/**
 * This function gives the end of the block of the line `at`. The end is the line after the last line with a node and a
 * larger indent. A blank line or a comment after the last node stays out of the block.
 */
function blockEnd(lines: readonly string[], at: number): number {
  const indent = indentOf(lines[at] ?? "");
  let end = at + 1;
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    if (indentOf(line) <= indent) break;
    if (!line.trim().startsWith("#")) end = index + 1;
  }
  return end;
}

/** This function gives the lines of the children of the line `at`: each line with a node at the indent of the first child. */
function children(lines: readonly string[], at: number): number[] {
  const end = blockEnd(lines, at);
  const nodes: number[] = [];
  let indent = -1;
  for (let index = at + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (quiet(line)) continue;
    if (indent < 0) indent = indentOf(line);
    if (indentOf(line) === indent) nodes.push(index);
  }
  return nodes;
}

/** This function gives the first line of the comments directly above the line `at`, at the indent of that line. */
function commentStart(lines: readonly string[], at: number): number {
  let start = at;
  while (start > 0 && (lines[start - 1] ?? "").trim().startsWith("#") && indentOf(lines[start - 1] ?? "") === indentOf(lines[at] ?? "")) start -= 1;
  return start;
}

/** This function gives the line of the job of the line `at`: the nearest line above it with a node and a smaller indent. */
function jobOf(lines: readonly string[], at: number): number {
  let job = at - 1;
  while (job >= 0 && (quiet(lines[job] ?? "") || indentOf(lines[job] ?? "") >= indentOf(lines[at] ?? ""))) job -= 1;
  return job;
}

/** This function gives the line of the top key `key`, or -1. */
function topKey(lines: readonly string[], key: string): number {
  return lines.findIndex((line) => indentOf(line) === 0 && !quiet(line) && keyOf(line) === key);
}

/** This function puts `{owner}` and `{repo}` in place of the expressions of the repository. */
function repositoryForms(text: string): string {
  return REPOSITORY_EXPRESSIONS.reduce((value, [pattern, form]) => value.replace(pattern, form), text);
}

/** This function puts the owner and the name in place of the expressions of the repository, as the workflow does. */
function repositoryValues(text: string, owner: string, repo: string): string {
  return repositoryForms(text).replaceAll("{owner}", owner).replaceAll("{repo}", repo);
}

/** One entry of the `with` block of a call: its key, its first line with the comments above it, and its end. */
interface WithEntry {
  readonly key: string;
  readonly start: number;
  readonly line: number;
  readonly end: number;
  readonly value: unknown;
}

/** This function gives the entries of the `with` block at the line `at`, with their values as YAML gives them. */
function withEntries(lines: readonly string[], at: number): WithEntry[] | string {
  const entries: WithEntry[] = [];
  for (const line of children(lines, at)) {
    const key = keyOf(lines[line] ?? "");
    if (key === undefined) return `line ${line + 1} is not a key of the block with`;
    const end = blockEnd(lines, line);
    const indent = indentOf(lines[line] ?? "");
    const text = lines.slice(line, end).map((part) => part.slice(Math.min(indent, indentOf(part)))).join("\n");
    let value: unknown;
    try {
      value = (parseYaml(text) as Record<string, unknown> | null)?.[key];
    } catch (error) {
      return `the value of ${key} is not YAML: ${(error as Error).message}`;
    }
    entries.push({ key, start: commentStart(lines, line), line, end, value });
  }
  return entries;
}

/** This function gives the value of one site key for `.github/site.json`, with `{owner}` and `{repo}`, or an error. */
function fileValue(key: SiteConfigKey, value: unknown): { value: unknown } | { error: string } {
  const kind = SITE_CONFIG_KEYS[key].kind;
  if (kind === "boolean") {
    if (typeof value === "boolean") return { value };
    if (value === "true" || value === "false") return { value: value === "true" };
    return { error: `${key} is not true or false` };
  }
  if (typeof value !== "string" && typeof value !== "number") return { error: `${key} is not a string` };
  const text = repositoryForms(String(value));
  if (text.includes("${{")) return { error: `${key} has an expression of the workflow that ${SITE_CONFIG_PATH} cannot hold` };
  if (kind === "string") return { value: text };
  if (text.trim() === "") return { value: {} };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return { error: `env is not JSON: ${(error as Error).message}` };
  }
}

/** This function gives the value of one site key as the old workflow gave it to `reusable-pages.yml`. */
function inputValue(value: unknown, owner: string, repo: string): unknown {
  return typeof value === "string" || typeof value === "number" ? repositoryValues(String(value), owner, repo) : value;
}

/** This function removes the line ranges `[start, end)` from the lines. */
function without(lines: readonly string[], ranges: readonly (readonly [number, number])[]): string[] {
  const gone = new Set(ranges.flatMap(([start, end]) => Array.from({ length: end - start }, (_, index) => start + index)));
  return lines.filter((_, index) => !gone.has(index));
}

/** The move of the values of one deploy call: the new lines of its workflow and the site config, or a problem. */
function moveCall(lines: readonly string[], call: number, input: SiteMoveInput): { lines: string[]; config: Record<string, unknown> | null; carry: Record<string, unknown>; moved: string[]; error?: string } {
  const job = jobOf(lines, call);
  const withLine = job < 0 ? undefined : children(lines, job).find((line) => keyOf(lines[line] ?? "") === "with");
  // With no site value and no site config, the file gets the defaults: the site of a call with no input
  const defaults = input.config === null ? {} : null;
  if (withLine === undefined) return { lines: [...lines], config: defaults, carry: {}, moved: [] };
  const entries = withEntries(lines, withLine);
  if (typeof entries === "string") return { lines: [...lines], config: null, carry: {}, moved: [], error: entries };
  const site = entries.filter((entry) => Object.hasOwn(SITE_CONFIG_KEYS, entry.key));
  const carry = Object.fromEntries(entries.filter((entry) => CHECK_INPUTS.includes(entry.key)).map((entry) => [entry.key, entry.value]));
  if (site.length === 0) return { lines: [...lines], config: defaults, carry, moved: [] };
  if (input.config !== null) return { lines: [...lines], config: null, carry, moved: [], error: `the repository has ${SITE_CONFIG_PATH}, and the call also gives ${site.map((entry) => entry.key).join(", ")}` };
  const config: Record<string, unknown> = {};
  const inputs: Record<string, unknown> = {};
  for (const entry of site) {
    const result = fileValue(entry.key as SiteConfigKey, entry.value);
    if ("error" in result) return { lines: [...lines], config: null, carry, moved: [], error: result.error };
    config[entry.key] = result.value;
    inputs[entry.key] = inputValue(entry.value, input.account ?? input.owner, input.repo);
  }
  // A gate: the file gives the same site as the old inputs, or nothing changes
  const repository = `${input.account ?? input.owner}/${input.repo}`;
  const before = resolveSiteConfig({ file: undefined, path: SITE_CONFIG_PATH, inputs, repository });
  const after = resolveSiteConfig({ file: JSON.stringify(config), path: SITE_CONFIG_PATH, inputs: undefined, repository });
  if ("error" in before || "error" in after) return { lines: [...lines], config: null, carry, moved: [], error: "error" in before ? before.error : (after as { error: string }).error };
  if (JSON.stringify(before.config) !== JSON.stringify(after.config)) return { lines: [...lines], config: null, carry, moved: [], error: `${SITE_CONFIG_PATH} does not give the same site as the inputs` };
  const ranges: [number, number][] = site.map((entry) => [entry.start, entry.end]);
  // With no site value left, the block with goes if nothing else is in it
  const rest = entries.filter((entry) => !Object.hasOwn(SITE_CONFIG_KEYS, entry.key));
  if (rest.length === 0) ranges.push([commentStart(lines, withLine), withLine + 1]);
  return { lines: without(lines, ranges), config, carry, moved: site.map((entry) => entry.key) };
}

/** This function removes the events of a pull request from the key `on` of a workflow, and the value of `deploy` that only they need. */
function dropPullRequest(lines: readonly string[]): { lines: string[]; dropped: string[]; error?: string } {
  const on = topKey(lines, "on");
  if (on < 0) return { lines: [...lines], dropped: [] };
  const inline = valueAfter(lines[on] ?? "") ?? "";
  if (inline !== "") {
    const events = inline.replace(/^\[|\]$/g, "").split(",").map((event) => event.trim().replace(/^["']|["']$/g, ""));
    return events.some((event) => PULL_REQUEST.has(event)) ? { lines: [...lines], dropped: [], error: `the key on of the deploy workflow is on one line (${inline})` } : { lines: [...lines], dropped: [] };
  }
  const events = children(lines, on).filter((line) => PULL_REQUEST.has(keyOf(lines[line] ?? "") ?? ""));
  if (events.length === 0) return { lines: [...lines], dropped: [] };
  if (events.length === children(lines, on).length) return { lines: [...lines], dropped: [], error: "the deploy workflow starts only on a pull request" };
  const ranges: [number, number][] = events.map((line) => [commentStart(lines, line), blockEnd(lines, line)]);
  for (let index = 0; index < lines.length; index += 1) {
    if (keyOf(lines[index] ?? "") === "deploy" && DEPLOY_UNLESS_PULL_REQUEST.test(valueAfter(lines[index] ?? "") ?? "")) ranges.push([commentStart(lines, index), index + 1]);
  }
  return { lines: without(lines, ranges), dropped: events.map((line) => keyOf(lines[line] ?? "") ?? "") };
}

/** This function removes each key `with` that has no value and no child, with the comments directly above it. */
function dropEmptyWith(lines: readonly string[]): string[] {
  const ranges: [number, number][] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (keyOf(lines[index] ?? "") === "with" && valueAfter(lines[index] ?? "") === "" && children(lines, index).length === 0) ranges.push([commentStart(lines, index), blockEnd(lines, index)]);
  }
  return without(lines, ranges);
}

/** This function gives the YAML text of one input value of the new job. */
function yamlScalar(value: unknown): string {
  return typeof value === "string" && !/^[\w./-]+$/.test(value) ? JSON.stringify(value) : String(value);
}

/** This function gives the lines of a new job `CI OK` that needs each job of `ids` and lets each job of `skips` skip. */
function gateJob(pad: string, ids: readonly string[], skips: readonly string[], input: SiteMoveInput): string[] {
  const expression = (text: string) => "${{ " + text + " }}";
  return [
    `${pad}# The summary check of the ruleset of main: each job passed (CI.md of the template, "The check of the`,
    `${pad}# ruleset").`,
    `${pad}${GATE_JOB}:`,
    `${pad}  name: ${GATE_NAME}`,
    `${pad}  if: ${expression("!cancelled()")}`,
    `${pad}  needs: [${ids.join(", ")}]`,
    `${pad}  runs-on: ubuntu-latest`,
    `${pad}  timeout-minutes: 2`,
    `${pad}  permissions: {}`,
    `${pad}  steps:`,
    `${pad}    - uses: ${input.owner}/${GATE_ACTION}@${input.templateSha} # main`,
    `${pad}      with:`,
    `${pad}        needs: ${expression("toJSON(needs)")}`,
    ...(skips.length > 0 ? [`${pad}        # The jobs that their own if can skip. Each other job must pass.`, `${pad}        allow-skip: ${JSON.stringify(skips.join(" "))}`] : []),
  ];
}

/** This function adds the job of the site check to `ci.yml` and to the needs of `CI OK`, or gives the problem. */
function addCheckJob(text: string, input: SiteMoveInput, carry: Record<string, unknown>): { text: string; jobId: string; gate?: boolean; error?: string } {
  const lines = text.split("\n");
  const jobs = topKey(lines, "jobs");
  if (jobs < 0) return { text, jobId: CHECK_JOB, error: "ci.yml has no jobs" };
  const ids = children(lines, jobs);
  const names = ids.map((line) => keyOf(lines[line] ?? "") ?? "");
  const jobId = checkJobId(names);
  const gate = ids.find((line) => children(lines, line).some((key) => keyOf(lines[key] ?? "") === "name" && (valueAfter(lines[key] ?? "") ?? "").replace(/^["']|["']$/g, "") === GATE_NAME));
  const pad = " ".repeat(indentOf(lines[gate ?? ids[0] ?? -1] ?? "  "));
  const withLines = Object.entries(carry).map(([key, given]) => `${pad}    ${key}: ${yamlScalar(given)}`);
  const job = [
    `${pad}# The site of ${SITE_CONFIG_PATH}: the build, the site check and the probe, with no deploy (CI.md of the`,
    `${pad}# template, "The site config"). The Pages workflow deploys the same site from main.`,
    `${pad}${jobId}:`,
    `${pad}  uses: ${input.owner}/${CHECK_WORKFLOW}@${input.templateSha} # main`,
    `${pad}  permissions:`,
    `${pad}    contents: read`,
    ...(withLines.length > 0 ? [`${pad}  with:`, ...withLines] : []),
  ];
  if (gate === undefined) {
    // No summary job: a new job CI OK needs each job. The daily check of the rulesets asks the owner to require it.
    if (ids.some((line) => keyOf(lines[line] ?? "") === GATE_JOB)) return { text, jobId, error: `ci.yml has a job ${GATE_JOB} with no name ${GATE_NAME}` };
    const skips = ids.filter((line) => children(lines, line).some((key) => keyOf(lines[key] ?? "") === "if")).map((line) => keyOf(lines[line] ?? "") ?? "");
    const end = blockEnd(lines, jobs);
    return { text: [...lines.slice(0, end), "", ...job, "", ...gateJob(pad, [...names, jobId], skips, input), ...lines.slice(end)].join("\n"), jobId, gate: true };
  }
  const needsLine = children(lines, gate).find((key) => keyOf(lines[key] ?? "") === "needs");
  if (needsLine === undefined) return { text, jobId, error: `the job ${GATE_NAME} of ci.yml has no needs` };
  const out = [...lines];
  const value = valueAfter(lines[needsLine] ?? "") ?? "";
  if (value.startsWith("[") && value.endsWith("]")) {
    const list = value.slice(1, -1).split(",").map((id) => id.trim()).filter(Boolean);
    out[needsLine] = (lines[needsLine] ?? "").replace(value, `[${[...list, jobId].join(", ")}]`);
  } else if (value !== "") {
    out[needsLine] = (lines[needsLine] ?? "").replace(value, `[${value}, ${jobId}]`);
  } else {
    const items = children(lines, needsLine);
    const last = items[items.length - 1];
    if (last === undefined) return { text, jobId, error: `the needs of the job ${GATE_NAME} of ci.yml are empty` };
    out.splice(last + 1, 0, `${" ".repeat(indentOf(lines[last] ?? ""))}- ${jobId}`);
  }
  out.splice(commentStart(lines, gate), 0, ...job, "");
  return { jobId, text: out.join("\n") };
}

/**
 * This function moves the site values of a repository into `.github/site.json`, and gives the changes of the workflows.
 * It gives null when the repository deploys no site with `reusable-pages.yml`, or has the form of `site-check-in-ci`.
 * With a problem, it changes nothing and gives the problem. The site of the file is the site of the old inputs: a gate
 * compares the two configs of `resolveSiteConfig`.
 */
export function moveSiteConfig(input: SiteMoveInput): SiteMove | null {
  const workflows = new Map(input.workflows.map((workflow) => [workflow.path, workflow.text]));
  const deploys = input.workflows.flatMap((workflow) => pagesCalls(workflow.text, PAGES_WORKFLOWS).filter((call) => call.deploys).map((call) => ({ path: workflow.path, line: call.line })));
  if (deploys.length === 0) return null;
  const fail = (problem: string): SiteMove => ({ config: null, writes: {}, changes: [], needs: [`The move of the site values into \`${SITE_CONFIG_PATH}\` needs a hand: ${problem}.`] });
  if (deploys.length > 1) return fail(`${deploys.length} jobs deploy a site with \`reusable-pages.yml\``);
  const deploy = deploys[0]!;
  const crlf = (workflows.get(deploy.path) ?? "").includes("\r\n");
  const original = (workflows.get(deploy.path) ?? "").replace(/\r\n/g, "\n");
  const moved = moveCall(original.split("\n"), deploy.line - 1, input);
  if (moved.error !== undefined) return fail(`\`${deploy.path}\`: ${moved.error}`);
  const events = dropPullRequest(moved.lines);
  if (events.error !== undefined) return fail(`\`${deploy.path}\`: ${events.error}`);
  for (const caller of input.workflows) {
    if (caller.path === deploy.path) continue;
    const callerLines = caller.text.replace(/\r\n/g, "\n").split("\n");
    const on = topKey(callerLines, "on");
    const starts = on >= 0 && (children(callerLines, on).some((line) => PULL_REQUEST.has(keyOf(callerLines[line] ?? "") ?? "")) || /pull_request/.test(valueAfter(callerLines[on] ?? "") ?? ""));
    if (starts && callerLines.some((line) => keyOf(line) === "uses" && (valueAfter(line) ?? "").split("@")[0] === `./${deploy.path}`)) {
      return fail(`\`${caller.path}\` starts on a pull request and calls \`${deploy.path}\``);
    }
  }
  const changes: string[] = [];
  const writes: Record<string, string> = {};
  const deployText = dropEmptyWith(events.lines).join("\n");
  if (deployText !== original) writes[deploy.path] = crlf ? deployText.replace(/\n/g, "\r\n") : deployText;
  if (moved.config !== null && moved.moved.length > 0) changes.push(`\`${SITE_CONFIG_PATH}\` gets the site values of \`${deploy.path}\`: ${moved.moved.map((key) => `\`${key}\``).join(", ")}. The call gives no site value.`);
  if (moved.config !== null && moved.moved.length === 0) changes.push(`\`${SITE_CONFIG_PATH}\` gets the defaults: the call of \`${deploy.path}\` gives no site value.`);
  if (events.dropped.length > 0) changes.push(`\`${deploy.path}\` does not start on ${events.dropped.map((event) => `\`${event}\``).join(" or ")}: a job of a pull request gets no \`pages: write\`.`);
  const checks = input.workflows.flatMap((workflow) => pagesCalls(workflow.text, [`${input.owner}/${CHECK_WORKFLOW}`, "./.github/workflows/reusable-pages-check.yml"]).map(() => workflow.path));
  if (checks.length === 0) {
    const ciPath = [".github/workflows/ci.yml", ".github/workflows/ci.yaml"].find((path) => workflows.has(path));
    if (ciPath === undefined) return fail("the repository has no `.github/workflows/ci.yml`");
    const ciCrlf = (workflows.get(ciPath) ?? "").includes("\r\n");
    const ci = addCheckJob((writes[ciPath] ?? workflows.get(ciPath) ?? "").replace(/\r\n/g, "\n"), input, moved.carry);
    if (ci.error !== undefined) return fail(`\`${ciPath}\`: ${ci.error}`);
    writes[ciPath] = ciCrlf ? ci.text.replace(/\n/g, "\r\n") : ci.text;
    changes.push(`\`${ciPath}\` gets the job \`${ci.jobId}\` (\`reusable-pages-check.yml\`, \`contents: read\`), and \`${GATE_NAME}\` needs it.`);
    if (ci.gate === true) changes.push(`\`${ciPath}\` gets the summary job \`${GATE_NAME}\` (the action \`gate-summary\`), and it needs each job. The daily check of the rulesets lists it until the ruleset of \`main\` requires it.`);
  }
  if (changes.length === 0) return null;
  return { config: moved.config, writes, changes, needs: [] };
}
