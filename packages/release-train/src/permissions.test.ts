import { describe, expect, it } from "vitest";
import { callGaps, gapLine, grantOf, missingPermissions, templateCalls, workflowGaps, type Grant, type ReadAt } from "./permissions.ts";

const OWNER = "example-owner";
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const T = `${OWNER}/template`;

/** The caller job of the incident: it grants `contents: write` and `pull-requests: write` only. */
const caller = (sha: string, top = "permissions: {}", job = "    permissions:\n      contents: write\n      pull-requests: write\n") =>
  [
    "name: Release",
    "on: push",
    top,
    "jobs:",
    "  version:",
    `    uses: ${T}/.github/workflows/reusable-release-version.yml@${sha} # main`,
    job,
    "  publish:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      id-token: write",
    "    steps:",
    `      - uses: ${T}/.github/actions/npm-publish@${sha} # main`,
    "",
  ].join("\n");

/** The called workflow at template commit 8ad943e: its job asks for `actions: write` too. */
const version8ad943e = [
  "on:",
  "  workflow_call:",
  "jobs:",
  "  version:",
  "    runs-on: ubuntu-latest",
  "    permissions:",
  "      contents: write",
  "      pull-requests: write",
  "      actions: write",
  "    steps:",
  "      - run: echo",
  "",
].join("\n");

/** The called workflow at template commit c348dc5: the ask of `actions: write` is gone. */
const versionC348dc5 = version8ad943e.replace("      actions: write\n", "");

const g = (value: unknown): Grant => {
  const r = grantOf(value);
  if (r === null) throw new Error("no grant");
  return r;
};

describe("grantOf", () => {
  it("reads a map, the shorthand forms and an absent block", () => {
    expect(grantOf(undefined)).toBeNull();
    expect(grantOf(null)).toBeNull();
    expect(grantOf({})).toEqual({ base: "none", scopes: {} });
    expect(grantOf("read-all")).toEqual({ base: "read", scopes: {} });
    expect(grantOf("write-all")).toEqual({ base: "write", scopes: {} });
    expect(grantOf({ contents: "read", issues: "none", x: 3 })).toEqual({ base: "none", scopes: { contents: "read", issues: "none", x: "none" } });
  });
});

describe("missingPermissions", () => {
  const cases: { name: string; granted: unknown; asked: unknown; missing: string[] }[] = [
    { name: "8ad943e: actions: write asked, not granted", granted: { contents: "write", "pull-requests": "write" }, asked: { contents: "write", "pull-requests": "write", actions: "write" }, missing: ["actions: write < none"] },
    { name: "c348dc5: each ask granted", granted: { contents: "write", "pull-requests": "write" }, asked: { contents: "write", "pull-requests": "write" }, missing: [] },
    { name: "write covers read", granted: { contents: "write" }, asked: { contents: "read" }, missing: [] },
    { name: "read does not cover write", granted: { contents: "read" }, asked: { contents: "write" }, missing: ["contents: write < read"] },
    { name: "write-all covers each scope", granted: "write-all", asked: { actions: "write", "id-token": "write", "a-new-scope": "write" }, missing: [] },
    { name: "read-all covers each read, but no write", granted: "read-all", asked: { contents: "read", packages: "write" }, missing: ["packages: write < read"] },
    { name: "an ask of none asks nothing", granted: {}, asked: { contents: "none" }, missing: [] },
    { name: "an ask of write-all needs each scope", granted: { contents: "write" }, asked: "write-all", missing: ["actions: write < none", "id-token: write < none", "pull-requests: write < none"] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const got = missingPermissions(g(c.granted), g(c.asked)).map((m) => `${m.scope}: ${m.asked} < ${m.granted}`);
      if (c.missing.length === 0) expect(got).toEqual([]);
      else for (const m of c.missing) expect(got).toContain(m);
      if (c.name.includes("write-all needs")) expect(got).not.toContain("contents: write < write");
    });
  }
});

describe("templateCalls", () => {
  it("gives each job that calls a shared workflow, with the permissions of the job as the cap", () => {
    const calls = templateCalls(caller(SHA), OWNER);
    expect(calls).toEqual([{ job: "version", path: ".github/workflows/reusable-release-version.yml", sha: SHA, grant: { base: "none", scopes: { contents: "write", "pull-requests": "write" } } }]);
  });

  it("takes the permissions of the workflow when the job has none", () => {
    const calls = templateCalls(caller(SHA, "permissions:\n  contents: read", ""), OWNER);
    expect(calls[0]?.grant).toEqual({ base: "none", scopes: { contents: "read" } });
  });

  it("gives a null cap when neither the job nor the workflow has permissions", () => {
    expect(templateCalls(caller(SHA, "", ""), OWNER)[0]?.grant).toBeNull();
  });

  it("skips a composite action ref, a local workflow, another owner and a text that is not YAML", () => {
    const text = [
      "jobs:",
      "  a:",
      `    uses: ${T}/.github/actions/npm-publish@${SHA}`,
      "  b:",
      "    uses: ./.github/workflows/ci.yml",
      "  c:",
      `    uses: someone-else/template/.github/workflows/reusable-ci.yml@${SHA}`,
      "",
    ].join("\n");
    expect(templateCalls(text, OWNER)).toEqual([]);
    expect(templateCalls("jobs: [", OWNER)).toEqual([]);
  });
});

describe("workflowGaps", () => {
  const reader = (files: Record<string, string>): ReadAt => async (path, sha) => files[`${path}@${sha}`] ?? null;
  const at = (path: string, sha: string, text: string) => ({ [`.github/workflows/${path}@${sha}`]: text });

  const cases: { name: string; caller: string; files: Record<string, string>; gaps: string[] }[] = [
    { name: "8ad943e: the called job asks for actions: write, and the caller does not grant it", caller: caller(SHA), files: at("reusable-release-version.yml", SHA, version8ad943e), gaps: ["version|version|actions"] },
    { name: "c348dc5: the called job asks only for what the caller grants", caller: caller(SHA), files: at("reusable-release-version.yml", SHA, versionC348dc5), gaps: [] },
    {
      name: "the workflow-level permissions of the caller are the cap of a job with none",
      caller: caller(SHA, "permissions:\n  contents: write\n  pull-requests: write\n  actions: write", ""),
      files: at("reusable-release-version.yml", SHA, version8ad943e),
      gaps: [],
    },
    { name: "the job permissions of the caller replace the workflow permissions", caller: caller(SHA, "permissions: write-all"), files: at("reusable-release-version.yml", SHA, version8ad943e), gaps: ["version|version|actions"] },
    { name: "write covers read", caller: caller(SHA), files: at("reusable-release-version.yml", SHA, versionC348dc5.replace("contents: write", "contents: read")), gaps: [] },
    { name: "write-all covers each ask", caller: caller(SHA, "permissions: {}", "    permissions: write-all\n"), files: at("reusable-release-version.yml", SHA, version8ad943e), gaps: [] },
    { name: "a called job with no permissions block asks for nothing", caller: caller(SHA), files: at("reusable-release-version.yml", SHA, version8ad943e.replace(/ {4}permissions:\n( {6}.+\n)+/, "")), gaps: [] },
    {
      name: "a called job with no permissions block gets the block of its file",
      caller: caller(SHA),
      files: at("reusable-release-version.yml", SHA, `permissions:\n  checks: write\n${version8ad943e.replace(/ {4}permissions:\n( {6}.+\n)+/, "")}`),
      gaps: ["version|version|checks"],
    },
    { name: "a caller with no permissions anywhere is not examined", caller: caller(SHA, "", ""), files: {}, gaps: [] },
    { name: "an unread called file holds", caller: caller(SHA), files: {}, gaps: ["version|unread"] },
    {
      name: "a nested call of the called workflow asks within the cap of its caller",
      caller: caller(SHA),
      files: {
        ...at("reusable-release-version.yml", SHA, ["on: workflow_call", "jobs:", "  inner:", `    uses: ${T}/.github/workflows/reusable-inner.yml@${OTHER}`, "  local:", "    uses: ./.github/workflows/reusable-local.yml", ""].join("\n")),
        ...at("reusable-inner.yml", OTHER, version8ad943e),
        ...at("reusable-local.yml", SHA, versionC348dc5),
      },
      gaps: ["version|inner > version|actions"],
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const gaps = await workflowGaps(c.caller, OWNER, reader(c.files));
      expect(gaps.map((x) => (x.unread ? `${x.job}|unread` : `${x.job}|${x.calledJob}|${x.missing.map((m) => m.scope).join(",")}`))).toEqual(c.gaps);
    });
  }

  it("follows the own permissions of a called job as the cap of its nested call", async () => {
    const outer = ["on: workflow_call", "jobs:", "  inner:", "    permissions:", "      contents: read", `    uses: ${T}/.github/workflows/reusable-inner.yml@${SHA}`, ""].join("\n");
    const files = { ...at("reusable-outer.yml", SHA, outer), ...at("reusable-inner.yml", SHA, versionC348dc5) };
    const gaps = await callGaps({ job: "x", path: ".github/workflows/reusable-outer.yml", sha: SHA, grant: g("write-all") }, OWNER, reader(files));
    expect(gaps.map((x) => `${x.calledJob}|${x.missing.map((m) => `${m.scope}:${m.granted}`).join(",")}`)).toEqual(["inner > version|contents:read,pull-requests:none"]);
  });

  it("gives a report line with the caller job, the called workflow and each missing permission", async () => {
    const [gap] = await workflowGaps(caller(SHA), OWNER, reader(at("reusable-release-version.yml", SHA, version8ad943e)));
    if (!gap) throw new Error("no gap");
    const line = gapLine(".github/workflows/release.yml", gap);
    expect(line).toContain("`.github/workflows/release.yml` job `version` calls `.github/workflows/reusable-release-version.yml` at `aaaaaaa`");
    expect(line).toContain("`actions: write` (the caller grants `none`)");
  });
});
