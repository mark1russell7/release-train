/**
 * Kept answers of the GitHub API between two runs. Most GET requests of a run read files and lists that did not change since
 * the run before. With the validators of a kept answer, GitHub answers 304, and GitHub does not count a 304 against the rate
 * limit. The store and the conditional fetch come from polite-crawler/api (`keptFetch`, `keptStore`, `sealKept`, `openKept`).
 *
 * The cache of this public repository holds the store between two runs. A kept answer of a private repository holds its body,
 * so the file is sealed (AES-256-GCM, a key from the secret by HKDF with the label `KEPT_LABEL`). The store keeps only the
 * entries that a run used, so it does not grow with answers that no run asks for again.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { KEPT_SEAL_SECRET_MIN, keptFetch, keptStore, openKept, sealKept } from "polite-crawler/api";
import type { FetchLike, Kept, KeptMemory, KeptStore } from "polite-crawler/api";
import type { FetchFn } from "./collect.ts";

/** The label of the seal. The secret of the seal also has a second use, so the label gives this use its own key. */
export const KEPT_LABEL = "release-train-kept/1";

/** The statuses whose answer has no body. The constructor of `Response` refuses a body for them. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** A signal that does not stop at any time. The kept fetch needs a signal, and a request of the train can have none. */
const NO_SIGNAL = new AbortController().signal;

/** This function tells if the headers are a plain record of texts. The kept fetch reads only that form. */
function plainHeaders(headers: RequestInit["headers"]): headers is Record<string, string> {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers) || headers instanceof Headers) return false;
  return Object.values(headers).every((value) => typeof value === "string");
}

/** This function makes a `Response` from the answer that the kept fetch gives for a 304: the kept status, headers and body. */
async function toResponse(answer: Awaited<ReturnType<FetchLike>>): Promise<Response> {
  const headers = new Headers();
  answer.headers.forEach((value, name) => headers.append(name, value));
  const body = NULL_BODY.has(answer.status) ? null : await answer.text();
  return new Response(body, { status: answer.status, statusText: answer.statusText, headers });
}

/**
 * This function makes a fetch with kept answers for the GitHub API. Some GET requests go through `keptFetch`: a GET of the API
 * with no body and with its headers as a plain record. It sends the validators of the kept answer. A 304 then gives the kept
 * answer as a 200.
 * Each other request goes to `fetch` as it is. The fetch follows a redirect, as before: a moved repository answers 301.
 *
 * Put this fetch above the meter: then the meter counts each real 304, and the guard sees the kept answer.
 */
export function keptGitHubFetch(fetch: FetchFn, store: KeptStore, apiBase: string = "https://api.github.com"): FetchFn {
  const inner: FetchLike = (url, init) => {
    // The kept fetch asks for a manual redirect. The train follows each redirect, so that field does not go on.
    const { redirect: _manual, signal, ...rest } = init;
    return fetch(url, signal === NO_SIGNAL ? rest : { ...rest, signal });
  };
  const kept = keptFetch(inner, store);
  const prefix = `${apiBase}/`;
  return async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = init?.headers ?? {};
    if (method !== "GET" || !url.startsWith(prefix) || (init?.body ?? null) !== null || !plainHeaders(headers)) {
      return fetch(url, init);
    }
    const answer = await kept(url, { method, headers, redirect: "manual", signal: init?.signal ?? NO_SIGNAL });
    return answer instanceof Response ? answer : toResponse(answer);
  };
}

/** The store of a run, the entries that it opened, and the reason when the store gave fewer kept answers or none. */
export interface KeptRun {
  readonly store: KeptMemory;
  readonly opened: readonly (readonly [string, Kept])[];
  readonly note: string | null;
}

/** This function gives the reason why a secret cannot seal the store, or null when it can. */
export function keptSecretProblem(secret: string): string | null {
  if (secret === "") return "the seal has no secret";
  const bytes = new TextEncoder().encode(secret).length;
  return bytes < KEPT_SEAL_SECRET_MIN ? `the secret of the seal has ${bytes} bytes, and the seal needs ${KEPT_SEAL_SECRET_MIN} or more` : null;
}

/**
 * This function opens the sealed store of the run before. A missing file, or a file that does not open (another secret,
 * another label, damaged bytes), gives an empty store and a note, and no error.
 */
export async function openTrainKept(path: string, secret: string): Promise<KeptRun> {
  if (!existsSync(path)) return { store: keptStore(), opened: [], note: "kept answers: no store from a run before, so each GET is a full read" };
  const opened = await openKept(new Uint8Array(readFileSync(path)), secret, { label: KEPT_LABEL });
  const note = opened.note === undefined ? null : `kept answers: ${opened.note}`;
  return { store: keptStore(opened.entries), opened: opened.entries, note };
}

/**
 * This function seals the store and writes it to the file. It gives the count of entries and of bytes. After a complete run,
 * the store has only the entries that the run used. A run that stopped early (a stop of the gate or the guard, a run with
 * --only, an error) did not ask for each answer again, so the store also keeps the entries that it opened.
 */
export async function sealTrainKept(path: string, run: KeptRun, secret: string, complete: boolean): Promise<{ entries: number; bytes: number }> {
  const used = complete ? run.store.used() : [...new Map([...run.opened, ...run.store.used()])];
  const sealed = await sealKept(used, secret, { label: KEPT_LABEL });
  writeFileSync(path, sealed);
  return { entries: used.length, bytes: sealed.length };
}
