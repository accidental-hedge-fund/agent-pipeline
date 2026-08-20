## MODIFIED Requirements

### Requirement: FRG evidence SHALL be attachable to the release PR

A completed FRG run SHALL produce evidence that can be linked or embedded on the release pull
request for the same version: at minimum the `run_id` and a pass/fail summary (and preferably the
artifact path or JSON digest). The attachment SHALL be a PR comment or a section of the release PR
body. When `.agent-pipeline/frg/` is gitignored, that attachment SHALL NOT be a `git add` of that
tree, including `git add -f`. On-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` remains the durable
local record. Absence of any linkable FRG evidence for the version SHALL leave the release FRG
precondition unsatisfied even if a private local pass is claimed without a durable record.

#### Scenario: Pass summary is linkable

- **WHEN** a live FRG for version `X.Y.Z` passes
- **THEN** the evidence SHALL include a `run_id` and `pass: true` suitable for pasting or automated
  posting onto the release PR for `X.Y.Z`

#### Scenario: Unrecorded local claim does not satisfy attachment

- **WHEN** an operator asserts FRG success without a durable evidence artifact containing `run_id`
  and `pass: true` for the version
- **THEN** the FRG attachment requirement SHALL be unsatisfied

#### Scenario: Gitignored FRG is not attached by git add

- **WHEN** `.agent-pipeline/frg/` is gitignored
- **AND** `pipeline release` prepares a release PR after an FRG pass for `1.39.5`
- **THEN** the release PR body or an attached comment SHALL include the FRG `run_id` and pass summary
- **AND** the staging `git add` SHALL NOT include `.agent-pipeline/frg` or any path under it

### Requirement: FRG runtime files SHALL NOT dirty the factory control checkout

`.agent-pipeline/frg/` (including `<X.Y.Z>/latest.json` and the rest of that tree) SHALL
be treated as an engine-written runtime artifact on the factory control checkout. A pack
or promote write of `latest.json` SHALL NOT fail the next train's `worktree-clean` check.
The FRG runbook SHALL NOT require that directory to stay unignored on the protected
checkout. Host-only `skip-worktree` SHALL NOT be the product fix.

Local `latest.json` SHALL remain the ship-host lookup for `pipeline release`,
`pipeline engine-promote`, and `pipeline release ensure-tag` on the host that just packed.
Release-eligible evidence SHALL NOT need to be committed, comment-attached, or
`git add -f`'d so auto-tag can see it. `pipeline release` SHALL NOT `git add` that
gitignored tree in order to open a release PR. Auto-tag SHALL NOT block the ship when that
path is gitignored. Local `release ensure-tag` SHALL create `vX.Y.Z` from on-disk HMAC
evidence. That posture SHALL NOT require leaving `.agent-pipeline/frg/` unignored on the
factory control checkout.

#### Scenario: Pack write does not fail the next train worktree-clean

- **WHEN** Tugboat or `pipeline factory-release prepare` writes
  `.agent-pipeline/frg/1.39.3/latest.json` on the factory control checkout
- **AND** that file is not committed
- **THEN** the next `pipeline train` / `pipeline doctor` `worktree-clean` check SHALL
  pass
- **AND** SHALL NOT fail solely because `latest.json` exists as an untracked file

#### Scenario: Runbook no longer requires unignored FRG on the protected checkout

- **WHEN** an operator reads the FRG runbook evidence-path section after this change
- **THEN** it SHALL state that `.agent-pipeline/frg/` is gitignored on the factory
  control checkout
- **AND** SHALL NOT require operators to commit leftover `latest.json` onto the
  protected checkout to keep the next train clean

#### Scenario: Auto-tag evidence remains attachable

- **WHEN** a release PR for version `1.39.3` is prepared after an FRG pack
- **THEN** release-eligible evidence for `1.39.3` MAY still be attachable
- **AND** that attachment SHALL NOT be required for auto-tag or for local `release ensure-tag`
- **AND** SHALL NOT require the factory control checkout to keep `.agent-pipeline/frg/`
  unignored

#### Scenario: Auto-tag does not require attached tree evidence when FRG is gitignored

- **WHEN** a release PR for version `1.39.5` is merged after an FRG pack
- **AND** `.agent-pipeline/frg/` is gitignored
- **AND** on-disk HMAC `latest.json` is release-eligible
- **THEN** ship-end SHALL create `v1.39.5` via `release ensure-tag` from disk
- **AND** auto-tag SHALL NOT fail the job because the merged tree has no `latest.json`
- **AND** the factory control checkout SHALL keep `.agent-pipeline/frg/` gitignored

#### Scenario: Release prepare does not git add gitignored FRG

- **WHEN** `.agent-pipeline/frg/` is gitignored
- **AND** on-disk HMAC `latest.json` for `1.39.5` is release-eligible
- **AND** `pipeline release 1.39.5 --no-edit` runs
- **THEN** it SHALL NOT pass `.agent-pipeline/frg` to `git add`
- **AND** it SHALL still require that on-disk `latest.json` (`pass: true`, HMAC)
- **AND** `--skip-frg` SHALL NOT be the path
