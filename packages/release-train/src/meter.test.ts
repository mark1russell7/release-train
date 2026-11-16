// All names in these tests are made up.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FetchFn } from "./collect.ts";
import { gitHub, readRateLimit } from "./github.ts";
import type { RateLimitRead } from "./github.ts";
import {
  countedRequest,
  DISAGREE_MIN,
  JUMP_MIN,
  outsideLine,
  outsideUse,
  rateTracker,
  readsOutside,
  refusalKind,
  refusalLine,
  requestMeter,
  routeLines,
  routeTemplate,
  SAMPLE_MAX,
} from "./meter.ts";

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

describe("the outside use of the rate limit", () => {
  const RESET = 1_800_000_000;
  /** A fetch that answers each request with the next used count of the list, and with the reset of the list. */
  const usedAnswers = (used: readonly number[], opts: { reset?: readonly number[]; resource?: string } = {}): FetchFn => {
    let i = 0;
    return async () => {
      const headers: Record<string, string> = { "x-ratelimit-used": String(used[i]), "x-ratelimit-reset": String(opts.reset?.[i] ?? RESET) };
      if (opts.resource !== undefined) headers["x-ratelimit-resource"] = opts.resource;
      i += 1;
      return new Response("{}", { status: 200, headers });
    };
  };
  /** A clock that moves one second at each read, from 2026-11-16 02:22:00Z. */
  const ticks = (): (() => number) => {
    let t = Date.parse("2026-11-16T02:22:00Z");
    return () => (t += 1000);
  };

  it("counts the requests of another holder between two answers of the meter, and names the jump", async () => {
    const meter = requestMeter(usedAnswers([10, 11, 50, 51]), API, ticks());
    for (let i = 0; i < 4; i++) await meter.fetch(`${API}/repos/o/r/pulls/${i}`);
    expect(meter.outside()).toEqual({ requests: 38, answers: 4, windows: 1, jumps: [{ at: "2026-11-16T02:22:03.000Z", size: 38 }] });
    expect(outsideLine(meter.outside())).toBe("GitHub requests outside the meter: 38, from 4 answers. The largest jumps: 38 at 02:22:03Z.");
  });

  it("gives no read when no answer has the header, and counts no other resource", async () => {
    const none = requestMeter(async () => new Response("{}", { status: 200 }), API, ticks());
    await none.fetch(`${API}/repos/o/r`);
    expect(none.outside()).toEqual({ requests: 0, answers: 0, windows: 0, jumps: [] });
    expect(outsideLine(none.outside())).toMatch(/no read/);
    const search = requestMeter(usedAnswers([1, 30], { resource: "search" }), API, ticks());
    await search.fetch(`${API}/search/issues?q=x`);
    await search.fetch(`${API}/search/issues?q=y`);
    expect(search.outside().answers).toBe(0);
  });

  it("starts a new window at a reset: the drop of the used count is no use", async () => {
    const meter = requestMeter(usedAnswers([100, 101, 1, 2], { reset: [RESET, RESET + 2, RESET + 3600, RESET + 3600] }), API, ticks());
    for (let i = 0; i < 4; i++) await meter.fetch(`${API}/repos/o/r`);
    expect(meter.outside()).toEqual({ requests: 0, answers: 4, windows: 2, jumps: [] });
  });

  it("gives no outside use for requests of the meter only, in each order of their answers", () => {
    // Each request of the meter raises the count by one. Requests in flight answer in any order.
    const orders = fc.integer({ min: 1, max: 40 }).chain((n) => fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n }));
    fc.assert(
      fc.property(orders, fc.integer({ min: 0, max: 5000 }), (order, base) => {
        expect(outsideUse(order.map((k, i) => ({ at: i * 10, used: base + k + 1, reset: RESET }))).requests).toBe(0);
      }),
    );
  });

  it("gives the exact count of a block of outside requests at each point of a run", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 40 }), fc.integer({ min: 0, max: 9000 }), fc.nat(), (n, outside, at) => {
        const cut = 1 + (at % (n - 1));
        const samples = Array.from({ length: n }, (_, i) => ({ at: i * 10, used: i + 1 + (i >= cut ? outside : 0), reset: RESET }));
        const out = outsideUse(samples);
        expect(out.requests).toBe(outside);
        expect(out.jumps).toEqual(outside >= JUMP_MIN ? [{ at: new Date(cut * 10).toISOString(), size: outside }] : []);
      }),
    );
  });
});

describe("the evidence of the rate limit: samples, refusals and the two reads", () => {
  const RESET = 1_800_000_000;
  const ISO = new Date(RESET * 1000).toISOString();
  /** A clock that moves one second at each read, from 2026-11-16 04:52:00Z. */
  const ticks = (): (() => number) => {
    let t = Date.parse("2026-11-16T04:52:00Z");
    return () => (t += 1000);
  };
  const answer = (status: number, headers: Record<string, string>, body = "{}"): Response => new Response(body, { status, headers });

  it("keeps each answer of core with its status, its remaining count and its route, and no name", async () => {
    const answers = [
      answer(200, { "x-ratelimit-used": "10", "x-ratelimit-remaining": "90", "x-ratelimit-reset": String(RESET) }),
      answer(404, { "x-ratelimit-used": "11", "x-ratelimit-remaining": "89", "x-ratelimit-reset": String(RESET) }),
      answer(200, { "x-ratelimit-used": "3", "x-ratelimit-reset": String(RESET), "x-ratelimit-resource": "graphql" }),
    ];
    const meter = requestMeter(async () => answers.shift() as Response, API, ticks());
    await meter.fetch(`${API}/repos/secret-owner/secret-repo/pulls/7`);
    await meter.fetch(`${API}/repos/secret-owner/secret-repo/contents/a/b.json`);
    await meter.fetch(`${API}/graphql`, { method: "POST" });
    expect(meter.samples()).toEqual([
      { at: Date.parse("2026-11-16T04:52:01Z"), used: 10, reset: RESET, remaining: 90, status: 200, route: "GET /repos/{owner}/{repo}/pulls/{number}" },
      { at: Date.parse("2026-11-16T04:52:02Z"), used: 11, reset: RESET, remaining: 89, status: 404, route: "GET /repos/{owner}/{repo}/contents/{path}" },
    ]);
    expect(JSON.stringify(meter.samples())).not.toMatch(/secret/);
  });

  it("keeps at most SAMPLE_MAX samples", async () => {
    let used = 0;
    const meter = requestMeter(async () => answer(200, { "x-ratelimit-used": String(++used), "x-ratelimit-reset": String(RESET) }), API, ticks());
    for (let i = 0; i < SAMPLE_MAX + 3; i++) await meter.fetch(`${API}/repos/o/r`);
    expect(meter.samples()).toHaveLength(SAMPLE_MAX);
    expect(meter.outside().answers).toBe(SAMPLE_MAX);
  });

  it("gives the cause of each refusal from the status, the headers and the message", () => {
    const h = (x: Record<string, string>): Headers => new Headers(x);
    expect(refusalKind(200, h({}), "")).toBeNull();
    expect(refusalKind(404, h({}), "Not Found")).toBeNull();
    expect(refusalKind(403, h({ "x-ratelimit-remaining": "0" }), "")).toBe("primary");
    expect(refusalKind(429, h({ "x-ratelimit-remaining": " 0 " }), "")).toBe("primary");
    expect(refusalKind(403, h({ "x-ratelimit-remaining": "12" }), "API rate limit exceeded for installation.")).toBe("primary");
    expect(refusalKind(403, h({ "retry-after": "60", "x-ratelimit-remaining": "40" }), "")).toBe("secondary");
    expect(refusalKind(403, h({ "x-ratelimit-remaining": "40" }), "You have exceeded a secondary rate limit.")).toBe("secondary");
    expect(refusalKind(403, h({ "x-ratelimit-remaining": "40" }), "Resource not accessible by integration")).toBe("other");
  });

  it("counts the refusals by cause, names the time of the first one, and leaves the body to the caller", async () => {
    const answers = [
      answer(403, { "x-ratelimit-remaining": "5" }, '{"message":"Resource not accessible by integration"}'),
      answer(403, { "x-ratelimit-remaining": "0" }, '{"message":"API rate limit exceeded"}'),
      answer(403, { "x-ratelimit-remaining": "5" }, '{"message":"You have exceeded a secondary rate limit"}'),
      answer(429, { "retry-after": "30" }, "{}"),
    ];
    const meter = requestMeter(async () => answers.shift() as Response, API, ticks());
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++) bodies.push(await (await meter.fetch(`${API}/repos/o/r`)).text());
    expect(bodies[0]).toContain("Resource not accessible");
    expect(bodies[1]).toContain("API rate limit exceeded");
    // The first answer is a permission error, so the first refusal for a rate limit is the second answer.
    expect(meter.refusals()).toEqual({ primary: 1, secondary: 2, other: 1, first: "2026-11-16T04:52:02.000Z" });
    expect(refusalLine(meter.refusals())).toBe(
      "GitHub refused 4 requests with 403 or 429: 1 for a spent rate limit, 2 for a secondary rate limit, 1 with no sign of a rate limit. The first refusal for a rate limit came at 04:52:02Z.",
    );
    expect(refusalLine({ primary: 0, secondary: 0, other: 0, first: null })).toBeNull();
  });

  it("puts each sample in its window, also when the samples of two windows alternate", () => {
    // Two windows, A from 100 and B from 5,000. Each rises by one at each of its answers, and B has 30 outside requests.
    const samples = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? { at: i, used: 100 + i / 2, reset: RESET } : { at: i, used: 5000 + (i - 1) / 2 + (i >= 5 ? 30 : 0), reset: RESET + 900 },
    );
    const out = outsideUse(samples);
    expect(out.requests).toBe(30);
    expect(out.jumps).toEqual([{ at: new Date(5).toISOString(), size: 30 }]);
  });

  it("gives the outside use from the two reads: the rise minus the counted requests of the meter", () => {
    const routes = [
      { route: "GET /repos/{owner}/{repo}", count: 1941, notModified: 0, failed: 209 },
      { route: "GET /repos/{owner}/{repo}/pulls", count: 10, notModified: 4, failed: 0 },
    ];
    // Train 43805901480: 288 used at the start and 10,200 at the end, in one window.
    expect(readsOutside({ used: 288, reset: ISO }, { used: 10_200, reset: ISO }, routes)).toBe(10_200 - 288 - 1941 - 6);
    expect(readsOutside({ used: 288, reset: ISO }, { used: 10_200, reset: new Date((RESET + 30) * 1000).toISOString() }, routes)).toBe(7965);
    expect(readsOutside({ used: 288, reset: ISO }, { used: 50, reset: new Date((RESET + 3600) * 1000).toISOString() }, routes)).toBeNull();
    expect(readsOutside(null, { used: 50, reset: ISO }, routes)).toBeNull();
    expect(readsOutside({ used: 1, reset: ISO }, undefined, routes)).toBeNull();
    expect(readsOutside({ used: 1, reset: "no time" }, { used: 2, reset: ISO }, routes)).toBeNull();
  });

  it("takes away only the counted answers of the window of the reads (Train 43853352904)", () => {
    // One run: 2,953 counted answers, 106 of them in a second window with the same limit and a reset 225 s later.
    // The two reads rose by 2,847, the count of the answers in their own window. No request was outside the meter.
    const routes = [{ route: "GET /repos/{owner}/{repo}", count: 2953, notModified: 0, failed: 0 }];
    const samples = [
      ...Array.from({ length: 2847 }, () => ({ reset: RESET, status: 200 })),
      ...Array.from({ length: 106 }, () => ({ reset: RESET + 225, status: 200 })),
    ];
    const start = { used: 1303, reset: ISO };
    const end = { used: 1303 + 2847, reset: ISO };
    expect(readsOutside(start, end, routes)).toBe(-106);
    expect(readsOutside(start, end, routes, samples)).toBe(0);
    // A reset some seconds away is the same window.
    expect(readsOutside(start, end, routes, samples.map((x, i) => (i < 2847 ? { ...x, reset: RESET + (i % 7) } : x)))).toBe(0);
    // An answer 304 of the other window is not counted, so it is not taken away.
    const notModified = [{ route: "GET /repos/{owner}/{repo}", count: 2953, notModified: 6, failed: 0 }];
    const with304 = samples.map((x, i) => (i >= 2947 ? { ...x, status: 304 } : x));
    expect(readsOutside(start, end, notModified, with304)).toBe(0);
    // A request with no sample counts in the window of the reads.
    const more = [{ route: "GET /repos/{owner}/{repo}", count: 2963, notModified: 0, failed: 10 }];
    expect(readsOutside(start, end, more, samples)).toBe(-10);
  });

  it("names the windows of the answers when there are more than one", () => {
    const samples = [
      { at: 1, used: 1303, reset: RESET },
      { at: 2, used: 34, reset: RESET + 225 },
      { at: 3, used: 1304, reset: RESET },
      { at: 4, used: 35, reset: RESET + 225 },
    ];
    const out = outsideUse(samples);
    expect(out).toEqual({ requests: 0, answers: 4, windows: 2, jumps: [] });
    expect(outsideLine(out, 0)).toBe(
      "GitHub requests outside the meter: 0, from 4 answers in 2 windows of the rate limit. The two reads of GET /rate_limit give 0.",
    );
  });

  it("gives both measures, and tells when they disagree", () => {
    const zero = { requests: 0, answers: 1940, jumps: [] };
    expect(outsideLine(zero, 7965)).toBe(
      "GitHub requests outside the meter: 0, from 1940 answers. The two reads of GET /rate_limit give 7965. The two measures disagree, so neither count is a read. The report has each sample (rateLimit.samples).",
    );
    expect(outsideLine({ requests: 7900, answers: 1940, jumps: [] }, 7965)).toBe(
      "GitHub requests outside the meter: 7900, from 1940 answers. The two reads of GET /rate_limit give 7965.",
    );
    expect(outsideLine(zero, DISAGREE_MIN)).not.toMatch(/disagree/);
    expect(outsideLine(zero, DISAGREE_MIN + 1)).toMatch(/disagree/);
    expect(outsideLine(zero, -(DISAGREE_MIN + 1))).toMatch(/disagree/);
    expect(outsideLine({ requests: 0, answers: 0, jumps: [] }, 12)).toBe(
      "GitHub requests outside the meter: no read from the answers (no answer had the header x-ratelimit-used). The two reads of GET /rate_limit give 12.",
    );
  });
});

describe("countedRequest", () => {
  it("counts each request of the API except GET /rate_limit, and no request to another host", () => {
    expect(countedRequest(`${API}/repos/o/r/pulls/1`)).toBe(true);
    expect(countedRequest(`${API}/graphql`, { method: "POST" })).toBe(true);
    expect(countedRequest(`${API}/rate_limit`)).toBe(false);
    expect(countedRequest("https://registry.npmjs.org/@ex%2fcore")).toBe(false);
  });
});

describe("rateTracker", () => {
  const RESET = 1_800_000_000;
  const BEFORE = (RESET - 600) * 1000;

  it("keeps the highest used count of a window, so an answer with a lower count does not raise the budget", () => {
    const rate = rateTracker();
    rate.observe({ used: 500, remaining: 9750, reset: RESET });
    rate.observe({ used: 480, remaining: 9770, reset: RESET });
    // An answer with no remaining count takes the limit of its window. Its reset is 30 s later, inside the same window.
    rate.observe({ used: 490, remaining: null, reset: RESET + 30 });
    expect(rate.windows()).toEqual([{ reset: RESET, limit: 10_250, used: 500 }]);
    expect(rate.live(BEFORE)).toEqual({ limit: 10_250, used: 500, remaining: 9750, reset: new Date(RESET * 1000).toISOString() });
  });

  it("keeps the lowest limit of a window, and skips an answer with no remaining count and no known window", () => {
    const rate = rateTracker();
    rate.observe({ used: 7, remaining: null, reset: RESET });
    expect(rate.windows()).toEqual([]);
    expect(rate.live(BEFORE)).toBeNull();
    rate.observe({ used: 10, remaining: 4990, reset: RESET });
    rate.observe({ used: 11, remaining: 10_239, reset: RESET });
    expect(rate.live(BEFORE)).toMatchObject({ limit: 5000, used: 11, remaining: 4989 });
  });

  it("skips a seed with a reset that is not a time", () => {
    const rate = rateTracker();
    rate.seed({ limit: 10_250, used: 1, remaining: 10_249, reset: "no time" });
    expect(rate.windows()).toEqual([]);
  });

  it("gives the highest used count of a window as its budget, for each order of the answers", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_250 }), { minLength: 1, maxLength: 40 }), (used) => {
        const rate = rateTracker();
        for (const u of used) rate.observe({ used: u, remaining: 10_250 - u, reset: RESET });
        expect(rate.live(BEFORE)?.remaining).toBe(10_250 - Math.max(...used));
      }),
    );
  });

  it("gives no live budget after each reset", () => {
    const rate = rateTracker();
    rate.observe({ used: 9000, remaining: 1250, reset: RESET });
    expect(rate.live(RESET * 1000)).toBeNull();
  });
});

// The numbers of the answers of Train 43920794285 (2026-11-16 17:40Z). The read of /rate_limit at the start and the
// first 8 answers of the new token gave a stale window. The true window starts at answer 9 (17:40:38.514Z).
describe("the live budget of the answers of Train 43920794285", () => {
  const LIMIT = 10_250;
  const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
  const START: RateLimitRead = { limit: LIMIT, used: 276, remaining: LIMIT - 276, reset: "2026-11-16T18:14:29.000Z" };
  const STALE = seconds("2026-11-16T18:14:28Z");
  const TRUE = seconds("2026-11-16T18:01:55Z");
  const NEXT = seconds("2026-11-16T19:01:55Z");
  const ANSWER_9 = Date.parse("2026-11-16T17:40:38.514Z");
  const answer = (used: number, reset: number): Response =>
    new Response("{}", { status: 200, headers: { "x-ratelimit-used": String(used), "x-ratelimit-remaining": String(Math.max(0, LIMIT - used)), "x-ratelimit-reset": String(reset) } });
  /** The answers of the run in turn: 8 stale answers (277 to 284 used), then the true answer 9 (9246 used). */
  const trainAnswers = (rest: Response[] = []): FetchFn => {
    const list = [...Array.from({ length: 8 }, (_, i) => answer(277 + i, STALE)), answer(9246, TRUE), ...rest];
    return async () => list.shift() ?? new Response("{}", { status: 500 });
  };
  /** A meter with the start read as its first value and the first `n` answers of the run. */
  const after = async (n: number, rest: Response[] = []): Promise<ReturnType<typeof requestMeter>> => {
    const meter = requestMeter(trainAnswers(rest), API, () => ANSWER_9);
    meter.rate.seed(START);
    for (let i = 0; i < n; i++) await meter.fetch(`${API}/repos/o/r${i}`);
    return meter;
  };
  const STALE_LIVE = { limit: LIMIT, used: 284, remaining: LIMIT - 284, reset: "2026-11-16T18:14:29.000Z" };
  const TRUE_LIVE = { limit: LIMIT, used: 9246, remaining: 1004, reset: "2026-11-16T18:01:55.000Z" };

  it("(1) takes the start read and 8 stale answers as one window, and the true window from answer 9", async () => {
    const stale = await after(8);
    // The resets of the start read and the stale answers differ by 1 s, so they are one window.
    expect(stale.rate.windows()).toEqual([{ reset: STALE + 1, limit: LIMIT, used: 284 }]);
    expect(stale.rate.live(ANSWER_9)).toEqual(STALE_LIVE);
    const live = await after(9);
    expect(live.rate.windows()).toEqual([
      { reset: TRUE, limit: LIMIT, used: 9246 },
      { reset: STALE + 1, limit: LIMIT, used: 284 },
    ]);
    // The true window has the fewest requests left, so it is the live budget.
    expect(live.rate.live(ANSWER_9)).toEqual(TRUE_LIVE);
  });

  it("(2) drops the true window after its reset, and the next true answer sets the new window", async () => {
    const meter = await after(9, [answer(400, NEXT)]);
    // After the reset of 18:01:55, only the stale window is left.
    expect(meter.rate.live(Date.parse("2026-11-16T18:01:56Z"))).toEqual(STALE_LIVE);
    await meter.fetch(`${API}/repos/o/next`);
    expect(meter.rate.live(Date.parse("2026-11-16T18:05:00Z"))).toEqual({ limit: LIMIT, used: 400, remaining: LIMIT - 400, reset: "2026-11-16T19:01:55.000Z" });
  });

  it("(3) holds the budget low after a stale answer with a higher used count and a later reset", async () => {
    const meter = await after(9, [answer(10_100, STALE)]);
    await meter.fetch(`${API}/repos/o/stale`);
    // The stale window keeps its highest used count. It has fewer requests left than the true window, so it is the live budget.
    expect(meter.rate.live(ANSWER_9)).toEqual({ limit: LIMIT, used: 10_100, remaining: 150, reset: "2026-11-16T18:14:29.000Z" });
  });
});
