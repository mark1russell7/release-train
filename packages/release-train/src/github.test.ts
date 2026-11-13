// All names in these tests are made up.
import { describe, expect, it } from "vitest";
import type { FetchFn } from "./collect.ts";
import { gitHub, rateLimitLine, readRateLimit } from "./github.ts";
import type { RateLimitRead } from "./github.ts";

const RESET = Date.parse("2026-11-11T13:00:00Z") / 1000;

const client = (f: FetchFn) => gitHub({ token: "t", fetch: f });
const answer = (status: number, data: unknown): FetchFn => async () => new Response(JSON.stringify(data), { status });

describe("readRateLimit", () => {
  it("reads the core numbers of the REST API", async () => {
    const calls: string[] = [];
    const f: FetchFn = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return new Response(JSON.stringify({ resources: { core: { limit: 5000, used: 120, remaining: 4880, reset: RESET } } }), { status: 200 });
    };
    expect(await readRateLimit(client(f))).toEqual({ limit: 5000, used: 120, remaining: 4880, reset: "2026-11-11T13:00:00.000Z" });
    expect(calls).toEqual(["GET /rate_limit"]);
  });

  it("gives null for an error, a body with no numbers and a failed fetch", async () => {
    expect(await readRateLimit(client(answer(404, { message: "Not Found" })))).toBeNull();
    expect(await readRateLimit(client(answer(200, { resources: { core: { limit: "many" } } })))).toBeNull();
    expect(
      await readRateLimit(
        client(async () => {
          throw new Error("network down");
        }),
      ),
    ).toBeNull();
  });
});

describe("rateLimitLine", () => {
  const read = (used: number): RateLimitRead => ({ limit: 5000, used, remaining: 5000 - used, reset: "2026-11-11T13:00:00.000Z" });

  it("gives the limit, the used count at the start and at the end, the count left and the reset time", () => {
    expect(rateLimitLine({ start: read(100), end: read(340) })).toBe(
      "GitHub rate limit: 5000 requests an hour, 100 used at the start, 340 used at the end, 4660 left, reset at 2026-11-11T13:00:00.000Z.",
    );
  });

  it("shows no read for a read that failed", () => {
    expect(rateLimitLine({ start: null, end: read(340) })).toContain("no read used at the start, 340 used at the end");
    expect(rateLimitLine({ start: read(100), end: null })).toContain("100 used at the start, no read used at the end, 4900 left");
    expect(rateLimitLine({ start: null, end: null })).toBe("GitHub rate limit: no read.");
  });
});
