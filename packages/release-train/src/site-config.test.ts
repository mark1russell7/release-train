import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { siteCheckInCi } from "@mark1russell7/conventions";
import { resolveSiteConfig, SITE_CONFIG_PATH } from "@mark1russell7/site-pages/config";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { moveSiteConfig, type SiteMove, type WorkflowText } from "./site-config.ts";
import { SITE_CONFIG_COMMENT, syncRepo, type RepoFiles, type SyncFacts } from "./sync.ts";

const OWNER = "mark1russell7";
const REPO = "demo-site";
const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const PAGES = ".github/workflows/pages.yml";
const CI = ".github/workflows/ci.yml";

/** A Pages workflow that deploys with `reusable-pages.yml`, with the lines of `withLines` in its block `with`. */
function pages(withLines: readonly string[], on: readonly string[] = ["  push:", "    branches: [main]", "  workflow_dispatch:", "  pull_request:"]): string {
  return [
    "name: Pages",
    "",
    "on:",
    ...on,
    "",
    "permissions: {}",
    "",
    "jobs:",
    "  pages:",
    `    uses: ${OWNER}/template/.github/workflows/reusable-pages.yml@${OLD} # main`,
    "    permissions:",
    "      contents: read",
    "      pages: write",
    "      id-token: write",
    ...(withLines.length > 0 ? ["    with:", ...withLines.map((line) => `      ${line}`)] : []),
    "",
  ].join("\n");
}

/** A CI workflow with a job `ci` and a summary job `CI OK` that needs it, in the form of `needs`. */
function ci(needs: readonly string[] = ["    needs: [ci]"]): string {
  return [
    "name: CI",
    "on:",
    "  pull_request:",
    "jobs:",
    "  ci:",
    `    uses: ${OWNER}/template/.github/workflows/reusable-ci.yml@${OLD} # main`,
    "",
    "  ci-ok:",
    "    name: CI OK",
    "    if: ${{ !cancelled() }}",
    ...needs,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
}

/** A CI workflow with no summary job: the checks of the ruleset are the jobs of `reusable-ci.yml`. */
const ciNoGate = [
  "name: CI",
  "on:",
  "  pull_request:",
  "jobs:",
  "  ci:",
  `    uses: ${OWNER}/template/.github/workflows/reusable-ci.yml@${OLD} # main`,
  "  presets:",
  "    if: github.event_name == 'pull_request'",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo presets",
  "",
].join("\n");

const DEPLOY_LINE = "deploy: ${{ github.event_name != 'pull_request' }}";

const STANDARD = [
  "# The build of the site package.",
  "build: pnpm --filter @demo/site run build",
  "out: packages/site/dist",
  `env: '{"SITE_BASE": "/\${{ github.event.repository.name }}"}'`,
  DEPLOY_LINE,
  'packages: "@demo/core"',
  "site-check: true",
  "site-check-pages: /,/releases/",
];

function move(workflows: Record<string, string>, config: string | null = null): SiteMove | null {
  return moveSiteConfig({ owner: OWNER, repo: REPO, templateSha: SHA, workflows: Object.entries(workflows).map(([path, text]) => ({ path, text })), config });
}

/** The files of a repository after a move: each workflow with its new text, and the new site config. */
function after(workflows: Record<string, string>, result: SiteMove, config: string | null = null): { workflows: WorkflowText[]; config: string | null } {
  return {
    workflows: Object.entries(workflows).map(([path, text]) => ({ path, text: result.writes[path] ?? text })),
    config: result.config === null ? config : `${JSON.stringify({ $comment: SITE_CONFIG_COMMENT, ...result.config }, null, 2)}\n`,
  };
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The breaks of the rule `site-check-in-ci` of conventions on the files, with the options of the rule. */
function breaksOf(files: { workflows: WorkflowText[]; config: string | null }): string[] {
  const root = mkdtempSync(join(tmpdir(), "site-config-"));
  roots.push(root);
  const paths: string[] = [];
  for (const workflow of files.workflows) {
    mkdirSync(dirname(join(root, workflow.path)), { recursive: true });
    writeFileSync(join(root, workflow.path), workflow.text);
    paths.push(workflow.path);
  }
  if (files.config !== null) {
    writeFileSync(join(root, SITE_CONFIG_PATH), files.config);
    paths.push(SITE_CONFIG_PATH);
  }
  const defaults = Object.fromEntries(Object.entries(siteCheckInCi.options ?? {}).map(([key, option]) => [key, option.default]));
  const result = siteCheckInCi.check({ root, gitFiles: () => paths } as never, defaults as never);
  return (Array.isArray(result) ? result : []).map((b: { message: string }) => b.message);
}

/** The gates of each move: the conventions rule passes on the output, each workflow parses, and a second run changes nothing. */
function expectGates(workflows: Record<string, string>, result: SiteMove | null, config: string | null = null): { workflows: WorkflowText[]; config: string | null } {
  expect(result).not.toBeNull();
  expect(result?.needs).toEqual([]);
  const out = after(workflows, result!, config);
  expect(breaksOf({ workflows: Object.entries(workflows).map(([path, text]) => ({ path, text })), config }).length).toBeGreaterThan(0);
  expect(breaksOf(out)).toEqual([]);
  for (const workflow of out.workflows) {
    const doc = parseYaml(workflow.text) as { jobs: Record<string, Record<string, unknown>> };
    for (const job of Object.values(doc.jobs)) if ("with" in job) expect(job["with"]).toBeTypeOf("object");
  }
  expect(moveSiteConfig({ owner: OWNER, repo: REPO, templateSha: SHA, ...out })).toBeNull();
  return out;
}

describe("moveSiteConfig", () => {
  it("moves the site values into .github/site.json, and the file gives the site of the old inputs", () => {
    const workflows = { [PAGES]: pages(STANDARD), [CI]: ci() };
    const result = move(workflows);
    const out = expectGates(workflows, result);
    expect(result?.config).toEqual({
      build: "pnpm --filter @demo/site run build",
      out: "packages/site/dist",
      env: { SITE_BASE: "/{repo}" },
      packages: "@demo/core",
      "site-check": true,
      "site-check-pages": "/,/releases/",
    });
    // Parity: the file gives the config that the inputs of the old call gave
    const inputs = { build: "pnpm --filter @demo/site run build", out: "packages/site/dist", env: `{"SITE_BASE": "/${REPO}"}`, packages: "@demo/core", "site-check": true, "site-check-pages": "/,/releases/" };
    const before = resolveSiteConfig({ file: undefined, path: SITE_CONFIG_PATH, inputs, repository: `${OWNER}/${REPO}` });
    const now = resolveSiteConfig({ file: out.config ?? undefined, path: SITE_CONFIG_PATH, inputs: undefined, repository: `${OWNER}/${REPO}` });
    expect("config" in before && "config" in now && before.config).toEqual("config" in now ? now.config : null);
    const text = result?.writes[PAGES] ?? "";
    expect(text).not.toContain("with:");
    expect(text).not.toContain("pull_request");
    expect(text).not.toContain("# The build of the site package.");
    expect(text).toContain("  workflow_dispatch:\n");
    expect(result?.writes[CI]).toContain(`  site:\n    uses: ${OWNER}/template/.github/workflows/reusable-pages-check.yml@${SHA} # main\n    permissions:\n      contents: read\n`);
    expect(result?.writes[CI]).toContain("    needs: [ci, site]\n");
    expect(result?.changes).toHaveLength(3);
  });

  it("reads a block value, a value with a comment, the owner and the repository, and keeps the inputs of another kind", () => {
    const workflows = {
      [PAGES]: pages([
        "build: |",
        "  pnpm --filter @demo/site run build",
        "  node scripts/stamp.ts",
        "out: dist # the folder of the build",
        'site-name: "${{ github.repository_owner }} ${{ github.event.repository.name }}"',
        "base: /${{ github.repository }}/",
        "timeout-minutes: 30",
        DEPLOY_LINE,
      ]),
      [CI]: ci(["    needs:", "      - ci"]),
    };
    const result = move(workflows);
    expectGates(workflows, result);
    expect(result?.config).toEqual({ build: "pnpm --filter @demo/site run build\nnode scripts/stamp.ts\n", out: "dist", "site-name": "{owner} {repo}", base: "/{owner}/{repo}/" });
    expect(result?.writes[PAGES]).toContain("    with:\n      timeout-minutes: 30\n");
    // The check job takes the time limit of the deploy call
    expect(result?.writes[CI]).toContain("    with:\n      timeout-minutes: 30\n");
    expect(result?.writes[CI]).toContain("      - ci\n      - site\n");
  });

  it("adds a summary job CI OK with the shared action when ci.yml has none, and allows the skip of a job with its own if", () => {
    const workflows = { [PAGES]: pages(STANDARD), [CI]: ciNoGate };
    const result = move(workflows);
    expectGates(workflows, result);
    const text = result?.writes[CI] ?? "";
    expect(text).toContain("  ci-ok:\n    name: CI OK\n    if: ${{ !cancelled() }}\n    needs: [ci, presets, site]\n");
    expect(text).toContain(`      - uses: ${OWNER}/template/.github/actions/gate-summary@${SHA} # main\n        with:\n          needs: \${{ toJSON(needs) }}\n`);
    expect(text).toContain('          allow-skip: "presets"\n');
    expect(result?.changes.some((c) => c.includes("summary job"))).toBe(true);
  });

  it("keeps the line ends of a file with CRLF", () => {
    const workflows = { [PAGES]: pages(STANDARD).replace(/\n/g, "\r\n"), [CI]: ci().replace(/\n/g, "\r\n") };
    const result = move(workflows);
    expectGates(workflows, result);
    for (const text of Object.values(result?.writes ?? {})) expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("removes only the events of a pull request from the on of the deploy, and keeps the values of a repository with a site config", () => {
    const config = `${JSON.stringify({ build: "pnpm build", out: "dist" }, null, 2)}\n`;
    const on = ["  push:", "    branches: [main]", "  # A check of each pull request", "  pull_request:", "    branches: [main]", "  pull_request_target:", "  schedule:", '    - cron: "8 */3 * * *"'];
    const workflows = { [PAGES]: pages([], on), [CI]: ci() };
    const result = move(workflows, config);
    expectGates(workflows, result, config);
    expect(result?.config).toBeNull();
    expect(result?.writes[PAGES]).toContain('on:\n  push:\n    branches: [main]\n  schedule:\n    - cron: "8 */3 * * *"\n');
  });

  it("gives a deploy with no site value and no site config a site config with the defaults", () => {
    const workflows = { [PAGES]: pages([DEPLOY_LINE]), [CI]: ci() };
    const result = move(workflows);
    expectGates(workflows, result);
    expect(result?.config).toEqual({});
    expect(result?.changes[0]).toContain("gets the defaults");
  });

  it("gives null for a repository with no deploy, and for a repository in the form of the rule", () => {
    expect(move({ [CI]: ci() })).toBeNull();
    expect(move({ [PAGES]: pages(["deploy: false", ...STANDARD.filter((line) => !line.startsWith("deploy"))]), [CI]: ci() })).toBeNull();
  });

  it.each([
    ["an expression that the file cannot hold", { [PAGES]: pages(["build: pnpm build ${{ secrets.TOKEN }}", "out: dist"]), [CI]: ci() }, null, "cannot hold"],
    ["a job site of another form", { [PAGES]: pages(STANDARD), [CI]: ci().replace("  ci-ok:", "  site:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo site\n\n  ci-ok:") }, null, "job site"],
    ["a site config and inputs", { [PAGES]: pages(STANDARD), [CI]: ci() }, "{}\n", "also gives"],
    ["an on of one line", { [PAGES]: pages(STANDARD, []).replace("on:\n", "on: [push, pull_request]\n"), [CI]: ci() }, null, "one line"],
    ["no ci.yml", { [PAGES]: pages(STANDARD) }, null, "no `.github/workflows/ci.yml`"],
    ["two deploys", { [PAGES]: pages(STANDARD), ".github/workflows/docs.yml": pages(STANDARD), [CI]: ci() }, null, "2 jobs deploy"],
    ["a workflow of a pull request that calls the deploy", { [PAGES]: pages(STANDARD).replace("  pull_request:\n", "  workflow_call:\n"), [CI]: ci().replace("  ci:\n", `  pages:\n    uses: ./${PAGES}\n  ci:\n`) }, null, "calls"],
  ])("changes nothing and asks for a hand on %s", (_name, workflows, config, need) => {
    const result = move(workflows as Record<string, string>, config);
    expect(result?.writes).toEqual({});
    expect(result?.config).toBeNull();
    expect(result?.needs).toHaveLength(1);
    expect(result?.needs[0]).toContain(need);
  });
});

/** The files of a repository in memory. */
function mem(files: Record<string, string>): RepoFiles {
  return { paths: Object.keys(files), read: async (path) => files[path] ?? null };
}

const facts = (extra: Partial<SyncFacts> = {}): SyncFacts => ({ owner: OWNER, repo: REPO, templateSha: SHA, templatePaths: null, releaseInFlight: false, ...extra }) as SyncFacts;

describe("the sync rule site-config", () => {
  it("writes .github/site.json with its comment and the workflows, and is held with no Workflows permission", async () => {
    const files = { [PAGES]: pages(STANDARD), [CI]: ci() };
    const rules = (await import("./sync.ts")).SYNC_RULES.filter((rule) => rule.id === "site-config");
    const r = await syncRepo(mem(files), facts(), rules);
    expect(r.outcomes).toMatchObject([{ rule: "site-config", state: "applied" }]);
    expect(JSON.parse(r.writes[SITE_CONFIG_PATH] ?? "{}")).toMatchObject({ $comment: SITE_CONFIG_COMMENT, out: "packages/site/dist" });
    expect(Object.keys(r.writes).sort()).toEqual([SITE_CONFIG_PATH, CI, PAGES].sort());
    const held = await syncRepo(mem(files), facts(), rules, false);
    expect(held.outcomes).toMatchObject([{ rule: "site-config", state: "held" }]);
    expect(held.writes).toEqual({});
  });

  it("skips the template", async () => {
    const rules = (await import("./sync.ts")).SYNC_RULES.filter((rule) => rule.id === "site-config");
    const r = await syncRepo(mem({ [PAGES]: pages(STANDARD), [CI]: ci() }), facts({ repo: "template" }), rules);
    expect(r.outcomes).toEqual([]);
  });
});
