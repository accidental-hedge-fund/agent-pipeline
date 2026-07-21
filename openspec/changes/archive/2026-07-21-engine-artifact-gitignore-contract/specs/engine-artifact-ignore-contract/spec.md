## ADDED Requirements

### Requirement: The engine SHALL declare every engine-written `.agent-pipeline/` artifact directory in one exported contract

The engine SHALL expose a single exported, ordered contract enumerating every directory under
`.agent-pipeline/` that the engine itself writes at runtime. Each entry SHALL carry the
repo-relative ignore path (directory form, trailing `/`) and a human-readable comment
describing what the directory holds. The contract SHALL include `.agent-pipeline/runs/`,
`.agent-pipeline/roadmap/`, and `.agent-pipeline/history/`. This contract is the single
source of truth: no other module SHALL independently define an `.agent-pipeline/` artifact
directory path.

#### Scenario: Contract enumerates the three current artifact directories

- **WHEN** the exported artifact contract is read
- **THEN** it SHALL contain entries whose ignore paths are exactly `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`, and `.agent-pipeline/history/`
- **AND** each entry SHALL carry a non-empty descriptive comment

#### Scenario: Directory helpers derive from the contract

- **WHEN** `runsDir(repoDir)`, `issueHistoryDir(repoDir)`, and the roadmap artifact directory helper are called
- **THEN** each SHALL resolve to `<repoDir>/.agent-pipeline/<name>` where `<name>` comes from the corresponding contract entry
- **AND** no such helper SHALL contain an independently hard-coded `.agent-pipeline/<name>` string literal

---

### Requirement: The engine SHALL render a sentinel-delimited managed ignore block from the contract

The engine SHALL provide a pure renderer that turns the artifact contract into a
`.gitignore` block delimited by fixed opening and closing sentinel comment lines that name
`agent-pipeline` and the managing command. The block SHALL contain one ignore path per
contract entry, each preceded by that entry's comment, in contract order. The renderer SHALL
be deterministic: the same contract SHALL always produce byte-identical text.

#### Scenario: Rendered block lists every contract entry

- **WHEN** the managed ignore block is rendered from the artifact contract
- **THEN** the output SHALL begin with the opening sentinel line and end with the closing sentinel line
- **AND** it SHALL contain each contract entry's ignore path on its own line, in contract order
- **AND** it SHALL contain each entry's comment

#### Scenario: Rendering is deterministic

- **WHEN** the managed ignore block is rendered twice from the same contract
- **THEN** both outputs SHALL be byte-identical

---

### Requirement: The engine SHALL ensure the managed ignore block in a repository's root `.gitignore` without clobbering operator lines

The engine SHALL provide an idempotent `ensureArtifactIgnoreBlock` operation that takes a
repository directory and injectable file read/write dependencies, and returns whether the
block was created, updated, or left unchanged. When the repository has no root `.gitignore`,
the operation SHALL create one containing only the managed block. When a `.gitignore` exists
without the block, the operation SHALL append the block and SHALL preserve every pre-existing
byte. When the block is present, the operation SHALL replace only the span between the
sentinels. When the existing block already equals the rendered contract, the operation SHALL
perform no write and report `unchanged`. Lines outside the sentinels SHALL never be removed,
reordered, or rewritten.

#### Scenario: No `.gitignore` present

- **WHEN** `ensureArtifactIgnoreBlock` runs in a repository with no root `.gitignore`
- **THEN** a root `.gitignore` SHALL be written containing the rendered managed block
- **AND** the operation SHALL report `created`

#### Scenario: Existing `.gitignore` without the managed block

- **WHEN** `ensureArtifactIgnoreBlock` runs against a `.gitignore` containing operator-authored entries and no sentinels
- **THEN** the managed block SHALL be appended
- **AND** every pre-existing line SHALL remain byte-identical and in its original order
- **AND** the operation SHALL report `updated`

#### Scenario: Managed block refreshed after the contract gains an entry

- **WHEN** the contract gains a new artifact directory and `ensureArtifactIgnoreBlock` runs against a `.gitignore` whose managed block predates it
- **THEN** only the span between the sentinels SHALL be rewritten to list the new entry
- **AND** the block SHALL NOT be duplicated
- **AND** content before the opening sentinel and after the closing sentinel SHALL remain byte-identical

#### Scenario: Managed block already current

- **WHEN** `ensureArtifactIgnoreBlock` runs against a `.gitignore` whose managed block already equals the rendered contract
- **THEN** no write SHALL be performed
- **AND** the operation SHALL report `unchanged`

#### Scenario: Operator already ignores a contract path by hand

- **WHEN** a `.gitignore` contains an operator-authored `.agent-pipeline/runs/` line outside the sentinels and `ensureArtifactIgnoreBlock` runs
- **THEN** the operator's line SHALL be left in place unmodified
- **AND** the managed block SHALL still list `.agent-pipeline/runs/`

---

### Requirement: A drift guard SHALL fail when an engine-written artifact directory has no ignore entry

The test suite SHALL include a drift guard asserting that every directory under
`.agent-pipeline/` that the engine writes has a corresponding entry in the artifact contract,
and that the rendered managed block contains each contract entry's ignore path. Adding a new
engine-written artifact directory without adding its contract entry SHALL fail this test.

#### Scenario: New artifact directory added without a contract entry

- **WHEN** an engine-written `.agent-pipeline/` artifact directory exists with no matching contract entry
- **THEN** the drift-guard test SHALL fail and name the missing ignore entry

#### Scenario: History directory is covered

- **WHEN** the drift guard runs against the current engine
- **THEN** it SHALL confirm `.agent-pipeline/history/` is present in both the contract and the rendered managed block

---

### Requirement: This repository's `.gitignore` SHALL ignore the engine's history artifacts

This repository's root `.gitignore` SHALL ignore `.agent-pipeline/history/` so that engine
runs on its own checkout leave the protected branch clean and `pipeline doctor` passes its
`worktree-clean` check.

#### Scenario: Doctor passes with history files present

- **WHEN** the engine has written `.agent-pipeline/history/issue-<N>.jsonl` files on the protected branch of this repository
- **THEN** `git status --porcelain` SHALL report no untracked `.agent-pipeline/` paths
- **AND** `pipeline doctor` SHALL report the `worktree-clean` check as passing

---

### Requirement: Documentation SHALL list the full set of ignored artifact paths

Documentation SHALL list every contract entry wherever it enumerates the engine's ignored
`.agent-pipeline/` artifact paths, including `README.md` and each host `SKILL.md` variant. No
document SHALL list a strict subset of the contract.

#### Scenario: Docs enumerate all three paths

- **WHEN** a reader consults `README.md` or a host `SKILL.md` for the engine's local-only artifact paths
- **THEN** the listed paths SHALL include `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`, and `.agent-pipeline/history/`
