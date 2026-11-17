/**
 * The GitHub accounts of a run of the train. The home account has the template, the npm scope and the App of the train.
 * The other accounts have only repositories. The name of a repository is its key in each account, so a name is in one
 * account only.
 */
export interface Accounts {
  /** The home account. */
  readonly home: string;
  /** The other accounts, in the order of the command line. */
  readonly others: readonly string[];
  /** This function gives the token of an account, or null. The home token can be null: then the reads have no token. */
  token(account: string): string | null;
}

/** This function gives the account of each repository. */
export type AccountOf = (repo: string) => string;

/**
 * This function makes the accounts of a run.
 *
 * @param home - The home account.
 * @param homeToken - The token of the home account, or null.
 * @param others - The other accounts. The function drops each copy and the home account.
 * @param tokens - The token of each other account, by name. A name in a different case is the same account.
 */
export function runAccounts(home: string, homeToken: string | null, others: readonly string[] = [], tokens: Readonly<Record<string, string>> = {}): Accounts {
  const keyed = new Map(Object.entries(tokens).map(([a, t]) => [a.toLowerCase(), t]));
  const seen = new Set([home.toLowerCase()]);
  const list: string[] = [];
  for (const a of others) {
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    list.push(a);
  }
  return {
    home,
    others: list,
    token: (account) => (account.toLowerCase() === home.toLowerCase() ? homeToken : (keyed.get(account.toLowerCase()) ?? null)),
  };
}

/**
 * This function reads the variable `GH_TOKENS`: a JSON object with the token of each other account, for example
 * `{"other-org": "ghs_..."}`. An absent or empty text gives no token. An empty token is no token.
 * An error message does not hold the text, because the text holds secrets.
 */
export function parseTokens(text: string | undefined): Record<string, string> {
  if (text === undefined || text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("GH_TOKENS is not JSON. It must be a JSON object with a token for each account.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("GH_TOKENS must be a JSON object with a token for each account.");
  const out: Record<string, string> = {};
  for (const [account, token] of Object.entries(value)) {
    if (typeof token !== "string") throw new Error(`GH_TOKENS has a value for ${account} that is not a text.`);
    if (token.trim() !== "") out[account] = token.trim();
  }
  return out;
}

/**
 * This function gives the account of each repository from a list. A repository that the list does not have is in the home
 * account.
 */
export function accountOfRepos(home: string, repos: readonly { name: string; account?: string }[]): AccountOf {
  const map = new Map(repos.filter((r) => r.account !== undefined).map((r) => [r.name, r.account as string]));
  return (repo) => map.get(repo) ?? home;
}

/** This function gives the account of each repository: one account for each, or the function itself. */
export function accountFn(owner: string | AccountOf): AccountOf {
  return typeof owner === "string" ? () => owner : owner;
}

/**
 * This function gives the account of a path or a URL of the GitHub API, or null for a path with no account.
 *
 * - `/repos/{account}/...`, `/users/{account}/...` and `/orgs/{account}/...` give the account of the path.
 * - `/repositories/{id}/...` gives the account of the id in `ids`. GitHub gives this form in the links of the next pages.
 * - `/search/...` gives the account of the first `user:` or `org:` qualifier of the query.
 *
 * @param url - The path, or the full URL.
 * @param ids - The account of each repository id.
 * @param apiBase - The base of the API. The function removes it from a full URL.
 */
export function accountOfPath(url: string, ids: ReadonlyMap<number, string> = new Map(), apiBase = "https://api.github.com"): string | null {
  let rest = url.startsWith(apiBase) ? url.slice(apiBase.length) : url;
  if (/^https?:\/\//.test(rest)) {
    try {
      const u = new URL(rest);
      rest = `${u.pathname}${u.search}`;
    } catch {
      return null;
    }
  }
  const q = rest.indexOf("?");
  const path = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? "" : rest.slice(q + 1);
  const [first, second] = path.split("/").filter(Boolean);
  if (second === undefined) return null;
  if (first === "repos" || first === "users" || first === "orgs") return decodeURIComponent(second);
  if (first === "repositories") return /^\d+$/.test(second) ? (ids.get(Number(second)) ?? null) : null;
  if (first === "search") {
    const m = /(?:^|\s)(?:user|org):(\S+)/.exec(new URLSearchParams(query).get("q") ?? "");
    return m?.[1] ?? null;
  }
  return null;
}

/** This function gives the repository id of a link of the form `/repositories/{id}/...`, or null. */
export function repositoryIdOf(link: string | null | undefined): number | null {
  const m = /\/repositories\/(\d+)(?:[/?]|$)/.exec(link ?? "");
  return m ? Number(m[1]) : null;
}
