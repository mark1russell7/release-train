# The roadmap of release-train

This file gives the items of the release train and their status. The Status page of the site reads the table. `README.md` tells how each stage works.

## The items

| ID | Item | Status | Links |
| --- | --- | --- | --- |
| RT1 | Stage 1: a read-only graph of the packages and a plan of the next releases | Done | `f7c99d0` |
| RT2 | Stage 2: `apply` opens one update pull request for each repository of the current wave | Done | #2 |
| RT3 | The live train: `train.yml` starts on a schedule | Done | #4 |
| RT4 | Cascade releases in the update pull request | Done | #10, #11 |
| RT5 | Stage 3: the template sync keeps the files from the template current | Done | #13 |
| RT6 | The sync pushes wait for the shared runners | Done | #44 |
| RT7 | The train moves a repository only to a version that its own `release.yml` built | Done | #49 |
| RT8 | The site: the README, the Releases page and the Status page on GitHub Pages | Done | #74 |
| RT9 | The site: a plan explorer that runs the planner of the library in the browser | Done | #79 |
| RT10 | The update pushes obey the limit of pushes, and an urgent update passes it | Done | #93 |
| RT11 | An urgent package passes the age rule with its exact version | Done | #95 |
| RT12 | The tag backfill: a published version with no tag gets its release from a local run | Done | #97 |
| RT13 | A run sends the ready items of a repository, and only the other items wait | Done | #98 |
| RT14 | The first API report builds each package when the root has no script `build`, and a failure keeps its reason | Done | #101 |
| RT15 | A run takes the urgent names of each run that it replaced, so an urgent dispatch is not lost | Done | #102 |
| RT16 | The command `lag` reports each change with no release and each red train pull request, and a daily workflow holds the limits | Done | #104 |
| RT17 | The command `lag` reads the `files` list of a package, and a `docs` or `style` commit does not start its clock | Done | #105 |
