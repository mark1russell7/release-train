// The tests of tags.mjs: node --test scripts/release/

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_NOTES, changelogSection, isPrerelease, releaseNotes, tagName, tagPlan } from "./tags.mjs";

const CHANGESETS = `# @scope/core

## 1.3.0-rc.1

### Minor Changes

- 1111111: A prerelease feature.

## 1.2.0

### Minor Changes

- abc1234: A new option \`timeout\`.

  The second paragraph of the entry.

### Patch Changes

- def5678: A fix.

## 1.1.0

- 9999999: An old change.
`;

test("a repository with one published package uses v<version>", () => {
  assert.equal(tagName("@scope/core", "1.2.0", 1), "v1.2.0");
});

test("a repository with more packages uses <name>@<version>", () => {
  assert.equal(tagName("@scope/core", "1.2.0", 2), "@scope/core@1.2.0");
  assert.equal(tagName("plain", "0.1.0-rc.1", 3), "plain@0.1.0-rc.1");
});

test("a version with a prerelease part is a prerelease", () => {
  assert.equal(isPrerelease("1.2.0-rc.1"), true);
  assert.equal(isPrerelease("1.2.0"), false);
  assert.equal(isPrerelease("1.2.0+build.5"), false);
  assert.equal(isPrerelease("1.2.0-beta.0+build-5"), true);
});

test("the section of a Changesets changelog stops at the next version", () => {
  assert.equal(
    changelogSection(CHANGESETS, "1.2.0", "@scope/core"),
    "### Minor Changes\n\n- abc1234: A new option `timeout`.\n\n  The second paragraph of the entry.\n\n### Patch Changes\n\n- def5678: A fix.",
  );
});

test("a release does not get the section of its prerelease, and the reverse", () => {
  assert.equal(changelogSection(CHANGESETS, "1.3.0-rc.1", "@scope/core"), "### Minor Changes\n\n- 1111111: A prerelease feature.");
  assert.equal(changelogSection(CHANGESETS, "1.3.0", "@scope/core"), undefined);
  assert.equal(changelogSection("## 1.2.0-rc.1\n\n- x\n", "1.2.0", "a"), undefined);
});

test("the last section stops at the end of the file", () => {
  assert.equal(changelogSection(CHANGESETS, "1.1.0", "@scope/core"), "- 9999999: An old change.");
});

test("other heading styles name the version", () => {
  const keepAChangelog = "# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-18\n### Added\n- A.\n\n## [1.1.0] - 2026-10-01\n- B.\n";
  assert.equal(changelogSection(keepAChangelog, "1.2.0", "x"), "### Added\n- A.");
  assert.equal(changelogSection("## v1.2.0\n\nText.\n", "1.2.0", "x"), "Text.");
  assert.equal(changelogSection("# x@1.2.0 (2026-10-18)\n\nText.\n# x@1.1.0\n", "1.2.0", "x"), "Text.");
  assert.equal(changelogSection("### 1.2.0\nText.\n## Older\n", "1.2.0", "x"), "Text.");
});

test("a version in the text of a heading is not a section heading", () => {
  assert.equal(changelogSection("## Upgrade to 1.2.0\n\nText.\n", "1.2.0", "x"), undefined);
  assert.equal(changelogSection("## 11.2.0\n\nText.\n", "1.2.0", "x"), undefined);
  assert.equal(changelogSection("## 1.2.0.1\n\nText.\n", "1.2.0", "x"), undefined);
});

test("a heading in fenced code does not stop the section", () => {
  const markdown = "## 1.2.0\n\n- A change:\n\n  ```sh\n  # a comment\n  ## another\n  ```\n\n- B.\n\n## 1.1.0\n";
  assert.equal(changelogSection(markdown, "1.2.0", "x"), "- A change:\n\n  ```sh\n  # a comment\n  ## another\n  ```\n\n- B.");
});

test("an empty section gives no text", () => {
  assert.equal(changelogSection("## 1.2.0\n\n## 1.1.0\n- B.\n", "1.2.0", "x"), undefined);
});

test("the notes are the changelog section, or else a list item with the npm link", () => {
  assert.equal(releaseNotes("@scope/core", "1.1.0", CHANGESETS), "- 9999999: An old change.");
  const fallback = "- Version 2.0.0 of [`@scope/core`](https://www.npmjs.com/package/@scope/core/v/2.0.0) on npm.";
  assert.equal(releaseNotes("@scope/core", "2.0.0", CHANGESETS), fallback);
  assert.equal(releaseNotes("@scope/core", "2.0.0", undefined), fallback);
});

test("a very long section is cut", () => {
  const notes = releaseNotes("x", "1.0.0", `## 1.0.0\n\n${"a".repeat(MAX_NOTES + 10)}\n`);
  assert.equal(notes.length, MAX_NOTES + "\n\n(The CHANGELOG.md of `x` has the full text.)".length);
  assert.ok(notes.endsWith("has the full text.)"));
});

test("the plan has one entry for each package, in the sequence of the packages", () => {
  const packages = [
    { dir: "/repo/packages/core", manifest: { name: "@scope/core", version: "1.2.0" } },
    { dir: "/repo/packages/cli", manifest: { name: "@scope/cli", version: "0.4.0-rc.1" } },
  ];
  const changelogs = { "/repo/packages/core": CHANGESETS };
  assert.deepEqual(
    tagPlan(packages, (dir) => changelogs[dir]),
    [
      {
        name: "@scope/core",
        version: "1.2.0",
        tag: "@scope/core@1.2.0",
        prerelease: false,
        notes: changelogSection(CHANGESETS, "1.2.0", "@scope/core"),
      },
      {
        name: "@scope/cli",
        version: "0.4.0-rc.1",
        tag: "@scope/cli@0.4.0-rc.1",
        prerelease: true,
        notes: "- Version 0.4.0-rc.1 of [`@scope/cli`](https://www.npmjs.com/package/@scope/cli/v/0.4.0-rc.1) on npm.",
      },
    ],
  );
  assert.equal(tagPlan([packages[0]], () => undefined)[0].tag, "v1.2.0");
  assert.deepEqual(tagPlan([], () => undefined), []);
});
