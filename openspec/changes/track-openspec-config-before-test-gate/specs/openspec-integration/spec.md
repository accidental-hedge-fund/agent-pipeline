## ADDED Requirements

### Requirement: OpenSpec planning SHALL commit the project config it creates

OpenSpec planning SHALL leave the worktree free of untracked OpenSpec project config before
implementation and the test gate. When the OpenSpec flow authors a change in an already-initialized
repo, the `openspec` CLI may create or update the project config file `openspec/config.yaml` as a
side effect (its `ensureDefaultConfig` writes the file when absent; `openspec new change` and
`openspec validate` trigger this). After the authoring harness runs and after any OpenSpec-scoped
salvage, the planning stage SHALL commit `openspec/config.yaml` if it exists in the worktree as an
untracked or modified file. The commit SHALL stage only `openspec/config.yaml` (no path outside
`openspec/`), SHALL carry the `Issue:` and `Pipeline-Run:` traceability trailers, and SHALL occur
before the authoring path-constraint verification so the committed config is part of the verified
commit range and satisfies the `allowPattern: /^openspec\//` guard. When `openspec/config.yaml` is
already tracked and unmodified, the step SHALL be a no-op — it SHALL NOT create an empty commit and
SHALL NOT error. This step SHALL NOT alter the `openspec.bootstrap` path, which already commits
`config.yaml` via `openspec init` + `git add -A`.

#### Scenario: CLI created config.yaml untracked while the harness committed the change

- **WHEN** the OpenSpec flow is active on an already-initialized repo
- **AND** the authoring harness committed its change under `openspec/changes/<id>/`
- **AND** the `openspec` CLI left `openspec/config.yaml` untracked in the worktree
- **THEN** the planning stage SHALL stage and commit `openspec/config.yaml`
- **AND** after planning completes `git status --porcelain` SHALL report no untracked or modified
  `openspec/config.yaml`
- **AND** the implementation/test-gate phase SHALL NOT see `openspec/config.yaml` as a dirty path

#### Scenario: config-commit is scoped and trailered

- **WHEN** the planning stage commits a leftover `openspec/config.yaml`
- **THEN** the commit diff SHALL contain only `openspec/config.yaml` (no path outside `openspec/`)
- **AND** the commit message SHALL end with `Issue: #<n>` and `Pipeline-Run: <id>` trailers
- **AND** `verifyHarnessCommits` with the authoring `allowPattern: /^openspec\//` SHALL return ok
  for the range that includes this commit

#### Scenario: config.yaml already tracked — no extra commit

- **WHEN** the OpenSpec flow is active
- **AND** `openspec/config.yaml` is already tracked and unmodified after authoring (or the harness
  itself committed it)
- **THEN** the planning stage SHALL create no additional commit for `openspec/config.yaml`
- **AND** the stage SHALL NOT error and SHALL proceed to the path-constraint verification as before

#### Scenario: bootstrap path unchanged

- **WHEN** the OpenSpec flow is active on a repo with no `openspec/` workspace and
  `openspec.bootstrap` is `true`
- **THEN** the bootstrap step SHALL run `openspec init` and commit the new workspace — including
  `openspec/config.yaml` — via `git add -A` in the `chore: openspec init` commit, exactly as today
- **AND** the new config-commit step SHALL be a no-op in this case because `config.yaml` is already
  committed by the bootstrap

#### Scenario: config-commit step is injectable for unit testing

- **WHEN** the config-commit step runs with fake `gitStatus`, `gitAdd`, and `gitCommit` seams
- **AND** the fake `gitStatus` reports `openspec/config.yaml` as untracked
- **THEN** the test SHALL verify `gitAdd` is called with a pathspec restricted to
  `openspec/config.yaml` and `gitCommit` is called with a trailered message
- **AND** when the fake `gitStatus` reports no change for `openspec/config.yaml`, the test SHALL
  verify neither `gitAdd` nor `gitCommit` is called
