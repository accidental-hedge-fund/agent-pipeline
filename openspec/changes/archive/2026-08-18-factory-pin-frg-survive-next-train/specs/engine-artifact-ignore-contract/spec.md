## MODIFIED Requirements

### Requirement: The engine SHALL declare every engine-written `.agent-pipeline/` artifact directory in one exported contract

The engine SHALL expose a single exported, ordered contract enumerating every directory under
`.agent-pipeline/` that the engine itself writes at runtime. Each entry SHALL carry the
repo-relative ignore path (directory form, trailing `/`) and a human-readable comment
describing what the directory holds. The contract SHALL include `.agent-pipeline/runs/`,
`.agent-pipeline/roadmap/`, `.agent-pipeline/history/`, and `.agent-pipeline/frg/`. This
contract is the single source of truth: no other module SHALL independently define an
`.agent-pipeline/` artifact directory path.

#### Scenario: Contract enumerates the three current artifact directories

- **WHEN** the exported artifact contract is read
- **THEN** it SHALL contain entries whose ignore paths include `.agent-pipeline/runs/`,
  `.agent-pipeline/roadmap/`, `.agent-pipeline/history/`, and `.agent-pipeline/frg/`
- **AND** each entry SHALL carry a non-empty descriptive comment

#### Scenario: Directory helpers derive from the contract

- **WHEN** `runsDir(repoDir)`, `issueHistoryDir(repoDir)`, and the roadmap artifact directory helper are called
- **THEN** each SHALL resolve to `<repoDir>/.agent-pipeline/<name>` where `<name>` comes from the corresponding contract entry
- **AND** no such helper SHALL contain an independently hard-coded `.agent-pipeline/<name>` string literal

### Requirement: Documentation SHALL list the full set of ignored artifact paths

Documentation SHALL list every contract entry wherever it enumerates the engine's ignored
`.agent-pipeline/` artifact paths, including `README.md` and each host `SKILL.md` variant. No
document SHALL list a strict subset of the contract.

#### Scenario: Docs enumerate all three paths

- **WHEN** a reader consults `README.md` or a host `SKILL.md` for the engine's local-only artifact paths
- **THEN** the listed paths SHALL include `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`,
  `.agent-pipeline/history/`, and `.agent-pipeline/frg/`

## ADDED Requirements

### Requirement: This repository's `.gitignore` SHALL ignore FRG artifacts

This repository's root `.gitignore` SHALL ignore `.agent-pipeline/frg/` so that a Factory
Reliability Gate (FRG) pack or promote write of `latest.json` (and the rest of that tree)
on the factory control checkout leaves the protected branch clean. `pipeline doctor`
SHALL pass its `worktree-clean` check while those files exist uncommitted. Host-only
`git update-index --skip-worktree` SHALL NOT be the product fix.

#### Scenario: Doctor passes with uncommitted latest.json present

- **WHEN** the engine has written `.agent-pipeline/frg/<X.Y.Z>/latest.json` on the
  protected branch of this repository
- **AND** that file is not staged or committed
- **THEN** `git status --porcelain` SHALL report no untracked `.agent-pipeline/frg/` paths
- **AND** `pipeline doctor` SHALL report the `worktree-clean` check as passing

#### Scenario: Skip-worktree is not the product fix

- **WHEN** the ignore contract and this repository's `.gitignore` are inspected
- **THEN** `.agent-pipeline/frg/` SHALL appear as an ignore path
- **AND** the product fix SHALL NOT be a host-only `skip-worktree` bit on `latest.json`

#### Scenario: Drift guard covers the FRG directory

- **WHEN** the drift guard runs against the current engine
- **THEN** it SHALL confirm `.agent-pipeline/frg/` is present in both the contract and
  the rendered managed block
