// All names in these tests are made up. No test uses the network.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptStore } from "polite-crawler/api";
import type { Kept } from "polite-crawler/api";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchFn } from "./collect.ts";
import { keptGitHubFetch, keptSecretProblem, openTrainKept, pinnedToCommit, sealTrainKept } from "./kept.ts";

const API = "https://api.github.com";
const FILE = `${API}/repos/acme/widget/contents/package.json`;
const SECRET = "a-random-key-of-32-characters-00";

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

/** A server with one resource. It answers 304 to the current ETag, and counts each request that it sees. */
function server(): { fetch: FetchFn; seen: Seen[]; body: { text: string; etag: string } } {
  const seen: Seen[] = [];
  const body = { text: '{"name":"widget","version":"1.0.0"}', etag: 'W/"v1"' };
  const fetch: FetchFn = (url, init) => {
    seen.push({ url, init });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["if-none-match"] === body.etag) {
      return Promise.resolve(new Response(null, { status: 304, headers: { etag: body.etag, "x-ratelimit-remaining": "4999" } }));
    }
    return Promise.resolve(
      new Response(body.text, {
        status: 200,
        headers: { etag: body.etag, "content-type": "application/json; charset=utf-8", link: `<${FILE}?page=2>; rel="next"` },
      }),
    );
  };
  return { fetch, seen, body };
}

const get = { method: "GET", headers: { accept: "application/vnd.github+json", authorization: "Bearer one" } };

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";

describe("pinnedToCommit", () => {
  it.each([
    [`${API}/repos/acme/widget/git/blobs/${SHA}`, true],
    [`${API}/repos/acme/widget/git/trees/${SHA}?recursive=1`, true],
    [`${API}/repos/acme/widget/commits/${SHA}`, true],
    [`${API}/repos/acme/widget/compare/${SHA}...${SHA2}`, true],
    [`${API}/repos/acme/widget/contents/a/package.json?ref=${SHA}`, true],
    [`${API}/repos/acme/widget/contents/package.json?x=1&ref=${SHA}`, true],
  ])("%s is pinned", (url, pinned) => expect(pinnedToCommit(url)).toBe(pinned));

  it.each([
    // A branch, a short SHA or a capital SHA can name another commit later.
    `${API}/repos/acme/widget/git/trees/main?recursive=1`,
    `${API}/repos/acme/widget/contents/package.json?ref=main`,
    `${API}/repos/acme/widget/contents/package.json?ref=${SHA.slice(0, 7)}`,
    `${API}/repos/acme/widget/contents/package.json?ref=${SHA}x`,
    `${API}/repos/acme/widget/git/blobs/${SHA.toUpperCase()}`,
    `${API}/repos/acme/widget/compare/main...${SHA}`,
    // The status and the check runs of a commit change.
    `${API}/repos/acme/widget/commits/${SHA}/status`,
    `${API}/repos/acme/widget/commits/${SHA}/check-runs`,
    `${API}/repos/acme/widget/pulls/1/files`,
    // Another host, or a path that is not of a repository.
    `https://example.test/repos/acme/widget/git/blobs/${SHA}`,
    // A host whose name starts with the name of the API host.
    `${API}.example.test/repos/acme/widget/git/blobs/${SHA}`,
    `${API}/git/blobs/${SHA}`,
  ])("%s is not pinned", (url) => expect(pinnedToCommit(url)).toBe(false));
});

describe("keptGitHubFetch", () => {
  it("gives the kept answer of a pinned URL with no request, and counts it", async () => {
    const BLOB = `${API}/repos/acme/widget/git/blobs/${SHA}`;
    const s = server();
    const pinned: string[] = [];
    const store = keptStore();
    const f = keptGitHubFetch(s.fetch, store, API, (url) => pinned.push(url));
    const first = await f(BLOB, get);
    expect(first.status).toBe(200);
    expect(s.seen).toHaveLength(1);
    expect(pinned).toEqual([]);
    const second = await f(BLOB, { ...get, headers: { ...get.headers, authorization: "Bearer two" } });
    expect(s.seen).toHaveLength(1);
    expect(pinned).toEqual([BLOB]);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(s.body.text);
    expect(second.headers.get("etag")).toBe('W/"v1"');
    // The store records the entry as used, so the next seal keeps it.
    expect(store.used().map(([key]) => key)).toEqual([`application/vnd.github+json ${BLOB}`]);
  });

  it("sends a request for a pinned URL with no kept answer, and for a pinned URL with another accept header", async () => {
    const BLOB = `${API}/repos/acme/widget/git/blobs/${SHA}`;
    const s = server();
    const f = keptGitHubFetch(s.fetch, keptStore());
    await f(BLOB, get);
    await f(BLOB, { ...get, headers: { ...get.headers, accept: "application/vnd.github.raw" } });
    expect(s.seen).toHaveLength(2);
  });

  it("sends the validator of the kept answer, and a 304 gives the kept body as a 200", async () => {
    const s = server();
    const f = keptGitHubFetch(s.fetch, keptStore());
    const first = await f(FILE, get);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(s.body.text);
    // The token of the next run is another token: the key of the store does not hold it.
    const second = await f(FILE, { ...get, headers: { ...get.headers, authorization: "Bearer two" } });
    expect(s.seen).toHaveLength(2);
    expect((s.seen[1]?.init?.headers as Record<string, string>)["if-none-match"]).toBe('W/"v1"');
    expect(second.status).toBe(200);
    expect(second.ok).toBe(true);
    expect(await second.text()).toBe(s.body.text);
    expect(second.headers.get("link")).toBe(`<${FILE}?page=2>; rel="next"`);
  });

  it("gives the new body when the resource changed", async () => {
    const s = server();
    const f = keptGitHubFetch(s.fetch, keptStore());
    await f(FILE, get);
    s.body.text = '{"name":"widget","version":"1.0.1"}';
    s.body.etag = 'W/"v2"';
    const after = await f(FILE, get);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe(s.body.text);
  });

  it("does not ask for a manual redirect, and passes the signal of the request on", async () => {
    const s = server();
    const f = keptGitHubFetch(s.fetch, keptStore());
    const signal = new AbortController().signal;
    await f(FILE, get);
    await f(FILE, { ...get, signal });
    expect(s.seen.map((x) => x.init?.redirect)).toEqual([undefined, undefined]);
    expect(s.seen[0]?.init?.signal).toBeUndefined();
    expect(s.seen[1]?.init?.signal).toBe(signal);
  });

  it("sends each other request as it is, and keeps nothing for it", async () => {
    const s = server();
    const store = keptStore();
    const f = keptGitHubFetch(s.fetch, store);
    await f(FILE, { method: "POST", headers: get.headers, body: "{}" });
    await f("https://registry.npmjs.org/widget", get);
    await f(FILE, { method: "GET", headers: new Headers(get.headers) });
    await f(FILE, { ...get, headers: { ...get.headers, "if-none-match": 'W/"v0"' } });
    expect(store.used()).toEqual([]);
    expect(s.seen).toHaveLength(4);
  });
});

describe("the sealed store of a run", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const path = (): string => {
    const d = mkdtempSync(join(tmpdir(), "train-kept-"));
    dirs.push(d);
    return join(d, "train-kept.sealed");
  };

  it("starts empty with a note when no run before left a store", async () => {
    const run = await openTrainKept(path(), SECRET);
    expect(run.store.used()).toEqual([]);
    expect(run.note).toMatch(/no store/);
  });

  it("keeps only the entries that the run used, and the next run opens them and gets a 304", async () => {
    const s = server();
    const file = path();
    const old: [string, Kept] = ["application/json https://api.github.com/repos/acme/old", { etag: 'W/"x"', status: 200, headers: {}, body: "{}" }];
    const before = { store: keptStore([old]), opened: [old], note: null };
    await keptGitHubFetch(s.fetch, before.store)(FILE, get);
    const saved = await sealTrainKept(file, before, SECRET, true);
    expect(saved.entries).toBe(1);
    expect(existsSync(file)).toBe(true);
    const next = await openTrainKept(file, SECRET);
    expect(next.note).toBeNull();
    const answer = await keptGitHubFetch(s.fetch, next.store)(FILE, get);
    expect(s.seen).toHaveLength(2);
    expect((s.seen[1]?.init?.headers as Record<string, string>)["if-none-match"]).toBe('W/"v1"');
    expect(await answer.text()).toBe(s.body.text);
  });

  it("keeps the entries that it opened after a run that stopped early", async () => {
    const s = server();
    const file = path();
    const old: [string, Kept] = ["application/json https://api.github.com/repos/acme/old", { etag: 'W/"x"', status: 200, headers: {}, body: "{}" }];
    const run = { store: keptStore([old]), opened: [old], note: null };
    await keptGitHubFetch(s.fetch, run.store)(FILE, get);
    expect((await sealTrainKept(file, run, SECRET, false)).entries).toBe(2);
    const next = await openTrainKept(file, SECRET);
    expect(next.opened.map(([key]) => key)).toContain(old[0]);
  });

  it("gives an empty store and a note for another secret or damaged bytes, and no error", async () => {
    const s = server();
    const file = path();
    const run = { store: keptStore(), opened: [], note: null };
    await keptGitHubFetch(s.fetch, run.store)(FILE, get);
    await sealTrainKept(file, run, SECRET, true);
    const other = await openTrainKept(file, "another-random-key-of-32-chars-0");
    expect(other.store.used()).toEqual([]);
    expect(other.note).toMatch(/^kept answers: /);
    writeFileSync(file, "not a sealed store");
    const damaged = await openTrainKept(file, SECRET);
    expect(damaged.store.used()).toEqual([]);
    expect(damaged.note).toMatch(/^kept answers: /);
  });

  it("tells why a secret cannot seal", () => {
    expect(keptSecretProblem("")).toMatch(/no secret/);
    expect(keptSecretProblem("short")).toMatch(/5 bytes/);
    expect(keptSecretProblem(SECRET)).toBeNull();
  });
});
