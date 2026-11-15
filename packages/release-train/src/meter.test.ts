// All names in these tests are made up.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FetchFn } from "./collect.ts";
import { gitHub, readRateLimit } from "./github.ts";
import { requestMeter, routeLines, routeTemplate } from "./meter.ts";

const API = "https://api.github.com";
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("routeTemplate", () => {
  it("replaces the owner, the repository and each number", () => {
    expect(routeTemplate("GET", `${API}/repos/example-owner/example-repo/pulls/42`)).toBe("GET /repos/{owner}/{repo}/pulls/{number}");
    expect(routeTemplate("POST", `${API}/repos/example-owner/example-repo/issues/7/comments`)).toBe("POST /repos/{owner}/{repo}/issues/{number}/comments");
    expect(routeTemplate("GET", `${API}/repos/example-owner/example-repo`)).toBe("GET /repos/{owner}/{repo}");
    expect(routeTemplate("GET", `${API}/orgs/example-owner/repos`)).toBe("GET /orgs/{owner}/repos");
    expect(routeTemplate("GET", `${API}/users/example-owner/repos`)).toBe("GET /users/{owner}/repos");
  });

  it("replaces a commit hash, also in upper case, and a ref name", () => {
    expect(routeTemplate("GET", `${API}/repos/o/r/commits/${SHA}/check-runs`)).toBe("GET /repos/{owner}/{repo}/commits/{sha}/check-runs");
    expect(routeTemplate("GET", `${API}/repos/o/r/commits/${SHA.toUpperCase()}/status`)).toBe("GET /repos/{owner}/{repo}/commits/{sha}/status");
    expect(routeTemplate("GET", `${API}/repos/o/r/commits/main/status`)).toBe("GET /repos/{owner}/{repo}/commits/{ref}/status");
    expect(routeTemplate("GET", `${API}/repos/o/r/git/trees/${SHA}`)).toBe("GET /repos/{owner}/{repo}/git/trees/{sha}");
  });

  it("gives one placeholder to a ref, a file path and a compare, also with slashes", () => {
    expect(routeTemplate("GET", `${API}/repos/o/r/git/ref/heads/feature/secret-plan`)).toBe("GET /repos/{owner}/{repo}/git/ref/{ref}");
    expect(routeTemplate("PATCH", `${API}/repos/o/r/git/refs/heads/release-train/update`)).toBe("PATCH /repos/{owner}/{repo}/git/refs/{ref}");
    expect(routeTemplate("GET", `${API}/repos/o/r/git/matching-refs/heads/release-train`)).toBe("GET /repos/{owner}/{repo}/git/matching-refs/{ref}");
    expect(routeTemplate("GET", `${API}/repos/o/r/contents/packages/hidden-tool/package.json`)).toBe("GET /repos/{owner}/{repo}/contents/{path}");
    expect(routeTemplate("GET", `${API}/repos/o/r/compare/main...feature/secret-plan`)).toBe("GET /repos/{owner}/{repo}/compare/{basehead}");
    expect(routeTemplate("GET", `${API}/repos/o/r/branches/feature-x/protection`)).toBe("GET /repos/{owner}/{repo}/branches/{branch}/protection");
    expect(routeTemplate("POST", `${API}/repos/o/r/actions/workflows/release.yml/dispatches`)).toBe("POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches");
  });

  it("gives the GraphQL route, and the route of a next page by repository number", () => {
    expect(routeTemplate("POST", `${API}/graphql`)).toBe("POST /graphql");
    expect(routeTemplate("GET", `${API}/repositories/123456/pulls?page=2&state=open`)).toBe("GET /repositories/{number}/pulls");
  });

  it("drops the query and gives GET for a lower-case method", () => {
    expect(routeTemplate("get", `${API}/repos/o/r/pulls?head=example-owner:secret-branch&state=open`)).toBe("GET /repos/{owner}/{repo}/pulls");
    expect(routeTemplate("GET", "/repos/o/r/releases/latest")).toBe("GET /repos/{owner}/{repo}/releases/latest");
    expect(routeTemplate("M-SEARCH", `${API}/rate_limit`)).toBe("OTHER /rate_limit");
  });

  it("gives null for a URL outside the API", () => {
    expect(routeTemplate("GET", "https://registry.npmjs.org/@example/pkg")).toBeNull();
    expect(routeTemplate("GET", "https://github.com/o/r/archive/main.zip")).toBeNull();
    expect(routeTemplate("GET", "not a url", "also not a url")).toBeNull();
  });

  it("keeps out the path of a base with a path, and gives null for a URL beside the base", () => {
    const base = "https://ghe.example.test/api/v3";
    expect(routeTemplate("GET", `${base}/repos/o/r/pulls/3`, base)).toBe("GET /repos/{owner}/{repo}/pulls/{number}");
    expect(routeTemplate("GET", "https://ghe.example.test/o/r", base)).toBeNull();
  });

  it("gives a template with no name of a private repository, a branch or a file", () => {
    const secret = ["hidden-payroll-tool", "secret-launch-branch", "confidential-notes.md", "acme-private-org"];
    const urls = [
      `${API}/repos/acme-private-org/hidden-payroll-tool/pulls/12`,
      `${API}/repos/acme-private-org/hidden-payroll-tool/contents/docs/confidential-notes.md`,
      `${API}/repos/acme-private-org/hidden-payroll-tool/git/refs/heads/secret-launch-branch`,
      `${API}/repos/acme-private-org/hidden-payroll-tool/branches/secret-launch-branch`,
      `${API}/repos/acme-private-org/hidden-payroll-tool/labels/hidden-payroll-tool`,
      `${API}/repos/acme-private-org/hidden-payroll-tool/hidden-payroll-tool/secret-launch-branch`,
      `${API}/orgs/acme-private-org/hidden-payroll-tool`,
    ];
    for (const url of urls) {
      const route = routeTemplate("GET", url);
      expect(route, url).not.toBeNull();
      for (const name of secret) expect(route, url).not.toContain(name);
    }
  });

  it("gives only the words of the API and placeholders for each path (property)", () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/);
    fc.assert(
      fc.property(fc.array(segment, { minLength: 0, maxLength: 8 }), fc.constantFrom("GET", "POST", "PATCH", "DELETE"), (segments, method) => {
        const route = routeTemplate(method, `${API}/${segments.map(encodeURIComponent).join("/")}`);
        expect(route).not.toBeNull();
        const parts = (route ?? "").split(" ")[1]?.split("/").filter(Boolean) ?? [];
        for (const part of parts) {
          // A placeholder, or a word of the API: a segment that is not one of the words never comes through.
          if (/^\{[a-z]+\}$/.test(part)) continue;
          expect(segments).toContain(part);
          expect(routeTemplate("GET", `${API}/${part}`)).toBe(`GET /${part}`);
        }
      }),
    );
  });
});

describe("requestMeter", () => {
  /** A fetch that gives the status of the first matching rule, and 200 for each other URL. */
  const answers = (rules: [RegExp, number][]): { f: FetchFn; seen: string[] } => {
    const seen: string[] = [];
    const f: FetchFn = async (url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      const status = rules.find(([re]) => re.test(url))?.[1] ?? 200;
      return new Response(status === 304 ? null : "{}", { status });
    };
    return { f, seen };
  };

  it("counts each request by route, with the answers 304 and the failures, and the largest count first", async () => {
    const { f } = answers([
      [/pulls\/1$/, 304],
      [/pulls\/2$/, 404],
      [/pulls\/3$/, 502],
    ]);
    const meter = requestMeter(f);
    for (const n of [1, 2, 3, 4]) await meter.fetch(`${API}/repos/o/r/pulls/${n}`);
    await meter.fetch(`${API}/repos/o/r`, { method: "GET" });
    await meter.fetch(`${API}/graphql`, { method: "POST", body: "{}" });
    expect(meter.routes()).toEqual([
      { route: "GET /repos/{owner}/{repo}/pulls/{number}", count: 4, notModified: 1, failed: 2 },
      { route: "GET /repos/{owner}/{repo}", count: 1, notModified: 0, failed: 0 },
      { route: "POST /graphql", count: 1, notModified: 0, failed: 0 },
    ]);
  });

  it("counts a fetch that throws as a failure, and throws the same error", async () => {
    const meter = requestMeter(async () => {
      throw new Error("network down");
    });
    await expect(meter.fetch(`${API}/repos/o/r/pulls`)).rejects.toThrow("network down");
    expect(meter.routes()).toEqual([{ route: "GET /repos/{owner}/{repo}/pulls", count: 1, notModified: 0, failed: 1 }]);
  });

  it("does not count GET /rate_limit and a URL outside the API, but sends them", async () => {
    const { f, seen } = answers([]);
    const meter = requestMeter(f);
    await meter.fetch(`${API}/rate_limit`);
    await meter.fetch("https://registry.npmjs.org/example-pkg");
    expect(seen).toEqual([`GET ${API}/rate_limit`, "GET https://registry.npmjs.org/example-pkg"]);
    expect(meter.routes()).toEqual([]);
  });

  it("counts the requests of a client, with the read of the rate limit free", async () => {
    const meter = requestMeter(async (url) =>
      new Response(JSON.stringify(url.endsWith("/rate_limit") ? { rate: { limit: 10, used: 1, remaining: 9, reset: 0 } } : {}), { status: 200 }),
    );
    const gh = gitHub({ token: "t", fetch: meter.fetch });
    await readRateLimit(gh);
    await gh.request("GET", "/repos/o/r/releases/latest");
    await gh.graphql("query { viewer { login } }", {});
    expect(meter.routes().map((r) => `${r.route} ${r.count}`)).toEqual(["GET /repos/{owner}/{repo}/releases/latest 1", "POST /graphql 1"]);
  });

  it("gives the routes with the same count in the order of the route, and a copy of each row", async () => {
    const { f } = answers([]);
    const meter = requestMeter(f);
    await meter.fetch(`${API}/repos/o/r/tags`);
    await meter.fetch(`${API}/repos/o/r/branches`);
    const first = meter.routes();
    expect(first.map((r) => r.route)).toEqual(["GET /repos/{owner}/{repo}/branches", "GET /repos/{owner}/{repo}/tags"]);
    const row = first[0];
    if (row) row.count = 99;
    expect(meter.routes()[0]?.count).toBe(1);
  });
});

describe("routeLines", () => {
  it("gives one line for no routes", () => {
    expect(routeLines([])).toEqual(["GitHub requests by route: none."]);
  });

  it("gives the totals and a table with the largest count first", () => {
    const lines = routeLines([
      { route: "GET /repos/{owner}/{repo}/pulls", count: 30, notModified: 4, failed: 1 },
      { route: "POST /graphql", count: 2, notModified: 0, failed: 0 },
    ]);
    expect(lines).toEqual([
      "GitHub requests by route: 32 in all, 4 with the answer 304, 1 failed.",
      "",
      "| Route | Requests | 304 | Failed |",
      "| --- | ---: | ---: | ---: |",
      "| GET /repos/{owner}/{repo}/pulls | 30 | 4 | 1 |",
      "| POST /graphql | 2 | 0 | 0 |",
      "",
    ]);
  });
});
