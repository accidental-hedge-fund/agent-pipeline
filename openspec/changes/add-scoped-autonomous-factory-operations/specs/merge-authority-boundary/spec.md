## MODIFIED Requirements

### Requirement: Public product positioning SHALL state autonomous-through-ready-to-deploy with operator-owned merge

Operator-facing product docs (at minimum the repository `README.md` front-door summary and the host skill entry summaries under `hosts/*/SKILL.md`) SHALL describe Agent Pipeline as autonomous from issue intake through a green, current, mergeable `pipeline:ready-to-deploy` result. They SHALL state that ordinary merging requires explicit session-bound operator authority. They MAY also document a disabled-by-default external factory profile in which one authenticated, immutable, expiring operator grant delegates the exact merges and release actions named by that grant. They SHALL NOT imply that the ordinary advance path merges or deploys, or that repository configuration can enable unattended merge.

#### Scenario: README front door names the default boundary

- **WHEN** a reader opens the repository `README.md` product summary
- **THEN** it SHALL state that the ordinary advance path ends at ready-to-deploy and does not merge
- **AND** it SHALL NOT claim there is no operator merge capability while documenting `pipeline merge` or `merge-queue --apply`

#### Scenario: README distinguishes the scoped factory

- **WHEN** the README describes a Hermes or other external factory supervisor
- **THEN** it SHALL state that the profile is opt-in and disabled by default
- **AND** it SHALL state that one authenticated grant limits the repository, base, release, issue order, actions, and expiry
- **AND** it SHALL NOT present that deployment profile as an `auto_merge` setting or ordinary advance behavior

#### Scenario: Host skills do not over-claim advance autonomy

- **WHEN** `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` entry descriptions and policy sections are read
- **THEN** they SHALL keep merge and deployment out of the advance loop
- **AND** any documented scoped delegate SHALL remain a separate operator-authorized surface

### Requirement: Golden-rule conventions SHALL state no-autonomous-merge with operator carve-out

CLAUDE.md golden rule 4 and the AGENTS.md twin SHALL state that the advance loop stops at `pipeline:ready-to-deploy` and never merges. Merging happens only through loop-isolated commands: direct operator invocation (`pipeline merge` per pull request; `merge-queue --apply` batch with dry-run default) or a disabled-by-default deployment wrapper that validates an authenticated, immutable, expiring operator grant before it invokes the same permitted surface. No `auto_merge` config key or merge stage SHALL be added. The scoped factory exception SHALL remain evidence-gated, exact-scope, and external to ordinary Pipeline configuration and stage dispatch.

#### Scenario: CLAUDE.md and AGENTS.md agree

- **WHEN** CLAUDE.md golden rule 4 and AGENTS.md golden rule 4 are compared
- **THEN** both SHALL express advance-loop isolation and the same direct-operator and scoped-delegate authority surfaces
- **AND** neither SHALL imply that `pipeline advance` can merge

#### Scenario: Golden rule forbids auto_merge config

- **WHEN** the golden-rule text is read
- **THEN** it SHALL forbid an `auto_merge` config key and a merge stage
- **AND** it SHALL state that a deployment grant is not repository configuration

### Requirement: Operator skill copy SHALL name merge and merge-queue --apply as explicit, non-advance surfaces

Host skill documentation that lists merge-related commands SHALL present `pipeline merge` (or `/pipeline:merge`) and `pipeline merge-queue` with `--apply` as explicit authority surfaces that are never called by the advance loop. Merge-queue documentation SHALL keep dry-run as the default. If a host skill documents a scoped factory delegate, it SHALL state that a deployment wrapper validates the operator grant before command invocation and that `pipeline merge` itself does not validate Buzz or deployment grants.

#### Scenario: Skill lists both direct operator merge surfaces

- **WHEN** the host skill command list and policy text are inspected
- **THEN** they SHALL name per-PR merge and merge-queue apply as explicit non-advance surfaces
- **AND** they SHALL state that the advance loop never invokes them

#### Scenario: Scoped delegate validation is not attributed to merge

- **WHEN** a host skill describes Hermes invoking `pipeline merge`
- **THEN** it SHALL assign grant validation to the deployment wrapper
- **AND** it SHALL preserve every existing `pipeline merge` gate

#### Scenario: Dry-run default remains explicit

- **WHEN** merge-queue is described without `--apply`
- **THEN** docs SHALL state that the default is dry-run or plan-only with no merges
