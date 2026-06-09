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
