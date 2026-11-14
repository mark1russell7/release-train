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
- Before a merge, the train compares the branch with the default branch. Under the strict rule, a branch that is behind gets a new build from the default branch, with a new install, and CI runs again. A merge of two lockfile changes can give a lockfile with no entry for a version, with no git conflict. The candidate rules build a branch again only when the default branch changed a file of its surface. Refer to "The candidate rules".
- A branch can change a file in `.github/workflows/`. Then it does not merge while a run of the release workflow on the default branch is queued, waits or is in progress. The run tags the commit of its version, and GitHub refuses that tag (HTTP 403) when a merge changed a workflow file before it. The train merges in a later run, after the release.
- A repository publishes when its default branch has `.github/workflows/release.yml`. In such a repository, a merge needs a passed release check on the head commit. The check is a check run `release-check`, or `<job> / release-check` of a caller of `reusable-ci.yml` of the template. The check starts the release build on the commit of the pull request. Thus a merge cannot stop the release of the default branch. An example: an update changes a shipped file, and its version is already on npm. A skipped check passes only in a private repository, where `reusable-ci.yml` runs it only with the input `release-check-private`. When GitHub does not tell if the repository publishes, the merge waits. The held cause is `release-check`.
- When CI fails, the pull request stays open with the label `release-train:blocked`. In the mode `one-candidate`, the label `release-train:retry` gives one new build.
- A pull request of another author with the label `train-merge` (for example a Renovate pin of a workflow action) merges by the same rules. A merge by Renovate or by the auto-merge of GitHub does not wait for a release run, so the train merges these pull requests. It takes only a branch of the same repository into the default branch, and it does not delete the branch. A Renovate branch that is behind gets a tick in its rebase box, so Renovate rebases it and CI runs again. This step comes after the releases of the run.
- A green branch of the same repository can be behind, with no conflict and no rebase box. The train merges the default branch into it (the update-branch API), and CI starts again. That merge counts as a push in the limit of the run. It takes its turn by the time of the last push of the head, in one order with the pushes. Only a conflict gets a line for the author.
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
- The update pushes, the sync pushes and the merges into labeled pull requests are in one queue. The key of each item is the start of its wait, and the oldest key goes first.
- The key of an open pull request is the time of its last push. That time is the committer date of the head commit, because each push of the train makes a new commit. A label or a comment does not change that time. A pushed pull request goes to the end.
- A repository with no open sync pull request waits from the date of the template commit that it needs.
- An update with no pull request waits from the start of its need. That is the npm publish time of the first version above the version in the lockfile. A need with no publish time waits from the first run that saw it (see "The state of the train").
- An item that another action waits for gets the oldest key of the open pull requests of those actions, direct or indirect. Each item of an update waits for no action, so the pace cannot put a later wave first.
- Items with the same key take the order of a rotation, which moves one place every 30 minutes.
- An urgent update goes before each other item, and it does not count in the limit.
- Each run pushes a prefix of this order. An item with place Q at its arrival goes within floor((Q - 1 + M) / L) + 1 runs. M is the count of later items with an older key, and L is the limit. The tests check both rules with fast-check.
- `--max-pushes 0` lets a run only merge or block.

At the default, 35 repositories need 7 runs, approximately 3.5 hours, when the sync takes no pushes. A `released` event adds a run.

### The candidate rules

The candidate rules decide when a train branch gets a push, a merge or a wait. They apply to the update branch `release-train/update` and to the sync branch `release-train/template`. The open pull request of a branch is its candidate. Only one candidate is on each branch at a time.

The problem is a repository whose default branch gets a commit every few minutes. Under the strict rule, each green branch of that repository is behind at the next run. The train builds it again, CI starts again, and the branch does not merge.

The policy is data: `CANDIDATE_POLICY` in `candidate-policy.ts`. The function `decide` gives the decision from the facts. It has no I/O and no clock. It asks only for the fact that its next step needs, so the train reads only that fact.

- R0, the yield: a green candidate waits while the workflows of other branches are in progress or queued. A workflow run that is older than 6 hours does not count. The candidate waits for 24 hours at most from the start of its pull request.
- R1, no preemption: the train does not push while CI of the candidate is in progress. An urgent update is the exception. A workflow run that is older than 6 hours does not count as in progress.
- R2, exact staleness: a green candidate is stale only in two cases. GitHub cannot merge it, or the default branch changed a file of its surface since the merge base. To be behind is not a reason.
- R3, the pace: a new push waits `clamp(cost / rate, 1 h, 24 h)` after the last push of the branch. An urgent update and `--only` pass the pace.
- R4, a red default branch: the head of the default branch is red in the checks of the candidate. Then a green candidate that is behind gets a new build. R3 paces this push.
- R5, a red candidate: the train builds it again only for three reasons. They are a new plan, the label `release-train:retry`, or a moved default branch after the backoff.

The surface of a candidate is the list of the files that it changes. When the candidate changes the lockfile, the surface also has `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.npmrc`. GitHub cuts a list of files at 300 files. A cut list counts as a change, with its own reason in the log. A failed read also counts as a change.

The cost of R3 is the CI minutes of the last candidate. For a public repository, the cost is the runner minutes, at a rate of 5 minutes an hour. For a private repository, the cost is the billed minutes, at a rate of 1 minute an hour. Each job is rounded up, a Windows job counts 2 times and a macOS job counts 10 times. A job of zero length costs 0. The last candidate is the newest pull request of the branch, open or closed, so the train keeps no new state.

The backoff of R5 is `clamp(2^(attempt - 1) h, 1 h, 24 h)` after the last push, and the pace must also permit the push. The label `release-train:retry` gives one new build, and then the train removes the label. A retry label waits for the end of CI.

For R4, the train reads the CI result of the head of the default branch. Only the workflows of the head of the candidate count. A workflow that runs only on the default branch, for example a release workflow, does not count.

A red head gives a new build of the candidate on the default branch, and not a wait. So a candidate that has the fix of the default branch gets one new build and then merges. R3 paces the push, and R5 holds a red result, so the cost has a limit. A head that is pending or green goes on to the merge.

A commit with no CI result is "no read" in the log, and it does not count as green. An empty set of workflows of the candidate, or a failed read, also gives "no read". The train reads these facts only for a green candidate that is behind. The value is for one candidate, because two train branches of a repository can run different workflows.

The field `redMainBound` sets a bound on the red train merges of the last 30 days. At the bound or more, the strict rule comes back for a candidate that is behind. The count uses the same workflows of the candidate. The bound is null, so the rule has no bound, and the train does not read the count.

A change of the plan on a green update candidate merges first when the change is monotone. Monotone: each item of the candidate is in the plan with the same version or a newer version. Else the new plan replaces the candidate, so a held item or a removed item does not merge. A missing or empty items mark is "no read", and "no read" is not monotone. A change of the plan on a green sync candidate replaces it.

The body of each pull request has the mark `<!-- release-train:attempt=N -->`, after the fingerprint mark. The body of an update also has a mark with its items. The number in the mark counts the builds of the same plan that follow a red result. A new plan, or a build after a green result or a result that is not known, starts at 1. A missing or damaged `attempt` mark counts as 1.

The field `mode` of the policy has three values. The default is `one-candidate` with the share 0.25:

- `strict`: the train acts by the strict rule and reads no fact of the candidate rules.
- `shadow`: the train acts by the strict rule. It also reads the facts, logs the decision next to the strict action and counts each pair in the summary. Each decision has a code: a short fixed id of the step that made it, for example `green-behind`, `main-red` or `pace-wait`. The log of a private repository has its hash label and the code, but no reason.
  - Two cases that have the same rule also have different codes. A list of files that GitHub cut gives `surface-list-cut`, and a real change of the surface gives `surface-changed`. A merge of a candidate that is behind with no read of the default branch gives `green-behind-main-no-read`, and a merge with a read gives `green-behind`.
  - The log line of a pair is `<label>: candidate rules (<kind>): strict <action>, candidate <action> by <rule> [<code>]: <reason>.`. The line of a private repository stops after the code.
  - The table of the pairs in the summary has the columns strict rule, candidate rules, rule, code and count. In the report, each row of `candidates.pairs` is `{ today, next, rule, code, count }`.
  - A pair goes into the table only when the candidate rules can decide differently from the strict rule. A merge of the default branch into a candidate starts CI, so it counts as a strict push.
  - A cause outside the rules can hold the strict action first. These causes come from the run: the push limit, busy runners, a young version and an open release run. A missing release check, a skip and an error are causes too. Then the decision goes into a second table, "Held by the run before the rules", with its cause. For a held branch with no candidate, the run reads no fact.
  - The log line of a held branch is `<label>: candidate rules (<kind>): held by <cause> before the rules, candidate <action> by <rule> [<code>]: <reason>.`. The line of a private repository stops after the code. The line of a branch with no fact read stops after `not read`.
- `one-candidate`: the default mode. The train acts on the decision. The field `share` selects a part of the repositories, by a hash of the label of the log. A repository below the share gets this mode. Only this mode makes the label `release-train:retry` and tells it in the body.
  - The default share is 0.25. The repositories above the share stay in the mode `shadow` as the control group. Their log lines and tables do not change.
  - The log line of an applied decision is `<label>: candidate rules (<kind>): acted <action> by <rule> [<code>], result <state>, held by <cause>: <reason>.`. The part `, held by <cause>` is there only when a cause stopped the decision. The line of a private repository stops before the reason.
  - A failed read of the facts gives the line `<label>: candidate rules (<kind>): acted not read, result <state>.`.
  - The record keeps the last decision of the run. After a refused merge, it is the second decision.
  - The causes of this mode are the causes of the mode `shadow`, and also `merge-failed`. `merge-failed`: GitHub refused the merge of a candidate, and no push follows. A dry run gives the result `planned` and no cause.
  - The summary has a third table, "Applied decisions", with the columns decision, rule, code, held by, result and count. An empty value shows as `-`. In the report, each row of `candidates.acted` is `{ action, rule, code, held, state, count }`, sorted by count from high to low.
  - The field `candidates.share` of the report is the share of the policy. The summary line is `Candidate rules (mode <mode>, share <share>): <A> decisions applied, <N> decisions compared, <M> held by the run before the rules, <K> GitHub requests for their facts.`.

The facts cost GitHub requests, all with GET. CI costs 3, mergeable 1, behind 1, surface 1, the runs of other branches 2 and the last push 1 or 2. The cost of the last candidate is 1 request, plus 1 for each of its workflow runs. The default branch costs 2 requests after the CI read: its head commit and the runs of that commit. With a bound, it costs 2 more requests for the closed pull requests, plus 1 for each train merge in the window. The run keeps each response, and the summary gives the count of the requests.

Each result with the state `merged` has the field `mergedBehind` in the report. It is the count of the commits of the default branch that were not in the branch at the merge. Null tells that the train has no read. The strict rule merges only at 0. The field is a count, so the report keeps it for a private repository.

The run also reads `GET /rate_limit` at the start and at the end. The summary and the report give the limit, the used count at the start and at the end, the count left and the reset time. A failed read shows "no read" and does not stop the run.

Some steps still use the strict rule in each mode. They are the open update pull request of a repository that waits for a release, the pull requests with the label `train-merge` and the releases.

### The state of the train

The workflow keeps a state file from one run to the next in the Actions cache (`--state train-state.json`).

- The state has the npm publish times of each package. A run reads the full npm document of a package only when its `modified` time changed. Usually 0 to 3 packages change in 30 minutes, so a run reads 0 to 3 full documents. A run with no state reads all of them once.
- The state has the first run that saw each need with no publish time. The key of such a need is a hash with the secret key, so the state has no private name.
- A missing or broken state does not stop a run. The run writes a note in the log and starts the state again.
- With no state, a need with no publish time waits from the start of the run. The log has a line for each such update, and the summary has their count.

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

When CI of a train pull request fails, the pull request gets the label `release-train:blocked`. `plan --write-db` then writes an alert into the collection `alerts` of the tracker. The maintainer tells the role that owns the repository.

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
| `young` | The version is younger than one hour, and a release run of its commit is not done, so that run can still make the tag. When each release run of the commit is done (for example, GitHub refused its tag), the version does not wait. |
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
- `--state <file>` reads the state of the train at the start of the run and writes it at the end.
- `--workflows auto|yes|no` tells if the App can change workflow files. With `auto` (the default), the train tries, and when GitHub refuses the push, it pushes again without the workflow changes.
- `plan` lists the sync actions of each repository and the count for each rule.

## The version fix

An automated dependency update can change the shipped files of a package and keep a version that npm has. Then the release check of the template fails with "The release skips a version that is on npm". In a repository with Changesets, the changeset check fails. The command `version-fix` adds the missing PATCH (`src/version-fix.ts`).

```sh
node packages/release-train/src/bin.ts version-fix --owner <owner> --author "<name> <email>" --dry-run
```

- The command reads the open pull requests of each repository of the token. It acts only on the Renovate groups `npm-patch`, `npm-minor`, `npm-dev-minor` and `lock-file-maintenance`, and on an update of the train that is not a breaking adoption. A 0.x minor update, a major update, the template sync and a pull request of a person stay as they are.
- It acts only when CI of the head is complete. Each failed check must give the message of the release check or of the changeset check, or only the results of other jobs. When the annotations of a job give only its last line, the command reads the log of the job. Each other error stops the fix.
- A repository with `.changeset/config.json` gets one patch changeset. Another repository gets the PATCH of the version on npm in `package.json`, and a section in `CHANGELOG.md` when the file exists. The `version` script of the package starts, as for a release of the cascade. The command refuses a PATCH that npm has, or a PATCH that is not greater than the `latest` version on npm.
- The fix is one commit of the App on the head branch, pushed with no force. Its message has one trailer line for each package (`Release-Train-Version-Fix:`). A second run reads the trailers in the commits of the pull request and does not raise a version two times. When the head has a new commit, the command does nothing.
- When the train builds its branch again, the update keeps each fix of the head commit. It keeps a version while the default branch has the old version and npm does not have the new one. Thus the next run does not push the branch back without the fix. The body of the pull request shows the fix under "Version fix".
- The command writes one log line for each open pull request. It gives a private repository only as a hash, with no package name and no detail.

## The train workflow

`train.yml` starts every 30 minutes, on a manual start and on the `released` event of `repository_dispatch`. It makes a token of the GitHub App `mark1russell7-release-train` with `actions/create-github-app-token`. Pull requests with that token start CI in the repositories.

- Only `git clone`, `git fetch` and `git push` get the token of the App. The package managers, the scripts of the repositories and the other git commands get no token.
- The train removes each variable with `TOKEN`, `SECRET` or `_KEY` in its name from the environment of each command. It also removes the settings `RELEASE_TRAIN_*`.
- A manual start has the inputs `dry-run` (default true), `only`, `cascade` and `urgent`. Give only public names to `only`, `cascade` and `urgent`, because GitHub shows the inputs.
- The schedule and `repository_dispatch` change repositories only when `LIVE` in `train.yml` is `"true"`. It is `"true"` since 2026-10-25. Set it to `"false"` to stop the train.
- The log, the step summary and the artifact `apply` give each private repository only as a count or a hash. The run also masks each private name in the log.
- The hash uses the secret `RELEASE_TRAIN_HASH_KEY`, a separate random key. In Actions, the run stops when the key is empty. It also stops on a PEM private key.
- After `apply`, the step "Version fix" starts `version-fix` with the same dry-run rule and `only`. A failure of this step does not stop the run.
- After `apply`, the step "Wait for a release" waits up to 15 minutes for a version in flight.
- `CASCADE` in `train.yml` gives the value of `--cascade`.
- The run starts release workflows only when `RELEASE_DISPATCH` in `train.yml` is `"true"`.
- The run does the template sync only when `SYNC` in `train.yml` is `"true"` (the default). The step "Check the Workflows permission of the App" asks for a token with the permission Workflows: write, and gives `--workflows yes` or `--workflows no` to `apply`.
