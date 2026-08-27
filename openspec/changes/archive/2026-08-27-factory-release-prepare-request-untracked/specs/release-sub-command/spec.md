## ADDED Requirements

### Requirement: Factory-release prepare SHALL reject a request path inside the target checkout

`pipeline factory-release prepare` SHALL reject a `--request` path that
resolves inside the target checkout before it dispatches or resumes a pack
loop. The target checkout is the repository directory being prepared
(`repoDir`) and, when distinct, the factory control checkout. Resolves
inside SHALL include the checkout root, any descendant path, and a symlink
whose target is inside that checkout. A gitignored descendant SHALL still
be rejected. Relative `--request` paths remain rejected as today.

The command SHALL exit non-zero with a named defect that identifies the
request path, the checkout root, and an off-repo remediation
(`$TMPDIR`, `AGENT_PIPELINE_STATE_HOME`, or the Tugboat `$RUN_DIR`). It
SHALL NOT start a bound pack loop on that tick. It SHALL NOT treat
gitignore of `request-*.json`, host-only `skip-worktree`, or doctor
scratch-classifying that file as the product fix.

An absolute `--request` path that resolves outside every target checkout
SHALL NOT fail this location gate.

#### Scenario: In-checkout request is refused before dispatch

- **WHEN** the operator runs `pipeline factory-release prepare --request <path> --json`
- **AND** `<path>` resolves to `$REPO_DIR/.agent-pipeline/request-1.39.13.json`
- **AND** `$REPO_DIR` is the repository being prepared
- **THEN** the command SHALL exit non-zero before pack-loop dispatch
- **AND** the error SHALL name the request path and the checkout root
- **AND** the error SHALL name an off-repo placement (`$TMPDIR`, state dir, or Tugboat `$RUN_DIR`)
- **AND** it SHALL NOT start or resume a pack loop on that tick

#### Scenario: Gitignored descendant is still refused

- **WHEN** `--request` resolves to `$REPO_DIR/.agent-pipeline/frg/request.json`
- **AND** that path is gitignored
- **THEN** the command SHALL still reject the path as inside the target checkout
- **AND** it SHALL NOT accept the path because the file would not appear in porcelain

#### Scenario: Symlink into the checkout is refused

- **WHEN** `--request` is an absolute path outside the checkout
- **AND** that path is a symlink whose target is inside the target checkout
- **THEN** the command SHALL reject the path as inside the target checkout

#### Scenario: Off-repo request is not rejected for location

- **WHEN** `--request` is an absolute path under `$TMPDIR` or `AGENT_PIPELINE_STATE_HOME`
- **AND** the resolved path is not inside the target checkout
- **THEN** the location gate SHALL NOT reject the request
- **AND** later request-schema and pack-loop rules SHALL still apply

#### Scenario: Accepting an in-checkout request is the defect the test bites

- **WHEN** a unit test invokes prepare with a request path inside the target checkout
- **AND** prepare accepts that path and proceeds toward pack-loop dispatch
- **THEN** the test SHALL fail
- **AND** the next identical in-checkout `--request` SHALL fail the same test
- **AND** it SHALL NOT require a new mole issue

### Requirement: Factory-release prepare dispatch SHALL NOT dirty the protected target checkout with its own artifacts

`pipeline factory-release prepare` SHALL NOT leave the request file or
prepare-written checkpoint / binding files as untracked porcelain on the
protected branch of the target checkout at pack-loop dispatch. Prepare-written
runtime files under `.agent-pipeline/factory-release/` SHALL be covered by
the engine artifact ignore contract. FRG evidence under `.agent-pipeline/frg/`
SHALL remain gitignored per that contract. Host-only `skip-worktree` SHALL
NOT be the product fix.

#### Scenario: Off-repo request dispatch leaves protected checkout clean of prepare artifacts

- **WHEN** prepare runs with `--request` outside the target checkout
- **AND** it persists checkpoint or loop-binding files and returns `status: "in_progress"`
- **THEN** `git status --porcelain` on the protected target checkout SHALL NOT list the request file as untracked
- **AND** it SHALL NOT list prepare checkpoint or binding files as untracked
- **AND** doctor `worktree-clean` SHALL NOT fail solely because those prepare files exist

#### Scenario: Prepare-owned dirt is the defect the test bites

- **WHEN** a unit test inspects prepare dispatch artifacts against the target checkout
- **AND** prepare would leave an unignored untracked file of its own on that checkout
- **THEN** the test SHALL fail
