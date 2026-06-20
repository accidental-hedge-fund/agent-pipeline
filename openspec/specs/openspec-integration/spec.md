# openspec-integration Specification

## Purpose
The opt-in OpenSpec flow: auto-detect a repo's `openspec/` workspace, plan spec-first (author a change — proposal, tasks, spec deltas — instead of a freeform plan), validate it structurally, and at finalize archive the change into the living specs. The integration must leave the freeform (non-OpenSpec) path unchanged on repos that don't use it. (Propagation of spec deltas into the planning/implement/fix/review prompts is refined by `openspec-context-propagation`; the standalone `init` command is `init-command`.)
## Requirements
### Requirement: Activation is auto-detected and overridable
Whether the OpenSpec flow runs SHALL be governed by `cfg.openspec.enabled` (`auto` | `on` | `off`): `on` always active, `off` never, `auto` active only when an `openspec/` workspace exists (`isInitialized`). `shouldPlanWithOpenspec` and `isActive` encode this.

#### Scenario: auto with a workspace
- **WHEN** `openspec.enabled` is `auto` and the repo has an `openspec/` directory
- **THEN** the OpenSpec flow SHALL be active

#### Scenario: auto without a workspace
- **WHEN** `openspec.enabled` is `auto` and the repo has no `openspec/` directory
- **THEN** the OpenSpec flow SHALL be inactive and planning SHALL use the freeform path unchanged

#### Scenario: forced off
- **WHEN** `openspec.enabled` is `off`
- **THEN** the OpenSpec flow SHALL never activate regardless of an `openspec/` directory

### Requirement: Spec-first planning authors a change
When the OpenSpec flow is active, planning SHALL author an OpenSpec change (a `proposal.md`, `tasks.md`, and spec deltas under `openspec/changes/<id>/`) rather than a freeform plan, and commit those intent artifacts.

#### Scenario: change authored
- **WHEN** planning runs with the OpenSpec flow active
- **THEN** an `openspec/changes/<id>/` directory SHALL be created with proposal/tasks/spec-delta artifacts and committed

### Requirement: Structural validation gates the change
The change SHALL be validated with `openspec validate` at draft and again after revision; a validation failure SHALL block rather than advance.

#### Scenario: invalid change blocks
- **WHEN** the authored or revised change fails `openspec validate`
- **THEN** the stage SHALL block rather than proceed to implementation

### Requirement: Archive into living specs at finalize
At pre-merge the change SHALL be archived (`openspec archive`) — folding its spec deltas into `openspec/specs/` and moving the change under `openspec/changes/archive/` — and `openspec validate --all` SHALL pass before the item reaches `ready-to-deploy`.

#### Scenario: archive on finalize
- **WHEN** an OpenSpec-active item reaches pre-merge
- **THEN** its change SHALL be archived into the living specs and `openspec validate --all` SHALL pass before advancing

### Requirement: Bootstrap is opt-in
When the flow is active on a repo lacking an `openspec/` workspace, planning SHALL run `openspec init` only if `cfg.openspec.bootstrap` is `true`; otherwise it SHALL block with an actionable message rather than silently proceeding.

#### Scenario: bootstrap enabled
- **WHEN** the flow is active, the repo has no `openspec/`, and `openspec.bootstrap` is `true`
- **THEN** planning SHALL run `openspec init` and commit the new workspace

#### Scenario: missing workspace without bootstrap
- **WHEN** `openspec.enabled` is `on`, the repo has no `openspec/`, and `bootstrap` is `false`
- **THEN** the stage SHALL block with guidance to enable bootstrap or run `openspec init`

### Requirement: Archive step is idempotent across polling iterations

The pre-merge archive step SHALL compute the current active OpenSpec candidates from the branch diff before consulting commit history. If no active change directories remain in the diff, the archive step SHALL be skipped and the gate SHALL proceed to the next check without pushing a new commit or returning `waiting`. If active candidates exist, the gate SHALL invoke `openspec archive` regardless of whether a prior archive commit is found in the branch history.

#### Scenario: no active candidates — step skipped

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** the branch diff contains no active change directories (either already archived and removed, or none ever existed)
- **THEN** the gate SHALL skip `openspec archive` entirely
- **AND** SHALL NOT push a new archive commit
- **AND** SHALL return `null` (continue to the next pre-merge check)

#### Scenario: prior archive commit exists but active candidates remain — re-archive

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** the branch diff contains one or more active change directories
- **AND** a prior archive commit for this issue exists in the branch history (e.g., a revert re-introduced a change)
- **THEN** the gate SHALL invoke `openspec archive` for each active candidate
- **AND** SHALL NOT skip based on the prior archive commit alone

#### Scenario: no prior archive commit — archive proceeds normally

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** no archive commit for this issue exists in the branch commit history
- **AND** active change directories are found in the diff
- **THEN** the gate SHALL invoke `openspec archive` for each active change as before

### Requirement: Archive commit failure blocks pre-merge and prevents push

After `openspec archive` succeeds and `git add -A` stages a non-empty diff, the pre-merge stage SHALL check whether `git commit` exits zero. If the commit exits non-zero, the stage SHALL call `setBlocked` with the commit stderr as the blocking reason and SHALL return `{ status: "blocked" }` without invoking `git push`. The push MUST NOT be attempted when the archive commit fails.

#### Scenario: commit fails after archive produces diff

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `openspec archive` succeeds for all active candidates
- **AND** `git status --porcelain` reports a non-empty diff (staged files)
- **AND** `git commit` exits non-zero (e.g., rejected by a pre-commit hook or git config error)
- **THEN** the stage SHALL set a pre-merge blocker on the issue with the commit stderr included in the reason
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "archive commit failed" }` (or equivalent)
- **AND** SHALL NOT invoke `git push origin <branch>`

#### Scenario: worktree has dirty state outside openspec/ before archive

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `git status --porcelain` (run before `openspec archive`) reports dirty files outside `openspec/` paths
- **THEN** the stage SHALL set a pre-merge blocker on the issue
- **AND** SHALL return `{ advanced: false, status: "blocked" }` without invoking `openspec archive`

#### Scenario: commit succeeds — push proceeds normally

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `openspec archive` succeeds and a non-empty diff is staged
- **AND** `git commit` exits zero
- **THEN** the stage SHALL proceed to `git push origin <branch>` as before
- **AND** the existing push-failure and waiting paths SHALL remain unchanged

