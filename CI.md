# Shared CI workflows

The template holds the CI, the release and the Pages workflows of the repositories of mark1russell7. Each repository keeps short caller workflows. The callers use the shared workflows from GitHub, so a change in the template gets to each repository.

| File | Type | What it does |
|---|---|---|
| `.github/workflows/reusable-ci.yml` | Workflow | Installs with pnpm and starts the standard scripts of `package.json`. |
| `.github/workflows/reusable-release-build.yml` | Workflow | Builds and packs the published packages, and writes the plan of the tags. |
| `.github/actions/npm-publish` | Action | Publishes the tarballs to npm with trusted publishing (OIDC) and provenance. |
| `.github/workflows/reusable-release-tag.yml` | Workflow | Makes a git tag and a GitHub release for each published version. |
| `.github/workflows/reusable-pages.yml` | Workflow | Builds a site, adds the Releases page and the Status page, and deploys it to GitHub Pages. |
| `.github/workflows/reusable-security.yml` | Workflow | Scans the dependencies and the code with the dependency review, osv-scanner and CodeQL. |

## CI

The job of `reusable-ci.yml` installs the dependencies with pnpm. The version of pnpm comes from `packageManager` in `package.json`. Then the job starts each script of the list that `package.json` has. It skips the other scripts. Thus most repositories need no inputs:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
```

The job starts all the scripts, also after a failure. Then it fails with the names of the failed scripts. The summary of the run shows a table of the scripts.

| Input | Default | What it sets |
|---|---|---|
| `scripts` | `format:check typecheck lint test build lint:ste` | The scripts, in sequence. |
| `recursive-scripts` | `build` | The scripts that run in each package when the root `package.json` does not have them. |
| `node-versions` | `["26"]` | The Node.js versions of the matrix, as JSON. |
| `os` | `["ubuntu-latest"]` | The runners of the matrix, as JSON. |
| `setup` | (empty) | A command after the install, before the scripts. |
| `run` | (empty) | A command after the scripts. |
| `env` | `{}` | The environment variables of the job, as a JSON object. |
| `working-directory` | `.` | The folder of `package.json`. |
| `fetch-depth` | `1` | The commits of the checkout. `0` gets the whole history. |
| `timeout-minutes` | `15` | The time limit of each job of the matrix. |

A repository with more checks adds its own jobs next to the job `ci`. An example with inputs:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
    with:
      scripts: build test typecheck
      node-versions: '["22", "24"]'
      os: '["ubuntu-latest", "windows-latest", "macos-latest"]'
      run: npm pack --dry-run
```

## Release

The `release.yml` of a repository keeps four jobs:

1. `verify` uses the `ci.yml` of the repository.
2. `build` uses `reusable-release-build.yml`.
3. `publish` is a job of `release.yml`. Its one step is the action `npm-publish`.
4. `tag` uses `reusable-release-tag.yml`.

```yaml
  publish:
    name: Publish to npm
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      id-token: write
    outputs:
      published: ${{ steps.publish.outputs.published }}
    steps:
      - id: publish
        uses: mark1russell7/template/.github/actions/npm-publish@<commit> # main
```

### Why the publish job stays in `release.yml`

The trusted publisher of each package on npm names the repository and the workflow file `release.yml`. A change to a trusted publisher needs the 2FA of the owner.

- npm compares the trusted publisher with the calling workflow, not with the shared workflow that holds `npm publish` ([npm docs, trusted publishers](https://docs.npmjs.com/trusted-publishers)).
- The npm docs do not tell how npm accepts a shared workflow of a different repository. The question is open ([npm/documentation#1755](https://github.com/npm/documentation/issues/1755)).
- A composite action operates in the job that uses it. Thus the OIDC token and the provenance statement stay the same as before.

Thus the job that holds `id-token: write` stays in `release.yml`, and only its steps are shared. The other jobs need no OIDC token. They are shared workflows.

### The security of the release

- `release.yml` starts with `permissions: {}`. Each job gets only the permissions that it needs.
- The jobs `build` and `verify` run the code of the repository with `contents: read` only.
- The first step of the job `build` stops the run when the commit is not on `main`. Thus a manual run on a different branch publishes nothing (`RELEASING.md`).
- The job `publish` holds `id-token: write`. It does no checkout and no install. It starts only the pinned action.
- The job `tag` holds `contents: write`, from its caller job. It starts no code of the repository.
- Renovate does not change `release.yml`. The release session moves its pins (`RELEASING.md`).

### Inputs of the release

Most repositories need no inputs. A repository with more release steps uses these inputs. Each default keeps the standard release.

| Workflow or action | Input | Default | What it sets |
|---|---|---|---|
| `reusable-release-build.yml` | `require-main` | `true` | The check that the commit is on `main`. Only `actions-test.yml` sets `false`. |
| `reusable-release-build.yml` | `node-version` | `26` | The Node.js version of the build. |
| `reusable-release-build.yml` | `node-version-file` | (empty) | A file with the Node.js version, for example `.nvmrc`. It replaces `node-version`. |
| `reusable-release-build.yml` | `build` | (empty) | The build command. Empty starts the `build` script. |
| `reusable-release-build.yml` | `after-pack` | (empty) | A command after `pack.mjs` and `tags.mjs`, before the upload of the artifacts. |
| `npm-publish` | `new-packages` | `error` | `warning`: a package that is not on npm gives a warning, and the step does not fail. |
| `npm-publish` | `node-version` | `26` | The Node.js version of npm. |
| `reusable-release-tag.yml` | `published` | (empty) | The versions that the job `publish` published. |

The command `after-pack` operates in the build job, with `contents: read` only:

- `RELEASE_DIR` is the folder of `packages.txt` and the tarballs. `TAGS_FILE` is the plan of the tags.
- The command can test the tarballs, add files to the artifact `release`, and change the plan.
- Each line `name=value` that it writes to `GITHUB_OUTPUT` goes into the output `after-pack` of the workflow. This output is a JSON object.
- A later job reads a value with `fromJSON(needs.build.outputs.after-pack).<name>`.

Each entry of the plan of the tags has `name`, `version`, `tag`, `prerelease` and `notes`. The job `tag` also reads three optional fields:

- `title`: the title of the GitHub release. The default is the tag.
- `tarballs`: an array of package names. The release gets the tarball of each package as a file.
- `latest`: `true` makes the release of this entry the latest release of the repository (`--latest`). The other releases of the run get `--latest=false`.

At most one entry sets `latest`. A prerelease does not become the latest release. When no entry sets `latest`, the job gives no `--latest` flag, the same as before.

The `tags.mjs` of the template does not write these fields. The `tags.mjs` of a repository can write them. The command `after-pack` can also add them.

### More jobs in `release.yml`

A step that needs `id-token: write` stays in `release.yml`, for example a publish to the MCP registry. It does not go into a shared workflow:

- Put it in a job after the job `publish`, with only the permissions that it needs.
- The job does no checkout and no install. It reads its files from the artifact `release`.
- The output `published` of the job `publish` and the output `after-pack` of the job `build` tell the job when to operate.

## Pages

`reusable-pages.yml` has two jobs. The job `build` installs, builds the site, adds the pages of `site-pages` and uploads the Pages artifact. It gets only read permissions. The job `deploy` deploys the artifact. It starts no code of the repository.

```yaml
on:
  push:
    branches: [main]
  schedule:
    - cron: "17 */3 * * *"
  workflow_dispatch:

permissions: {}

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  pages:
    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@<commit> # main
    permissions:
      contents: read
      actions: read
      issues: read
      pull-requests: read
      checks: read
      statuses: read
      pages: write
      id-token: write
    with:
      build: pnpm --filter @crawler/site run build
      out: packages/site/dist
      env: '{"SITE_BASE": "/${{ github.event.repository.name }}", "ASTRO_TELEMETRY_DISABLED": "1"}'
      roadmap: docs/ROADMAP.md
      packages: polite-crawler,polite-crawler-mcp
```

- A caller on `workflow_run` after CI is also correct. A failed CI run or a CI run of a pull request builds nothing.
- A scheduled build uses the commit of `green-main`. The input `pending` goes to that action.
- The inputs of `site-pages` go to the action: `site-pages-version`, `roadmap`, `base`, `packages`, `changesets`, `group`, `css`, `site-name` and `data-only`.
- `site-pages: false` builds the site without the Releases page and the Status page.
- `deploy: false` builds and uploads the artifact, with no deploy.
- `github-token: true` gives the build `GITHUB_TOKEN`, with the read permissions of the build job.
- The workflow gets the actions of the same template commit as the workflow file. A second checkout gets them.

## Security

`reusable-security.yml` has three jobs. On a pull request, a job fails only for a new finding at or above `fail-on-severity`. On a push, a schedule or a manual run, the jobs upload their findings to code scanning. Then they do not fail. Thus the Security tab shows the old findings, and the old findings do not block a pull request.

| Job | On a pull request | On a push, a schedule or a manual run |
|---|---|---|
| `dependency-review` | GitHub compares the dependencies of the base and of the pull request. The job fails for a new dependency with a known vulnerability. | The job does not start. |
| `osv-scanner` | The job scans the lockfiles of the base and of the pull request. It fails for a vulnerability that only the pull request has. | The job scans all the lockfiles and uploads the results. |
| `codeql` | CodeQL analyzes the source with no build. The job fails for an alert on a line that the pull request adds or changes. | CodeQL analyzes the source and uploads the results. |

The caller job gives the permissions. The workflow gives each job only the permissions that it needs:

```yaml
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "23 5 * * 1"
  workflow_dispatch:

permissions: {}

concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: true

jobs:
  security:
    uses: mark1russell7/template/.github/workflows/reusable-security.yml@<commit> # main
    permissions:
      contents: read
      security-events: write
      actions: read
```

| Input | Default | What it sets |
|---|---|---|
| `fail-on-severity` | `high` | A pull request fails for a new finding at or above this severity: `low`, `moderate`, `high` or `critical`. |
| `dependency-review` | `true` | The job `dependency-review`. |
| `dependency-review-scopes` | `runtime, development, unknown` | The scopes of the dependencies that the dependency review examines. |
| `osv` | `true` | The job `osv-scanner`. |
| `osv-lockfile` | (empty) | The lockfiles of osv-scanner, separated by spaces. Empty scans each lockfile of the repository. |
| `codeql` | `true` | The job `codeql`. |
| `codeql-languages` | `javascript-typescript,actions` | The CodeQL languages. The job skips a language with no files in the repository. |
| `codeql-build-mode` | `none` | The CodeQL build mode. |
| `timeout-minutes` | `30` | The time limit of the jobs `osv-scanner` and `codeql`. |

- The job `dependency-review` gets `contents: read`. The jobs `osv-scanner` and `codeql` also get `security-events: write` for the upload and `actions: read`.
- No job installs or starts the code of the repository.
- The severity of a finding is its CVSS score or its CodeQL `security-severity`. `high` is 7.0 or more, and `critical` is 9.0 or more.
- A file `osv-scanner.toml` next to a lockfile tells osv-scanner which vulnerabilities to ignore.
- A repository with the default setup of code scanning sets `codeql: false`, because the default setup refuses the results of a CodeQL workflow.
- CodeQL in a private repository needs GitHub Advanced Security. Thus only the public repositories use this workflow.

## Pins and Renovate

A repository pins each shared workflow and action to a commit of `main`:

```yaml
uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<full commit SHA> # main
```

- Renovate reads the comment `# main` and moves the pin to the newest commit of `main` (the preset of `renovate/`). The manager `github-actions` does this since Renovate 43.84.0.
- These updates come in one group, "template workflows and actions", with no wait. Renovate merges them when CI passes.
- The group comes on Monday before 06:00 (New York time). A workflow change during a release makes the tag job fail with HTTP 403 (`RELEASING.md`).
- Renovate does not change `release.yml`. The release session moves the pins of `release.yml` with `scripts/release/bump-pins.mjs` (`RELEASING.md`).
- Renovate also moves `CLAUDE_CODE_VERSION` of `reusable-ai-review.yml` to the newest version on npm. A person reviews and merges that pull request.

## The template and new repositories

The workflows of the template call the shared workflows and actions by a local path, for example `./.github/workflows/reusable-ci.yml`. Thus each pull request of the template tests them:

- `ci.yml` tests `reusable-ci.yml`.
- `security.yml` tests `reusable-security.yml`.
- `actions-test.yml` tests the actions, `reusable-pages.yml` and the release workflows, with `dry-run`. It publishes nothing. On a pull request, it sets the input `require-main` of the release build to `false`.

The job `publish` of `release.yml` uses the pinned form of `npm-publish`, also in the template. A local action needs a checkout, and that job does no checkout.

`new-repo.ps1` does not copy the shared workflows, the actions or `actions-test.yml`. It changes each local path and each pin of the template to the pinned form, with the commit of the template that it copies.
