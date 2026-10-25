# release-train

The release train reads the npm packages of the GitHub account `mark1russell7`. It makes the dependency graph of these packages and a plan of the next releases and updates.

Stage 1 only reads. Stage 2 (`apply`) opens a pull request for each update of the current wave. The train does not publish to npm itself: the release workflow of each repository publishes.

## What it reads

- The repositories of the account. It skips archived repositories and forks.
- The root `package.json` of each repository, and each workspace package of `pnpm-workspace.yaml`.
- `pnpm-lock.yaml` or `package-lock.json`, for the resolved versions.
- The `latest` version of each package on the npm registry.

A package is a `package.json` with a name and without `"private": true`. An edge is a dependency on a package of the account.

## The actions of the plan

| Action | When |
|---|---|
| `new-package` | The package is not on npm. Only the owner can make a new package. |
| `release` | The version on `main` is newer than npm, or a dependency range of the package changes. |
| `adopt-in-range` | The range lets the newest version in, but the lockfile holds an older version. A lockfile update is sufficient. |
| `adopt-breaking` | The newest version is outside the range. The range must change. |

Each repository gets one combined action of each kind. The plan puts the actions in a topological sequence and shows each cycle.

## Use

```sh
GH_TOKEN=$(gh auth token) pnpm --filter @release-train/release-train plan
node packages/release-train/src/bin.ts plan --json
node packages/release-train/src/bin.ts plan --write-db <folder>
```

- `--public-only` removes each private repository from the output.
- `--out <file>` writes the full plan as JSON.
- `--no-progress` does not read the pull requests and the release runs.

## CI

`plan.yml` computes the plan every 6 hours and on a manual start. It keeps `plan.json` as a workflow artifact. It uses the default token, so it sees only public repositories.

## Stage 2: apply

`apply` makes the plan again from the real state, then changes the repositories. It keeps no state between runs.

- It applies only the `adopt-in-range` and `adopt-breaking` actions of the current wave. Such an action waits for no other action, and npm has each target version.
- Each repository gets one branch `release-train/update` and one combined pull request. A next run updates that branch and does not open a second pull request.
- A breaking adoption changes the range to a caret range of the new version (`^x.y.z`).
- The lockfile comes from the package manager of the repository. For pnpm, the train sets each range to the exact target version and starts `pnpm install --lockfile-only`. Then it sets each range to its final value (the old range, or the new caret range) and starts the install again, and a check with `--frozen-lockfile` must pass. For npm, it uses `npm install` and `npm update` with `--package-lock-only`. The train does not write a lockfile itself.
- The train does not use `pnpm update`, because it also updates the dependencies of each package. A dependency with a `github:` specifier and no commit gets the newest commit when pnpm resolves the lockfile. The pull request body lists such changes under "Other lockfile changes".
- pnpm 11 and later refuse a version that is younger than `minimumReleaseAge` (1 day by default, from `pnpm-workspace.yaml` or `.npmrc`). The train leaves out such a version and adds it in a later run. When each version of a repository is too young, the repository waits, and the train closes its open pull request with a mark. The train opens again a pull request that it closed itself, but not one that a person closed.
- The train updates the packages of the owner (`@<owner>/*` and `@procedures/*`), so their new versions must not wait. The train puts these two scopes into `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` and removes each entry that they cover (for example `@<owner>/name@1.0.2`). The wait stays for all other packages. A repository that uses pnpm 11 or later and has no `pnpm-workspace.yaml` gets a new file with only this setting. The change goes into the combined pull request. A repository with no update gets a pull request with only this change.
- The body of the pull request tells each change, the reason, and each other lockfile change. It has the label `release-train`.
- The train turns on GitHub auto-merge. When GitHub cannot merge on green (for example, the branch has no protection), the train merges a green pull request in a later run.
- When CI fails, the pull request stays open with the label `release-train:blocked`.
- The train closes its pull request when the plan has no update for the repository.
- The train does not open a pull request again when a person closed one with the same changes.

```sh
GH_TOKEN=<token> node packages/release-train/src/bin.ts apply --dry-run
node packages/release-train/src/bin.ts apply --only <repo> --report apply.json
```

- `--dry-run` shows the pull requests and changes nothing.
- `--only <repo>` changes only the given repositories (comma-separated).
- `--report <file>` writes the report without private names.
- `--author "Name <email>"` sets the author of the commits.
- `--show-private` shows the private names in the output. Do not use it in CI.
- `--cascade <repos>` sets the repositories (comma-separated) whose breaking adoptions carry a release, or `all` (the default). The adoptions of other repositories with a release wait.
- `--release-dispatch` starts the release workflows that start only by hand. Refer to "Releases".

## Releases

When a dependency gets a new version outside the range of a dependent (a new major version, or a new minor version before `1.0.0`), the range of the dependent changes. The dependent must then have a new release too, else its users do not get the change. The train puts this release into the same pull request as the range change.

- The release type comes from the public types of the dependent. The train reads the typed files (`.d.ts` and TypeScript sources) of the version of the dependent on npm.
- When these files name the changed dependency (for example `from "@scope/dep"`), the types of the dependency can reach the users, so the change breaks the API. A change of a peer range also breaks the API. When npm gives no typed files, the case is not clear, so the change counts as a break of the API.
- When the files do not name the dependency, the release is a patch.
- A break of the API gives MINOR before `1.0.0` and MAJOR after.
- A repository with changesets (`.changeset/config.json`) gets the changeset file `.changeset/release-train-cascade.md`. Another repository gets the new version in `package.json`.
- The body of the pull request has a table "Releases" with each package, its version, the release type and the reason.
- A private repository gets the pull request, but its packages are not published.
- When the release of the dependent is blocked, its range change waits too.

After the merge, the release workflow of the repository publishes the new version with OIDC. Some release workflows start only by hand (for example with changesets: one start makes the version pull request, and one start after its merge publishes). With `--release-dispatch`, the train merges a green version pull request (branch `changeset-release/main`) and starts such a workflow when CI on `main` is green. This needs the permission Actions: write of the GitHub App.

The report of `apply` lists the versions in flight: the public versions on `main` that npm does not have. The command `await-release --report <file> --minutes <n>` checks npm every 30 seconds. When npm has one of these versions, it sends the `released` event to the train, and the next wave starts at once.

When CI of a train pull request fails, the pull request gets the label `release-train:blocked`. `plan --write-db` then writes an alert into the collection `alerts` of the tracker. The strategist tells the role that owns the repository.

## The train workflow

`train.yml` starts every 30 minutes, on a manual start and on the `released` event of `repository_dispatch`. It makes a token of the GitHub App `mark1russell7-release-train` with `actions/create-github-app-token`. Pull requests with that token start CI in the repositories.

- A manual start has the inputs `dry-run` (default true), `only` and `cascade`. Give only public names to `only` and `cascade`, because GitHub shows the inputs.
- The schedule and `repository_dispatch` change repositories only when `LIVE` in `train.yml` is `"true"`. It is `"true"` since 2026-10-25. Set it to `"false"` to stop the train.
- The log, the step summary and the artifact `apply` give each private repository only as a count or a hash. The run also masks each private name in the log.
- After `apply`, the step "Wait for a release" waits up to 15 minutes for a version in flight.
- `CASCADE` in `train.yml` gives the value of `--cascade`.
- The run starts release workflows only when `RELEASE_DISPATCH` in `train.yml` is `"true"`.
