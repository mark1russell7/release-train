// The tests of dispatch.mjs: node --test scripts/release/

import assert from "node:assert/strict";
import { test } from "node:test";
import { ON_MAIN, compareWithMain, dispatchPlan } from "./dispatch.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const COMMAND = "gh workflow run release.yml --repo owner/repo --ref main";

/** This function gives the arguments of dispatchPlan(), and records each call of compare(). */
function input(overrides = {}, status = "identical") {
  const calls = [];
  return {
    calls,
    args: {
      repositories: new Set(["owner/repo"]),
      workflow: "release.yml",
      dispatch: true,
      failed: false,
      commits: new Map([["owner/repo", SHA]]),
      compare: (repository, sha) => {
        calls.push([repository, sha]);
        if (status instanceof Error) throw status;
        return status;
      },
      ...overrides,
    },
  };
}

test("only the head of main and the older commits of main are on main", () => {
  assert.deepEqual([...ON_MAIN].sort(), ["behind", "identical"]);
});

test("compareWithMain() makes one gh api call to the compare API and gives the status", () => {
  const calls = [];
  const status = compareWithMain("owner/repo", SHA, (args) => {
    calls.push(args);
    return "behind\n";
  });
  assert.equal(status, "behind");
  assert.deepEqual(calls, [["api", `repos/owner/repo/compare/main...${SHA}`, "--jq", ".status"]]);
});

test("a commit on main starts the release", () => {
  for (const status of ["identical", "behind"]) {
    const { args, calls } = input({}, status);
    assert.deepEqual(dispatchPlan(args), [{ repository: "owner/repo", start: true, text: "Started release.yml of owner/repo." }]);
    assert.deepEqual(calls, [["owner/repo", SHA]]);
  }
});

test("a commit that is not on main starts no release, and the text has the command for after the merge", () => {
  for (const status of ["ahead", "diverged"]) {
    const [step] = dispatchPlan(input({}, status).args);
    assert.equal(step.start, false);
    assert.match(step.text, new RegExp(`${SHA}, and that commit is not on main \\(status: ${status}\\)`));
    assert.match(step.text, /Merge the change to main/);
    assert.ok(step.text.endsWith(COMMAND));
  }
});

test("a compare that fails starts no release", () => {
  const [step] = dispatchPlan(input({}, new Error("gh: Not Found (HTTP 404)\nmore text")).args);
  assert.equal(step.start, false);
  assert.match(step.text, /status: not known \(GitHub did not compare it with main: gh: Not Found \(HTTP 404\)\)/);
  assert.ok(step.text.endsWith(COMMAND));
});

test("after a failure of the bootstrap, the script starts no release and does not compare", () => {
  const { args, calls } = input({ failed: true });
  const [step] = dispatchPlan(args);
  assert.equal(step.start, false);
  assert.match(step.text, /The bootstrap stopped before the end/);
  assert.ok(step.text.endsWith(COMMAND));
  assert.deepEqual(calls, []);
});

test("without --dispatch, the script shows the command and does not compare", () => {
  const { args, calls } = input({ dispatch: false });
  assert.deepEqual(dispatchPlan(args), [{ repository: "owner/repo", start: false, text: `Start the release in the next 2 days: ${COMMAND}` }]);
  assert.deepEqual(calls, []);
});

test("each repository gets its own decision, in the sequence of the set", () => {
  const statuses = { "owner/a": "identical", "owner/b": "ahead" };
  const plan = dispatchPlan({
    repositories: new Set(["owner/a", "owner/b"]),
    workflow: "release.yml",
    dispatch: true,
    failed: false,
    commits: new Map([
      ["owner/a", SHA],
      ["owner/b", SHA],
    ]),
    compare: (repository) => statuses[repository],
  });
  assert.deepEqual(
    plan.map(({ repository, start }) => [repository, start]),
    [
      ["owner/a", true],
      ["owner/b", false],
    ],
  );
});

test("no new trust gives no step", () => {
  assert.deepEqual(dispatchPlan(input({ repositories: new Set() }).args), []);
});
