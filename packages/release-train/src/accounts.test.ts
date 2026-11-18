// All names in these tests are made up. No test uses the network.
import { describe, expect, it } from "vitest";
import { accountOfPath, accountOfRepos, authorizationOf, needShares, parseTokens, repositoryIdOf, runAccounts } from "./accounts.ts";
import { apply, applySummary, noReadLine } from "./apply.ts";
import type { ApplyReport, Updater } from "./apply.ts";
import { accountsOf, parseArgs } from "./cli.ts";
import { listAccounts } from "./collect.ts";
import type { FetchFn, GhRepo, PageRead } from "./collect.ts";
import { accountsGitHub, gitHub, pageRead, routedGitHub } from "./github.ts";
import { credentialOf } from "./meter.ts";
import { buildGraph } from "./graph.ts";
import { plan } from "./plan.ts";
import { moveSiteConfig } from "./site-config.ts";
import { SYNC_KIND, syncRepo } from "./sync.ts";
import type { RepoFiles, RunFacts, SyncFacts, SyncJob, SyncUpdater } from "./sync.ts";
import type { RepoSnapshot } from "./types.ts";
import { gitUpdater } from "./workspace.ts";
import type { RunFn } from "./workspace.ts";

const HOME = "home-owner";
const OTHER = "other-org";
const API = "https://api.github.com";
const OLD = "1".repeat(40);
const NEW = "3".repeat(40);

interface Call {
  method: string;
  path: string;
  token: string | null;
  body: Record<string, unknown> | undefined;
}
type Handler = (body: Record<string, unknown> | undefined, url: URL) => [number, unknown, Record<string, string>?];

/** A fake GitHub API. It keeps the method, the path, the token and the body of each request. */
function server(routes: Record<string, Handler>): { f: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const f: FetchFn = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, path: `${u.pathname}${u.search}`, token: auth === null ? null : auth.replace(/^Bearer /, ""), body });
    const h = routes[`${method} ${u.pathname}`];
    const [status, data, headers] = h ? h(body, u) : [404, { message: "Not Found" }];
    return new Response(status === 204 || data === null ? null : JSON.stringify(data), { status, headers: headers ?? {} });
  };
  return { f, calls };
}

const search = (q: string): string => `/search/issues?per_page=100&q=${encodeURIComponent(q)}`;

describe("accountOfPath", () => {
  it("gives the account of a path of a repository, a user and an organization, also in a full URL", () => {
    expect(accountOfPath(`/repos/${OTHER}/demo/pulls?state=open`)).toBe(OTHER);
    expect(accountOfPath(`/users/${HOME}/repos?type=owner`)).toBe(HOME);
    expect(accountOfPath(`/orgs/${OTHER}/repos`)).toBe(OTHER);
    expect(accountOfPath(`${API}/repos/${OTHER}/demo`)).toBe(OTHER);
    expect(accountOfPath(`https://example.test/api/repos/${OTHER}/demo`, new Map(), "https://example.test/api")).toBe(OTHER);
  });

  it("gives null for a full URL of a different host or with a path out of the base of the API", () => {
    expect(accountOfPath(`${API}.example.test/repos/${OTHER}/demo`)).toBeNull();
    expect(accountOfPath(`https://example.test/repos/${OTHER}/demo`)).toBeNull();
    expect(accountOfPath(`https://example.test/other/repos/${OTHER}/demo`, new Map(), "https://example.test/api")).toBeNull();
    expect(accountOfPath(`https://example.test/apix/repos/${OTHER}/demo`, new Map(), "https://example.test/api")).toBeNull();
    expect(accountOfPath("https://[bad/repos/x/y")).toBeNull();
  });

  it("gives the account of a repository id from the known ids, and null for an id that it does not know", () => {
    const ids = new Map([[42, OTHER]]);
    expect(accountOfPath("/repositories/42/pulls?page=2", ids)).toBe(OTHER);
    expect(accountOfPath(`${API}/repositories/42/pulls?page=2`, ids)).toBe(OTHER);
    expect(accountOfPath("/repositories/43/pulls?page=2", ids)).toBeNull();
    expect(repositoryIdOf(`${API}/repositories/42/pulls?page=2`)).toBe(42);
    expect(repositoryIdOf(`${API}/repos/${OTHER}/demo/pulls?page=2`)).toBeNull();
    expect(repositoryIdOf(null)).toBeNull();
  });

  it("gives the account of the first user or org qualifier of a search, and null for a path with no account", () => {
    expect(accountOfPath(search(`user:${OTHER} is:pr is:open head:release-train/update`))).toBe(OTHER);
    expect(accountOfPath(search(`is:pr org:${OTHER} user:${HOME}`))).toBe(OTHER);
    expect(accountOfPath(search("is:pr is:open"))).toBeNull();
    for (const path of ["/rate_limit", "/installation/repositories?per_page=100", "/user", "/user/repos?affiliation=owner", "/graphql"]) {
      expect(accountOfPath(path)).toBeNull();
    }
  });
});

describe("the tokens of the accounts", () => {
  it("reads GH_TOKENS, and an error does not give the text", () => {
    expect(parseTokens(undefined)).toEqual({});
    expect(parseTokens("  ")).toEqual({});
    expect(parseTokens(`{"${OTHER}": " ghs_other ", "empty-org": ""}`)).toEqual({ [OTHER]: "ghs_other" });
    for (const bad of ["ghs_secret_text", '["ghs_secret_text"]', '{"x": 5}']) {
      let message = "";
      try {
        parseTokens(bad);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("GH_TOKENS");
      expect(message).not.toContain("ghs_secret_text");
    }
  });

  it("gives the token of each account in any case, drops the copies and the home account, and gives null for an account with no token", () => {
    const a = runAccounts(HOME, "home-token", [OTHER, "Other-Org", HOME, "third-org"], { "OTHER-ORG": "other-token" });
    expect(a.others).toEqual([OTHER, "third-org"]);
    expect(a.token(HOME)).toBe("home-token");
    expect(a.token("Home-Owner")).toBe("home-token");
    expect(a.token(OTHER)).toBe("other-token");
    expect(a.token("third-org")).toBeNull();
    expect(accountOfRepos(HOME, [{ name: "moved", account: OTHER }, { name: "stays" }])("moved")).toBe(OTHER);
    expect(accountOfRepos(HOME, [{ name: "moved", account: OTHER }])("unknown")).toBe(HOME);
  });

  it("reads --also-owner as a list that repeats, and GH_TOKENS of the environment", () => {
    const o = parseArgs(["apply", "--owner", HOME, "--also-owner", OTHER, "--also-owner", "third-org, fourth-org"]);
    expect(o.owner).toBe(HOME);
    expect(o.alsoOwners).toEqual([OTHER, "third-org", "fourth-org"]);
    expect(parseArgs(["plan"]).alsoOwners).toEqual([]);
    const a = accountsOf(o, "home-token", { GH_TOKENS: JSON.stringify({ [OTHER]: "other-token" }) });
    expect(a.others).toEqual([OTHER, "third-org", "fourth-org"]);
    expect(a.token(OTHER)).toBe("other-token");
    expect(a.token("third-org")).toBeNull();
  });
});

describe("the share of the need of each token", () => {
  const accounts = runAccounts(HOME, "home-token", [OTHER, "third-org"], { [OTHER]: "other-token" });

  it("gives each credential the share of the repositories of its accounts", () => {
    const share = needShares(accounts, [{ account: HOME }, { account: HOME }, {}, { account: OTHER }, { account: "third-org" }]);
    // The account third-org has no token, so its client is the home client, and its repository is in the home share.
    expect(share(authorizationOf("home-token"))).toBe(4 / 5);
    expect(share(authorizationOf("other-token"))).toBe(1 / 5);
    expect(share("Bearer unknown-token")).toBe(0);
    expect(share("")).toBe(0);
  });

  it("gives each credential the full need for an empty list", () => {
    expect(needShares(accounts, [])(authorizationOf("other-token"))).toBe(1);
  });

  it("gives the header of a token, and an empty text for no token", () => {
    expect(authorizationOf("t")).toBe("Bearer t");
    expect(authorizationOf(null)).toBe("");
    expect(authorizationOf(undefined)).toBe("");
    expect(authorizationOf("")).toBe("");
  });

  it("gives the same credential as the header of each client, so the guard finds the share of each request", async () => {
    const seen: string[] = [];
    const f: FetchFn = async (_url, init) => {
      seen.push(credentialOf(init));
      return new Response("{}", { status: 200 });
    };
    const clients = accountsGitHub(accounts, { fetch: f });
    await clients.of(HOME).request("GET", "/rate_limit");
    await clients.of(OTHER).request("GET", "/rate_limit");
    const share = needShares(accounts, [{ account: HOME }, { account: OTHER }, { account: OTHER }, { account: OTHER }]);
    expect(seen.map(share)).toEqual([1 / 4, 3 / 4]);
  });
});

describe("routedGitHub", () => {
  it("gives each request the token of the account of its path, and the home token to a path with no account", async () => {
    const { f, calls } = server({});
    const accounts = runAccounts(HOME, "home-token", [OTHER, "third-org"], { [OTHER]: "other-token" });
    const { gh, of } = accountsGitHub(accounts, { fetch: f });
    await gh.request("GET", `/repos/${OTHER}/demo/pulls`);
    await gh.request("GET", `/repos/${HOME}/template`);
    await gh.request("GET", `/users/${OTHER}/repos`);
    await gh.request("GET", `/orgs/${OTHER}/repos`);
    await gh.request("GET", search(`user:${OTHER} is:pr`));
    await gh.request("GET", search(`user:${HOME} is:pr`));
    await gh.request("GET", "/rate_limit");
    await gh.request("GET", "/installation/repositories?per_page=100");
    // An account with no token has no client, so its request takes the home token.
    await gh.request("GET", "/repos/third-org/demo");
    await gh.text?.(`/repos/${OTHER}/demo/actions/jobs/7/logs`);
    await gh.graphql("query { viewer { login } }", {}, OTHER);
    await gh.graphql("query { viewer { login } }", {});
    expect(calls.map((c) => c.token)).toEqual([
      "other-token",
      "home-token",
      "other-token",
      "other-token",
      "other-token",
      "home-token",
      "home-token",
      "home-token",
      "home-token",
      "other-token",
      "other-token",
      "home-token",
    ]);
    // The own client of an account reads a path with no account with the token of that account.
    calls.length = 0;
    await of(OTHER).request("GET", "/installation/repositories?per_page=100");
    await of("third-org").request("GET", "/installation/repositories?per_page=100");
    expect(calls.map((c) => c.token)).toEqual(["other-token", "home-token"]);
  });

  it("keeps the account of a repository id from the next link of an answer, for the next page", async () => {
    const next = `${API}/repositories/42/pulls?state=open&page=2`;
    const { f, calls } = server({
      [`GET /repos/${OTHER}/demo/pulls`]: () => [200, [{ number: 1 }], { link: `<${next}>; rel="next"` }],
      ["GET /repositories/42/pulls"]: () => [200, [{ number: 2 }]],
    });
    const clients = new Map([
      [HOME, gitHub({ token: "home-token", fetch: f })],
      [OTHER, gitHub({ token: "other-token", fetch: f })],
    ]);
    const gh = routedGitHub({ home: HOME, clients });
    const read = pageRead(gh);
    const first = await read<{ number: number }[]>(`/repos/${OTHER}/demo/pulls?state=open`);
    expect(first.next).toBe(next);
    const second = await read<{ number: number }[]>(first.next ?? "");
    expect(second.data).toEqual([{ number: 2 }]);
    expect(calls.map((c) => [c.path, c.token])).toEqual([
      [`/repos/${OTHER}/demo/pulls?state=open`, "other-token"],
      ["/repositories/42/pulls?state=open&page=2", "other-token"],
    ]);
    // An id that no answer linked takes the home token.
    await gh.request("GET", "/repositories/43/pulls");
    expect(calls.at(-1)?.token).toBe("home-token");
  });

  it("refuses a set of clients with no client of the home account", () => {
    expect(() => routedGitHub({ home: HOME, clients: new Map([[OTHER, gitHub({ token: "other-token" })]]) })).toThrow(/home account/);
  });
});

const repo = (name: string, login: string, extra: Partial<GhRepo> = {}): GhRepo => ({ name, private: false, archived: false, fork: false, default_branch: "main", owner: { login }, ...extra });

/** The page reads of each account: an installation token lists the installation, another token the public list. */
function reads(lists: Record<string, GhRepo[]>, seen: string[]): (account: string) => PageRead {
  return (account) =>
    async <T,>(url: string) => {
      seen.push(`${account} ${url}`);
      const list = lists[account] ?? [];
      return { data: (url.startsWith("/installation/") ? { repositories: list } : list) as T, next: null };
    };
}

describe("listAccounts", () => {
  it("lists the repositories of two accounts in the order of their names, each with its account", async () => {
    const seen: string[] = [];
    const accounts = runAccounts(HOME, "ghs_home", [OTHER], { [OTHER]: "ghs_other" });
    const lists = { [HOME]: [repo("beta", HOME), repo("old-fork", HOME, { fork: true })], [OTHER]: [repo("alpha", OTHER), repo("gamma", OTHER, { private: true })] };
    const r = await listAccounts(accounts, reads(lists, seen), { publicOnly: false });
    expect(r.repos.map((x) => [x.name, x.account])).toEqual([
      ["alpha", OTHER],
      ["beta", HOME],
      ["gamma", OTHER],
    ]);
    expect(r.noRead).toEqual([]);
    expect(seen).toEqual([`${HOME} /installation/repositories?per_page=100`, `${OTHER} /installation/repositories?per_page=100`]);
  });

  it("refuses a repository name in two accounts, with both accounts in the error", async () => {
    const accounts = runAccounts(HOME, "ghs_home", [OTHER], { [OTHER]: "ghs_other" });
    const lists = { [HOME]: [repo("shared-name", HOME)], [OTHER]: [repo("Shared-Name", OTHER)] };
    await expect(listAccounts(accounts, reads(lists, []), { publicOnly: false })).rejects.toThrow(
      `The repository name Shared-Name is in the accounts ${HOME} and ${OTHER}.`,
    );
  });

  it("does not read an account with no token, names it in noRead and in the log, and reads the other accounts", async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const accounts = runAccounts(HOME, "ghs_home", [OTHER], {});
    const lists = { [HOME]: [repo("beta", HOME)], [OTHER]: [repo("alpha", OTHER)] };
    const r = await listAccounts(accounts, reads(lists, seen), { publicOnly: false, log: (l) => lines.push(l) });
    expect(r.repos.map((x) => x.name)).toEqual(["beta"]);
    expect(r.noRead).toEqual([OTHER]);
    expect(seen.every((s) => s.startsWith(HOME))).toBe(true);
    expect(lines).toEqual([`The account ${OTHER} has no token in GH_TOKENS, so the run does not read its repositories: no read.`]);
    // The report and the summary of a run show the account as no read, never as a pass.
    const report: ApplyReport = { owner: HOME, at: "2026-01-01T00:00:00.000Z", dryRun: true, results: [], noRead: r.noRead };
    expect(applySummary(report)).toContain(noReadLine([OTHER]));
    expect(noReadLine([OTHER])).toContain(`No read: the run has no token for the accounts ${OTHER}`);
  });

  it("reads the public list of an account with no token in a public run", async () => {
    const seen: string[] = [];
    const accounts = runAccounts(HOME, null, [OTHER], {});
    const lists = { [HOME]: [repo("beta", HOME)], [OTHER]: [repo("alpha", OTHER), repo("secret", OTHER, { private: true })] };
    const r = await listAccounts(accounts, reads(lists, seen), { publicOnly: true });
    expect(r.repos.map((x) => [x.name, x.account])).toEqual([
      ["alpha", OTHER],
      ["beta", HOME],
    ]);
    expect(r.noRead).toEqual([]);
    expect(seen).toEqual([`${HOME} /users/${HOME}/repos?type=owner&per_page=100`, `${OTHER} /users/${OTHER}/repos?type=owner&per_page=100`]);
  });
});

const b64 = (s: string): string => Buffer.from(s).toString("base64");
const ci = (sha: string): string => `jobs:\n  ci:\n    uses: ${HOME}/template/.github/workflows/reusable-ci.yml@${sha} # v1\n`;
const runFacts = { owner: HOME, templateSha: NEW, templatePaths: new Set([".github/workflows/reusable-ci.yml"]), cliVersion: null, contains: async (sha: string) => sha === NEW } as RunFacts;
const mem = (files: Record<string, string>): RepoFiles => ({ paths: Object.keys(files).sort(), read: async (p) => files[p] ?? null });
const noUpdates: Updater = { update: async () => { throw new Error("no update in this test"); } };

describe("apply with a repository in a second account", () => {
  it("sends each request of the repository to its account with the token of that account, and the template sync keeps the home account", async () => {
    const name = "moved-repo";
    const at = `/repos/${OTHER}/${name}`;
    const files: Record<string, string> = { ".github/workflows/ci.yml": ci(OLD) };
    const routes: Record<string, Handler> = {
      [`GET ${at}/git/trees/HEAD`]: () => [200, { tree: Object.keys(files).map((path) => ({ path, type: "blob" })) }],
      [`GET ${at}`]: () => [200, { default_branch: "main", allow_auto_merge: false }],
      [`GET ${at}/pulls`]: () => [200, []],
      [`POST ${at}/pulls`]: (b) => [201, { number: 5, html_url: `https://github.com/${OTHER}/${name}/pull/5`, node_id: "PR_5", title: "", body: b?.["body"], state: "open", head: { sha: "s5", ref: String(b?.["head"]) }, base: { ref: "main" }, labels: [] }],
      [`POST ${at}/labels`]: () => [201, {}],
      [`POST ${at}/issues/5/labels`]: () => [200, []],
      ["GET /search/issues"]: () => [200, { items: [] }],
    };
    for (const [path, text] of Object.entries(files)) routes[`GET ${at}/contents/${path}`] = () => [200, { content: b64(text) }];
    const { f, calls } = server(routes);
    const accounts = runAccounts(HOME, "home-token", [OTHER], { [OTHER]: "other-token" });
    const gh = accountsGitHub(accounts, { fetch: f }).gh;
    const snap: RepoSnapshot = { name, account: OTHER, private: false, defaultBranch: "main", manifests: [{ path: "", manifest: { name: "demo", private: true } }], lockKind: "pnpm", resolved: {}, warnings: [] };
    const p = plan(buildGraph({ owner: HOME, repos: [snap], npm: {}, now: new Date("2026-01-01T00:00:00Z") }));
    expect(p.repos[0]?.account).toBe(OTHER);
    const jobs: SyncJob[] = [];
    const up: SyncUpdater = {
      async sync(job) {
        jobs.push(job);
        const result = await syncRepo(mem(files), job.facts, job.rules, job.workflows);
        return { status: "pushed", sha: "s9", result, tool: null, error: null };
      },
    };
    const r = await apply({ owner: HOME, plan: p, gh, updater: noUpdates, dryRun: false, sync: { updater: up, facts: runFacts, workflows: "auto" } });
    expect(r.owner).toBe(HOME);
    expect(r.results[0]).toMatchObject({ repo: name, kind: SYNC_KIND, state: "opened", pr: { number: 5 } });
    // The sync job knows the account of the repository, and the new pin stays in the template of the home account.
    expect(jobs[0]?.facts).toMatchObject({ owner: HOME, account: OTHER, repo: name });
    const pinned = await syncRepo(mem(files), jobs[0]?.facts as SyncFacts, jobs[0]?.rules, true);
    expect(pinned.writes[".github/workflows/ci.yml"]).toContain(`uses: ${HOME}/template/.github/workflows/reusable-ci.yml@${NEW}`);
    // Each request of the repository goes to its account with its token. No request goes to the home account.
    const own = calls.filter((c) => c.path.startsWith(`${at}/`) || c.path === at);
    expect(own.length).toBeGreaterThan(3);
    expect(own.every((c) => c.token === "other-token")).toBe(true);
    expect(calls.some((c) => c.path.startsWith(`/repos/${HOME}/`))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.path === `${at}/pulls`)).toBe(true);
    // The search of each account takes the token of that account.
    for (const c of calls.filter((x) => x.path.startsWith("/search/"))) expect(c.token).toBe(accountOfPath(c.path) === OTHER ? "other-token" : "home-token");
  });
});

/** The token of the git config of a child environment, or null. */
function gitToken(env: NodeJS.ProcessEnv): string | null {
  const v = env["GIT_CONFIG_VALUE_0"];
  return v === undefined ? null : Buffer.from(v.replace("AUTHORIZATION: basic ", ""), "base64").toString().replace("x-access-token:", "");
}

describe("the git updater with two accounts", () => {
  it("clones and pushes a repository of a second account with its URL and token, and the home repository with the home token", async () => {
    const seen: { args: readonly string[]; token: string | null }[] = [];
    const run: RunFn = async (cmd, args, opts) => {
      if (cmd === "git") seen.push({ args, token: gitToken(opts.env) });
      if (cmd === "git" && args[0] === "fetch") return { code: 1, stdout: "", stderr: "no such branch" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M x\n", stderr: "" };
      if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const accounts = runAccounts(HOME, "home-token", [OTHER], { [OTHER]: "other-token" });
    const up = gitUpdater({ owner: HOME, token: "home-token", accounts, accountOf: accountOfRepos(HOME, [{ name: "moved-repo", account: OTHER }]), author: { name: "a", email: "a@b" }, run });
    const job = (name: string): SyncJob => ({ repo: name, facts: { ...runFacts, repo: name, releaseInFlight: false } as SyncFacts, workflows: false, rules: [] });
    expect((await up.sync(job("moved-repo"), { defaultBranch: "main", rebuild: false })).status).toBe("pushed");
    const clone = seen.find((c) => c.args[0] === "clone");
    expect(clone?.args).toContain(`https://github.com/${OTHER}/moved-repo.git`);
    expect(seen.filter((c) => ["clone", "fetch", "push"].includes(c.args[0] ?? "")).map((c) => c.token)).toEqual(["other-token", "other-token", "other-token"]);
    seen.length = 0;
    expect((await up.sync(job("home-repo"), { defaultBranch: "main", rebuild: false })).status).toBe("pushed");
    expect(seen.find((c) => c.args[0] === "clone")?.args).toContain(`https://github.com/${HOME}/home-repo.git`);
    expect(seen.filter((c) => ["clone", "fetch", "push"].includes(c.args[0] ?? "")).map((c) => c.token)).toEqual(["home-token", "home-token", "home-token"]);
  });
});

describe("the site config of a repository in a second account", () => {
  it("pins the shared workflows of the home account, and reads the repository in its own account", () => {
    // The rule finds the deploy by the shared Pages workflow of the template, so the home account of this test is the account of the template.
    const TEMPLATE_OWNER = "mark1russell7";
    const pagesYml = [
      "name: Pages",
      "on:",
      "  push:",
      "    branches: [main]",
      "permissions: {}",
      "jobs:",
      "  pages:",
      `    uses: ${TEMPLATE_OWNER}/template/.github/workflows/reusable-pages.yml@${OLD} # main`,
      "    permissions:",
      "      contents: read",
      "      pages: write",
      "      id-token: write",
      "    with:",
      "      build: pnpm run build",
      "      out: dist",
      "      base: /${{ github.repository }}/",
      "      deploy: ${{ github.event_name != 'pull_request' }}",
      "",
    ].join("\n");
    const ciYml = ["name: CI", "on:", "  pull_request:", "jobs:", "  ci:", `    uses: ${TEMPLATE_OWNER}/template/.github/workflows/reusable-ci.yml@${OLD} # main`, "", "  ci-ok:", "    name: CI OK", "    if: ${{ !cancelled() }}", "    needs: [ci]", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo ok", ""].join("\n");
    const move = moveSiteConfig({
      owner: TEMPLATE_OWNER,
      account: OTHER,
      repo: "moved-site",
      templateSha: NEW,
      workflows: [
        { path: ".github/workflows/pages.yml", text: pagesYml },
        { path: ".github/workflows/ci.yml", text: ciYml },
      ],
      config: null,
    });
    expect(move?.needs).toEqual([]);
    expect(move?.config).toMatchObject({ base: "/{owner}/{repo}/" });
    const written = Object.values(move?.writes ?? {}).join("\n");
    expect(written).toContain(`uses: ${TEMPLATE_OWNER}/`);
    expect(written).not.toContain(`uses: ${OTHER}/`);
  });
});
