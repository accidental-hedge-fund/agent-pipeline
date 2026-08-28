## ADDED Requirements

### Requirement: recover-parked SHALL recover a pre-PR engine park without requiring a linked open PR first

The `recover-parked` command SHALL run deterministic recover for a parked issue **before** requiring a linked open PR or a readable PR HEAD. When a publishable unpublished stage commit is present (see `unpublished-stage-commit-publish`), that deterministic recover SHALL include `publish_unpublished_stage_commit`. When publication succeeds, the command SHALL treat the park as `deterministic-cleared` or `recovered`, SHALL NOT consume the senior fingerprint budget, and MAY re-enter same-issue advance at `review-1`. When the park is a pre-PR engine-defect (stage `planning`, `plan-review`, or `implementing` with no publishable commit, blocker kind `harness-failure` or equivalent workflow-engine-defect / environment-auth) the command SHALL skip residual-review senior reflow, SHALL NOT fail-closed with `no linked open PR; keep park`, and SHALL re-enter same-issue advance so the stage can retry. Residual-review senior reflow (override / extra fix against live findings) SHALL still require a live PR HEAD and SHALL still refuse HIGH, CRITICAL, security, and human-authority auto-override.

#### Scenario: Unpublished salvage park publishes instead of fail-closed

- **WHEN** the issue is parked at `implementing` with `blocked`
- **AND** no linked open PR exists
- **AND** a publishable unpublished stage commit is present on the retained managed worktree
- **THEN** `recover-parked` SHALL claim `publish_unpublished_stage_commit`
- **AND** SHALL NOT exit `fail-closed` with `no linked open PR; keep park`
- **AND** on successful publish SHALL report `deterministic-cleared` or `recovered`

#### Scenario: Plan-review engine-defect without a PR re-enters

- **WHEN** the issue is parked at `plan-review` with an engine-defect or environment-auth block
- **AND** no linked open PR exists
- **AND** no publishable unpublished stage commit exists
- **THEN** `recover-parked` SHALL NOT exit `fail-closed` with `no linked open PR; keep park`
- **AND** SHALL skip residual-review senior reflow
- **AND** SHALL re-enter same-issue advance at the current pre-PR stage

#### Scenario: Residual-review park without a PR still fail-closes after deterministic recover

- **WHEN** the park is a residual-review park at a post-PR stage (review-1, fix, pre-merge, or equivalent)
- **AND** deterministic recover including publish does not apply or does not clear the park
- **AND** no linked open PR or readable PR HEAD exists
- **THEN** `recover-parked` SHALL keep the park
- **AND** SHALL NOT apply supervisor overrides
- **AND** MAY report `fail-closed` because residual-review reflow cannot run without PR HEAD

#### Scenario: Dry-run does not publish a branch or create a PR

- **WHEN** `recover-parked` runs with `--dry-run`
- **AND** a publishable unpublished stage commit is present
- **THEN** the command SHALL NOT invoke the publish executor
- **AND** SHALL NOT push, create a PR, clear `blocked`, or re-enter advance
- **AND** SHALL report a non-mutating classification or preview

#### Scenario: Failed publication keeps the park for a later retry

- **WHEN** `recover-parked` claims `publish_unpublished_stage_commit`
- **AND** push or PR creation fails
- **THEN** the command SHALL keep the park and its publication-failure evidence
- **AND** SHALL NOT clear `blocked`
- **AND** SHALL NOT re-enter advance solely because no linked open PR exists yet

#### Scenario: Missing or unknown blocker kind does not auto-re-enter a pre-PR park

- **WHEN** the issue is parked at a pre-PR stage with `blocked`
- **AND** no linked open PR exists
- **AND** no publishable unpublished stage commit exists
- **AND** the blocker kind is absent, malformed, or not an explicit engine-defect / environment-auth class
- **THEN** `recover-parked` SHALL keep the park
- **AND** SHALL NOT clear `blocked` or re-enter advance as a pre-PR engine-defect park

## MODIFIED Requirements

### Requirement: Deterministic engine recover SHALL run before any supervisor override or extra fix

Before spending the supervisor fingerprint budget, applying any override, or starting an extra implementer fix round, `recover-parked` SHALL attempt existing deterministic recover applicable to the park evidence, including at least:

- engine-scratch / workflow-engine-defect scratch unlink recover when scratch-only porcelain or scratch residual evidence is present
- stale-blocked re-review / clear when leftover `blocked` is stale because PR HEAD moved past the blocking reviewed-sha under existing supersession rules
- `publish_unpublished_stage_commit` when a publishable unpublished stage commit is present (see `unpublished-stage-commit-publish`)

Deterministic recover, including publish of an unpublished stage commit, SHALL run **before** the command requires a linked open PR. When deterministic recover clears the park, the command SHALL exit successfully without recording supervisor overrides and without consuming the one-pass supervisor fingerprint budget. When remaining work is residual-review senior reflow and the linked open PR or PR HEAD cannot be read, the command SHALL fail closed, keep the park, and SHALL NOT override. Missing PR alone SHALL NOT fail-close a pre-PR park that still has a deterministic publish or re-entry recipe.

#### Scenario: Scratch or stale-SHA park clears without override

- **WHEN** the park is solely engine-scratch residual or stale blocked after HEAD movement that deterministic recover can clear
- **THEN** `recover-parked` SHALL run that deterministic path
- **AND** SHALL NOT record a supervisor override for residual review keys solely to clear the park
- **AND** SHALL NOT mark the supervisor fingerprint as spent for a senior pass that did not run

#### Scenario: Unreadable HEAD fails closed

- **WHEN** remaining work is residual-review senior reflow
- **AND** the linked open PR or PR HEAD cannot be read during recover-parked
- **AND** deterministic recover including publish did not already clear the park
- **THEN** the command SHALL keep the park
- **AND** SHALL NOT apply overrides

#### Scenario: Unpublished commit publishes before PR lookup fail-closed

- **WHEN** no linked open PR exists
- **AND** a publishable unpublished stage commit is present
- **THEN** `recover-parked` SHALL run `publish_unpublished_stage_commit` before any fail-closed on missing PR
- **AND** SHALL NOT consume the senior fingerprint budget when that publish clears the park
