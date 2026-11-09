# release-train

The release train reads the npm packages of the GitHub account `mark1russell7`. It makes the dependency graph of these packages and a plan of the next releases and updates.

Stage 1 only reads. Stage 2 (`apply`) opens a pull request for each update of the current wave. Stage 3 (the template sync, also in `apply`) keeps the files from the template repository current in each repository. The train does not publish to npm itself: the release workflow of each repository publishes.

## What it reads

- The repositories of the account. It skips archived repositories and forks.
- The root `package.json` of each repository, and each workspace package of `pnpm-workspace.yaml`.
- `pnpm-lock.yaml` or `package-lock.json`, for the resolved versions.
- The `latest` version of each package on the npm registry, each version under each tag, and the runtime ranges of `latest`.
- The open pull requests of each repository with a version, and the versions that their diffs set.

A package is a `package.json` with a name and without `"private": true`. An edge is a dependency on a package of the account.

## The actions of the plan

| Action | When |
|---|---|
| `new-package` | The package is not on npm. Only the owner can make a new package. |
| `release` | The version on `main` is newer than npm, or a dependency range of the package changes. |
| `adopt-in-range` | The range lets the newest version in, but the lockfile holds an older version. A lockfile update is sufficient. |
| `adopt-breaking` | The newest version is outside the range. The range must change. |

Each repository gets one combined action of each kind. The plan puts the actions in a topological sequence and shows each cycle.

### The version gate

- A version on `main` that npm has already, under a tag that is not `latest`, is taken. Its publish fails, so the plan blocks the release.
- An open pull request that sets a version of a `package.json` must set a new version. Only one open pull request can set it.
- A version of an open pull request that `main` or npm has already, or that two pull requests set, is taken too. This rule also covers private packages.
- The plan counts each taken version in `counts.taken` and gives the reason in `taken`. The gate keeps the count at 0.
- pnpm writes a real range in place of `workspace:^` at the publish. The plan reads that range from the latest version on npm.
- When that range does not cover the next version of the dependency, the dependent gets a cascade release in the same plan.
- The plan counts each such range in `counts.behind` and lists it in `behind`.
- A cascade release takes the first free version. npm can have a newer version under another tag.

## Use

```sh
GH_TOKEN=$(gh auth token) pnpm --filter @release-train/release-train plan
node packages/release-train/src/bin.ts plan --json
node packages/release-train/src/bin.ts plan --write-db <folder>
```

- `--public-only` removes each private repository from the output.
- `--out <file>` writes the full plan as JSON.
- `--no-progress` does not read the pull requests and the release runs.

## The site

The site at <https://mark1russell7.github.io/release-train/> is a plan explorer. The package `packages/site` bundles `graph.ts` and `plan.ts` of the library, so the page plans with the same code as the CLI.

- The page shows eight made-up packages. Change a bump, a provenance or a `github:` specifier. The page then shows the new plan in waves.
- `pages.yml` builds the site on each pull request and checks it in a browser. A push to `main` deploys it.

## CI

`plan.yml` computes the plan every 6 hours and on a manual start. It keeps `plan.json` as a workflow artifact. It uses the default token, so it sees only public repositories.

## Stage 2: apply

`apply` makes the plan again from the real state, then changes the repositories. It keeps no state between runs.

- It applies only the items that are ready. npm has the target version of such an item, and nothing holds it. Refer to "A partial update".
- Each repository gets one branch `release-train/update` and one combined pull request. A next run updates that branch and does not open a second pull request.
- A breaking adoption changes the range to a caret range of the new version (`^x.y.z`).
- The lockfile comes from the package manager of the repository. For pnpm, the train sets each range to the exact target version and starts `pnpm install --lockfile-only`. Then it sets each range to its final value (the old range, or the new caret range) and starts the install again, and a check with `--frozen-lockfile` must pass. For npm, it uses `npm install` and `npm update` with `--package-lock-only`. The train does not write a lockfile itself.
- The train does not use `pnpm update`, because it also updates the dependencies of each package. A dependency with a `github:` specifier and no commit gets the newest commit when pnpm resolves the lockfile. The pull request body lists such changes under "Other lockfile changes".
- pnpm 11 and later refuse a version that is younger than `minimumReleaseAge` (1 day by default, from `pnpm-workspace.yaml` or `.npmrc`). The train leaves out such a version and adds it in a later run. When each version of a repository is too young, the repository waits, and the train closes its open pull request with a mark. The train opens again a pull request that it closed itself, but not one that a person closed.
- The train updates the packages of the owner (`@<owner>/*` and `@procedures/*`), so their new versions must not wait. The train puts these two scopes into `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` and removes each entry that they cover (for example `@<owner>/name@1.0.2`). The wait stays for all other packages. A repository that uses pnpm 11 or later and has no `pnpm-workspace.yaml` gets a new file with only this setting. The change goes into the combined pull request. A repository with no update gets a pull request with only this change.
- The body of the pull request tells each change, the reason, and each other lockfile change. It has the label `release-train`.
- Only the train merges its pull requests. It turns off the native auto-merge of GitHub, and it merges a green pull request in a later run.
- Before a merge, the train compares the branch with the default branch. A branch that is behind gets a new build from the default branch, with a new install, and CI runs again. A merge of two lockfile changes can give a lockfile with no entry for a version, with no git conflict.
- When CI fails, the pull request stays open with the label `release-train:blocked`.
- The train closes its pull request when the plan has no update for the repository.
- The train does not open a pull request again when a person closed one with the same changes.

```sh
GH_TOKEN=<token> node packages/release-train/src/bin.ts apply --dry-run
node packages/release-train/src/bin.ts apply --only <repo> --report apply.json
```

- `--dry-run` shows the pull requests and changes nothing. It counts the pushes as a real run does, so it shows the same repositories as `waiting`. Only a clone tells that an update changes no file, so such a repository counts as a push in a dry run.
- `--only <repo>` changes only the given repositories (comma-separated).
- `--report <file>` writes the report without private names.
- `--author "Name <email>"` sets the author of the commits.
- `--show-private` shows the private names in the output. Do not use it in CI.
- `--cascade <repos>` sets the repositories (comma-separated) whose breaking adoptions carry a release, or `all` (the default). In other repositories with a release, the items that change a published range wait.
- `--release-dispatch` starts the release workflows that start only by hand. Refer to "Releases".
- `--max-pushes <n>` is the most branches that one run pushes (default 5). The update branches and the sync branches share this limit. The other repositories get `waiting`, and a later run pushes them.
- `--urgent <packages>` names public packages with a security fix (comma-separated). Refer to "An urgent update".

### A partial update

An adopt action of the plan has all the items of one repository. One item with a target that is not on npm does not stop the other items. The train sends the ready items, and a later run sends the items that wait. The plan does not change, so the action stays in its wave and keeps its waits.

An item waits in these three cases:

- npm does not have its target version.
- It is in one set with an item that waits. A peer range joins two packages. A runtime `workspace:` range also joins them, because npm gets an exact version of it. The sets include packages that the repository does not use itself. A `workspace:` range in `devDependencies` joins nothing, and a range of a private app joins nothing.
- It changes a published range, and the release of the repository cannot go with it. Read the rule below.

The plan does not group items by set. The train reads the sets from the edges of the plan. All items of one package in a repository go together or wait together, so the lockfile keeps one version of the package.

**The rule for a package with a release of its own.** A release is one action of a repository, and a repository can fix the versions of its packages together. So the train keeps these items together: the items of a public repository that change a runtime range of a package with a release action.

- They go in one pull request with the version bump when npm has each target and the release waits for no other action.
- When one of these items waits, or the release is blocked, waits for another action or has its cascade off, all of them wait. No package publishes before a dependency that it must carry, and the wave and cascade order stay.
- A lockfile item and an item in `devDependencies` change nothing on npm, so they do not wait for the release.
- The train publishes no package of a private repository, so this rule does not apply there.

One branch stays the design. A later run makes the update again from the default branch, with a new fingerprint, and it pushes to the open pull request. The train does not close the pull request for this. When no item can go, the repository is in the waiting list and an open pull request still merges on green.

The body of the pull request gives the names of the packages that wait. The report gives only the count, in the field `held`, and the summary has one line for all repositories. A private repository stays a count or a hash.

### The pace of the pushes

One new version of a package that most repositories use changes approximately 35 repositories. The pace stops such a version from starting CI in all of them in one run.

- Each push starts approximately 6 jobs in its repository, and all repositories of the account share 40 runners. So 5 pushes start approximately 30 jobs.
- An update push waits only for `--max-pushes`. A sync push also waits while 30 or more jobs run on the account. The account has so many jobs for most of a day, so that gate on an update push stops the train in silence. When the list of runs is not readable, a sync push waits only for the limit.
- A branch that gets a new commit counts. A branch that has its changes on the current default branch needs no push. It does not wait, and the train merges or blocks its pull request.
- At the limit, the train does not clone. A repository that waits has no cost, and an open pull request still merges on green or gets the blocked label. The next run reads the plan again, so it pushes the newest versions and skips the versions between.
- Each item of an update waits for no action, so the pace cannot put a later wave first. An update that another action waits for goes first.
- The other updates move one place in the order every 30 minutes, so no repository stays at the end. The sync order moves too. The update pushes and the sync pushes go first in turn.
- `--max-pushes 0` lets a run only merge or block.

At the default, 35 repositories need 7 runs, approximately 3.5 hours, when the sync takes no pushes. A sync with a long queue takes each second run while the account is not busy. Then the 35 repositories need approximately 7 hours. A `released` event adds a run.

### An urgent update

A person names the package. The train does not detect a security update. A run from the schedule or from a `released` event has no urgent names.

```sh
gh workflow run train.yml -R <owner>/release-train -f dry-run=false -f urgent=<package>
```

You can also start the workflow `Train` on the Actions page of this repository. Set `dry-run` to false, because its default is true. Give only public names, because GitHub shows the inputs. The name of a private package has no effect.

- The update goes first in the run, and it goes before the sync.
- The update does not wait for `--max-pushes`, and it does not use the count of the run. The train has no other limit here, so a popular package starts CI in all its repositories at once.
- The push carries each other change of the update branch of that repository.
- All other checks stay: the wave order, `--only`, `--cascade` and the provenance check. A closed pull request of a person and the Yarn and submodule skips also stay.
- CI and the checks of each repository stay too. The train still merges only on green, in a later run.
- The wave order stays, so an item that waits for a release does not go. Give each package of the chain to go fast, and start a new run after each release.
- The age rule stays for each package that you do not name. The scopes `@<owner>/*` and `@procedures/*` have no wait in a repository whose settings exclude them.
- A named package outside these scopes gets one entry in `minimumReleaseAgeExclude` of each repository with an age rule. The entry has the exact version, for example `fix@1.0.1`, so a newer version waits again. The pull request tells it.
- A later run with no urgent names merges the pull requests, and it paces each push that is still due.
- One run can wait while another run operates. A newer run replaces the run that waits. The newer run then takes the urgent names from the title of the replaced run, and the step summary tells it.
- The newer run gives the names to all repositories, also when the replaced run had `only`.
- A person who cancels a run that waits gets the same result as a replacement: the next run takes its names.
- The summary has a line `Urgent` with the count and the states. Another line gives the count of the names that change no ready update.

## Releases

When a dependency gets a new version outside the range of a dependent (a new major version, or a new minor version before `1.0.0`), the range of the dependent changes. The dependent must then have a new release too, else its users do not get the change. The train puts this release into the same pull request as the range change.

- The release type comes from the public types of the dependent. The train reads the typed files (`.d.ts` and TypeScript sources) of the version of the dependent on npm.
- When these files name the changed dependency (for example `from "@scope/dep"`), the types of the dependency can reach the users, so the change breaks the API. A change of a peer range also breaks the API. When npm gives no typed files, the case is not clear, so the change counts as a break of the API.
- When the files do not name the dependency, the release is a patch.
- A break of the API gives MINOR before `1.0.0` and MAJOR after.
- A repository with changesets (`.changeset/config.json`) gets a changeset file `.changeset/release-train-<fingerprint>.md`. The name is new on each update, so the Changesets check of the pull request sees it. This is also true when the default branch still has an unreleased changeset of an earlier run. Another repository gets the new version in `package.json`.
- After the new version, the train starts the `version` script of the package, as `npm version` does. The script gets the packages, but no git credentials. The script changes the other copies of the version, for example a `VERSION` constant or a registry entry. When the script fails, the update fails.
- After the install of each update, the train starts the root script `release-train:update` of `package.json`, when the repository has one. Also an update inside the range starts it. The script writes again the files that come from the installed packages, for example a data file of an engine. It gets the packages, but no git credentials. Its changed and new files go into the commit of the train. When the script fails, the update fails.
- When the repository has Prettier, each file that the train changed gets the format of the repository. The lockfiles stay.
- The body of the pull request has a table "Releases" with each package, its version, the release type and the reason.
- A private repository gets the pull request, but its packages are not published.
- When the release of the dependent is blocked, its range change waits too. Refer to "A partial update".

After the merge, the release workflow of the repository publishes the new version with OIDC. Some release workflows start only by hand (for example with changesets: one start makes the version pull request, and one start after its merge publishes). With `--release-dispatch`, the train merges a green version pull request (branch `changeset-release/main`) and starts such a workflow when CI on `main` is green. This needs the permission Actions: write of the GitHub App.

The report of `apply` lists the versions in flight. Such a version is on `main` of a public repository, and npm does not have it. Its release workflow starts on a push and its last run did not fail, or the workflow is active, or the train started it. The command `await-release --report <file> --minutes <n>` checks npm every 30 seconds. When npm has one of these versions, it sends the `released` event to the train, and the next wave starts at once.

When CI of a train pull request fails, the pull request gets the label `release-train:blocked`. `plan --write-db` then writes an alert into the collection `alerts` of the tracker. The strategist tells the role that owns the repository.

## Tag backfill

The job `tag` of a release run uses the workflow token. GitHub refuses that token (HTTP 403) when the workflow files of the commit differ from the workflow files of each branch. A published version then has no git tag and no GitHub release. The token of the owner has the `workflow` scope, so a local run can do this step. The workflow files of the repositories do not change.

```sh
node packages/release-train/src/bin.ts tags
node packages/release-train/src/bin.ts tags --since 2026-11-01 --only <repo>
node packages/release-train/src/bin.ts tags --write
```

The command reads the packages of the plan, their versions on npm and the tags of each repository. It starts `gh` with an argument list and no shell. A default run makes no write. It shows each version with no tag and its state.

`--write` refuses a start date that is older than 14 days. A dry run reads older dates. The rule for a local run with the token of the owner is in `CLAUDE.md`.

| State | Meaning |
|---|---|
| `missing` | The commit of the version is on the default branch. `--write` makes the release. |
| `created` | The run made the release. |
| `failed` | The run did not make the release. The line tells the reason. |
| `no-commit` | npm names no commit, or npm names two different commits. The version gets no tag. |
| `off-branch` | The commit is not on the default branch. The version gets no tag. |
| `young` | The version is younger than one hour, so its release run can still make the tag. |
| `no-tag-job` | The `release.yml` of the repository has no tag job. Such a repository makes no tags on purpose. |
| `error` | A read failed, so the version has no decision. The exit code is 1. |

- The name of the tag follows the rule of `RELEASING.md`: `v<version>` in a repository with one published package, else `<name>@<version>`. A tag of the other form also counts, because a repository can get a second package later. This hides five versions. `polite-crawler-mcp` 0.2.0 to 0.2.4 have no tag of their own. The tags `v0.2.0` to `v0.2.4` of the repository `crawler` count for them.
- The commit comes only from npm: the field `gitHead` of the version, or the commit of its provenance. The provenance must name the repository by its ID. Without one of these two, the version gets no tag.
- The text of the release is the section of the version in the `CHANGELOG.md` at that commit. Without a section, the text is one line with a link to npm. This is the rule of `scripts/release/tags.ts` of the template.
- Each release gets `--latest=false`, so an old version does not become the latest release. A version with a hyphen gets `--prerelease`.
- `--since <YYYY-MM-DD>` sets the start date. The default is 14 days before today, in UTC. An older date also works. `--dry-run` wins over `--write`.
- npm data decides the window first, so a package with no version in the window starts no `gh` process. Each repository gets one read of its tags. The output gives the count of `gh` processes.
- `--only`, `--public-only`, `--show-private`, `--json` and `--out <file>` work as in the other commands. The output gives each private name only as a hash.

## Release lag

A change on the default branch helps a user only after a release. The command `lag` finds each change with no release.

```sh
node packages/release-train/src/bin.ts lag
node packages/release-train/src/bin.ts lag --public-only --gate --out lag.json
```

The command makes no write. It reports these items:

| Item | Limit | Meaning |
|---|---|---|
| A kept version | 2 days | The source differs from the latest version, and the version number on the default branch is the same. No release starts. |
| A missing release | 2 days | The default branch has a new version, and npm does not have it. |
| A red train pull request | 1 day | An open pull request of the train has a failed check. |

The `files` list of the package tells which changes count. The source of a package that lists a build folder also counts. A list with a wildcard, or no list, gives a read of the file names only. A commit of the type `docs` or `style` does not start the clock. The run reads the commits of the folder of the package, so a busy repository does not hide the first change.

- The published commit comes from npm: the provenance of the version, or its `gitHead`. A package with neither goes to the list "Not read".
- A file counts when its name is in the package. Tests, texts, sites and the settings of tools do not count. The command reads names only, so a file that the package does not publish can count.
- A `package.json` counts when a field that a user gets changes, as `dependencies` or `exports`. A change of `devDependencies` or `scripts` does not count.
- The age of a red pull request starts at its first block. A merge closes a train pull request, so a new head does not reset this age.
- The age starts at the first commit after the release that changes such a file. The command reads at most 60 commits of each package. Then the age shows "over".
- A row under its limit is in the report too, so a kept version shows on its first day.
- `--gate` gives the exit code 1 when a row is over its limit with no hold. The workflow `lag.yml` uses this option once each day, so a lag makes the workflow red.
- `--public-only`, `--json` and `--out <file>` work as in the other commands. Without `--public-only`, the output has private names. So a run without it stays on a local computer.

### Holds

A release can wait on purpose. Without a hold, the gate then stays red, and a new package over the limit gives no new signal. The file `lag-holds.json` lists each hold.

```json
{ "holds": [{ "package": "@scope/name", "reason": "Why the release waits.", "ruling": "https://example.com/decision", "until": "2026-11-07" }] }
```

- `lag --holds <file>` reads the list. A held row does not fail the gate. It keeps its days in the report, and it reads as held, not as passed.
- `until` is the last day of the hold in UTC. The date is at most 14 days after the run.
- A hold with no reason, no `https` link or no date gives a fault, and so does a date in the past. A fault fails the gate, and that hold holds nothing.
- A hold with no row over the limit is in the report. It gives no fault.
- A later date needs a new reason. `holds --holds <file> --before <file>` examines this, and the workflow `lag-holds.yml` starts it on each pull request.
- A hold with the field `repo` names a dependent repository. While it stands, `apply --holds <file>` sends no update of that package to that repository, and each package that must move with it stays too. An open pull request of the train that has only held packages does not merge. The same package goes to each other repository.
- A hold with `repo` says nothing about the release of the package, so it holds no row of the gate. A held update has no row, and the report lists the hold apart. A hold with a fault holds nothing, so its update goes, and the gate fails on the fault.
- `lag-flip.ts` is the flip test. In one job, a new package over the limit fails while another is held. A date in the past fails, and a held row alone passes. The workflows `lag.yml` and `lag-holds.yml` start it.
- `--from-report <file>` reads a saved report in place of the repositories, and `--now <time>` sets the time of the run. The flip test uses both.

## The gate of a move

A package can move to another repository with its npm name. The command `move-check` examines the release after the move against the last release before it.

```sh
node packages/release-train/src/bin.ts move-check --package @scope/name --from 0.1.8 --to 0.1.9 --repo owner/new-home
node packages/release-train/src/bin.ts move-check --package @scope/name --from 0.1.8 --to out/name-0.1.9.tgz --repo owner/new-home --json --out move.json
```

The move passes only when each line is true:

- Each file of the tarball has the same bytes, except `package.json`. A changed, added or removed file is a fault.
- In `package.json`, only `version`, `repository`, `gitHead`, `homepage` and `bugs` change. The command compares the values, not the order of the keys.
- The `repository` of the new `package.json` names `--repo`. The command reads the `owner/name`, `github:`, https, git and ssh forms.
- The SLSA provenance of the new release on npm names `--repo`.

More rules:

- The command downloads each release from npm and examines its `sha512` integrity. A tarball that does not agree stops the command.
- For a trial before the release, `--to` can name a tarball file. The name of the file ends in `.tgz`.
- npm has no provenance of a file. So the report lists that check as not done.
- `--allow-field <field>` and `--allow-file <path>` accept one more change. Use each option once for each name. The report lists each accepted change.
- The report gives the version, the repository, the integrity and the provenance of each side, the files and the faults. `--json` and `--out <file>` give it as JSON.
- The exit code is 0 on a pass, 1 on a fault or an error, and 2 on a missing option.
- The command does not compare the test results. The new repository starts its tests and its API report in its own CI.

## Stage 3: template sync

The template sync keeps the files from the repository `template` current in each other repository. Each rule is data in `SYNC_RULES` (`src/sync.ts`): an id, a reason and a check that gives the edits. To add a rule, add an object to this list.

- `pins`: each `uses: <owner>/template/<path>@<sha>` line in `.github/workflows/` moves to the commit of the pins, with the comment `# main`. The commit of the pins is the oldest first-parent commit of `main` with the surface of the head (at most 30 steps back). Thus a docs commit of the template does not change it, and an open sync pull request gets no new push. While a version is in flight (or changesets wait), `release.yml` keeps its pins. A path that the template does not have stays and goes under "Needs a hand". The pins move only when the surface of a pin changed since its commit. The surface of a shared workflow is its file and the `sparse-checkout` paths of its checkouts of the template. The surface of an action is its folder. Thus a change of the docs of the template moves no pin and starts no CI in each repository. All pins of a repository move together. When the change or the text of a workflow is not known, the pins move. Examples are a compare of 300 files or more, and a checkout with no `sparse-checkout`.
- `release-scripts`: when `release.yml` uses `reusable-release-build.yml` at a template commit that contains template#50, the rule deletes `scripts/release/`. When a workflow or a script of `package.json` still refers to `scripts/release`, the folder stays and the rule asks for a hand.
- `template-cli`: when the script `package` starts the copy `packages/cli/`, the rule deletes the copy. It sets the scripts `package` and `template` to the published CLI, and adds the dev dependency `@<owner>/template-cli`. The package manager updates the lockfile, as for an update. The copy stays when its package is not private, or when another file still uses it.
- `coverage`: this rule is for a pnpm repository. A workspace package (or the root) can have a test script that starts Vitest. When that package and the root have no `@vitest/coverage-v8`, the rule adds it to the root dev dependencies. It uses the range of `vitest`. The action `coverage` of the template finds it there. The package manager updates the lockfile. When the packages name different ranges of `vitest`, the rule changes nothing and asks for a hand. It does the same when the range is not a version range (for example `catalog:`).
- `callers`: a `release.yml` that does not use `reusable-release-build.yml`, or a `ci.yml` that does not use `reusable-ci.yml`, goes under "Needs a hand". This rule changes nothing.

The rules do not change the repository `template`. Each repository gets one branch `release-train/template` and one pull request with the label `release-train`, apart from the update pull request. The body tells each change and its reason, the changes that wait, and the problems that need a hand. The fingerprint in the body stops a push when the changes are the same. CI, the label `release-train:blocked`, the merge on green and the close follow the rules of the update pull request.

GitHub refuses a change to a workflow file from an App without the permission Workflows: write. Until the App has this permission, the rules `pins` and `release-scripts` wait, and the pull request and the summary tell "The change waits for the Workflows permission of the App." The other rules work. The run does not fail.

- `--no-sync` turns off the template sync.
- `--workflows auto|yes|no` tells if the App can change workflow files. With `auto` (the default), the train tries, and when GitHub refuses the push, it pushes again without the workflow changes.
- `plan` lists the sync actions of each repository and the count for each rule.

## The train workflow

`train.yml` starts every 30 minutes, on a manual start and on the `released` event of `repository_dispatch`. It makes a token of the GitHub App `mark1russell7-release-train` with `actions/create-github-app-token`. Pull requests with that token start CI in the repositories.

- Only `git clone`, `git fetch` and `git push` get the token of the App. The package managers, the scripts of the repositories and the other git commands get no token.
- The train removes each variable with `TOKEN`, `SECRET` or `_KEY` in its name from the environment of each command. It also removes the settings `RELEASE_TRAIN_*`.
- A manual start has the inputs `dry-run` (default true), `only`, `cascade` and `urgent`. Give only public names to `only`, `cascade` and `urgent`, because GitHub shows the inputs.
- The schedule and `repository_dispatch` change repositories only when `LIVE` in `train.yml` is `"true"`. It is `"true"` since 2026-10-25. Set it to `"false"` to stop the train.
- The log, the step summary and the artifact `apply` give each private repository only as a count or a hash. The run also masks each private name in the log.
- The hash uses the secret `RELEASE_TRAIN_HASH_KEY`, a separate random key. In Actions, the run stops when the key is empty. It also stops on a PEM private key.
- After `apply`, the step "Wait for a release" waits up to 15 minutes for a version in flight.
- `CASCADE` in `train.yml` gives the value of `--cascade`.
- The run starts release workflows only when `RELEASE_DISPATCH` in `train.yml` is `"true"`.
- The run does the template sync only when `SYNC` in `train.yml` is `"true"` (the default). The step "Check the Workflows permission of the App" asks for a token with the permission Workflows: write, and gives `--workflows yes` or `--workflows no` to `apply`.
