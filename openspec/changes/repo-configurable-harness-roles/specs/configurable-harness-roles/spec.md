## ADDED Requirements

### Requirement: The config schema SHALL accept a strict `harnesses` role block

`.github/pipeline.yml` SHALL accept an optional strict `harnesses` block with exactly two optional
keys, `implementer` and `reviewer`, each a non-empty string naming a harness. The block SHALL be
strict: any other key inside it SHALL be rejected at validation time with a message naming the
offending key. Omitting the block entirely, or omitting either key within it, SHALL remain valid.

The block SHALL appear in the generated config JSON Schema with a description for each key, and
`pipeline config sync` SHALL scaffold it as documented-inactive commentary without changing the
effective behavior of an existing config.

#### Scenario: Both roles declared

- **WHEN** `.github/pipeline.yml` contains `harnesses:` with `implementer: grok` and `reviewer: codex`
- **THEN** validation SHALL succeed
- **AND** `resolveConfig()` SHALL NOT throw

#### Scenario: Unknown key inside the block is rejected

- **WHEN** `.github/pipeline.yml` contains a `harnesses:` block with a key that is neither
  `implementer` nor `reviewer`
- **THEN** validation SHALL fail with a message naming the offending key
- **AND** no stage SHALL run

#### Scenario: Block absent

- **WHEN** `.github/pipeline.yml` contains no `harnesses:` block
- **THEN** validation SHALL succeed and both roles SHALL resolve exactly as they did before this
  change

#### Scenario: Schema and sync expose the block

- **WHEN** `pipeline config schema` runs
- **THEN** its output SHALL describe the `harnesses` block with a description for `implementer` and for
  `reviewer`
- **AND** `pipeline config sync` on a config already containing the block SHALL preserve that config's
  effective behavior

---

### Requirement: Repository role configuration SHALL override the profile default per role

Role resolution SHALL be per-role: for each of `implementer` and `reviewer`, the value declared in the
repository's `harnesses` block SHALL be used when present, and the active profile's value for that role
SHALL be used when absent. A profile SHALL therefore act as a host/UI default only. Resolution SHALL be
independent of which host invoked the pipeline: the same repository configuration SHALL resolve to the
same pair of roles under every profile.

#### Scenario: Repository config wins over the profile

- **WHEN** the active profile declares implementer `claude` and reviewer `codex`, and the repository
  declares `implementer: grok` and `reviewer: codex`
- **THEN** the resolved implementer SHALL be `grok` and the resolved reviewer SHALL be `codex`

#### Scenario: Resolution is host-independent

- **WHEN** the same repository configuration declaring both roles is resolved under the `claude` profile
  and separately under the `codex` profile
- **THEN** both resolutions SHALL yield the identical implementer and reviewer

#### Scenario: Partial declaration falls back per role

- **WHEN** the repository declares only `implementer` in the `harnesses` block
- **THEN** the resolved implementer SHALL be the declared value
- **AND** the resolved reviewer SHALL be the active profile's reviewer

#### Scenario: No declaration preserves today's behavior

- **WHEN** the repository declares no `harnesses` block and no `review_harness` key
- **THEN** both resolved roles SHALL equal the active profile's roles, with no warning and no change in
  behavior

---

### Requirement: Reviewer-role precedence between `harnesses.reviewer` and `review_harness` SHALL be explicit and non-silent

`review_harness` SHALL remain supported in both its string and structured forms. When only one of
`harnesses.reviewer` and `review_harness` names a reviewer command, that one SHALL resolve the reviewer
role. When both are present and name **different** commands, the configuration SHALL be rejected with a
message naming both keys and both values, rather than silently selecting one. When both are present and
name the **same** command, the configuration SHALL be accepted, and the structured `review_harness`
model, effort, and prompt-delivery settings SHALL continue to apply to the reviewer invocation.

#### Scenario: Conflicting reviewer declarations are rejected

- **WHEN** `harnesses.reviewer` is `codex` and `review_harness.command` is `claude`
- **THEN** configuration resolution SHALL fail with a message naming both keys and both values
- **AND** no stage SHALL run

#### Scenario: Agreeing declarations keep the structured reviewer settings

- **WHEN** `harnesses.reviewer` is `codex` and `review_harness` is
  `{ command: codex, model: gpt-5.6-terra, effort: high }`
- **THEN** the resolved reviewer SHALL be `codex`
- **AND** the resolved reviewer model SHALL be `gpt-5.6-terra` and the resolved reviewer effort SHALL be
  `high`

#### Scenario: review_harness alone still overrides the profile reviewer

- **WHEN** `review_harness: my-reviewer` is set and no `harnesses` block is present
- **THEN** the resolved reviewer SHALL be `my-reviewer`, exactly as before this change

---

### Requirement: Every primary-role execution path SHALL invoke the resolved implementer

Every pipeline execution path whose work is implementation work SHALL invoke the resolved implementer
harness and SHALL NOT name a harness literally. This SHALL cover, at minimum: planning and plan
revision, implementation, each fix round, pre-merge repair, the eval fix round, the visual fix round,
intake spec generation, sweep spec generation, spec refinement, coverage backfill, and roadmap
dependency analysis.

#### Scenario: Implementation paths target the configured implementer

- **WHEN** the repository declares `implementer: grok` and the planning, implementing, fix,
  pre-merge-repair, intake, and sweep paths each run with injected fakes
- **THEN** each invocation SHALL target the `grok` harness

#### Scenario: No primary path names a harness literally

- **WHEN** a primary-role path constructs a harness invocation
- **THEN** the harness SHALL be read from the resolved configuration
- **AND** no primary-role path SHALL pass a literal harness name to the invocation

#### Scenario: Spec-generation paths follow the role rather than a fixed harness

- **WHEN** the repository declares an implementer that is not `claude` and intake or sweep generates a
  spec
- **THEN** the spec-generation invocation SHALL target the resolved implementer, not `claude`

---

### Requirement: Every secondary-role execution path SHALL invoke the resolved reviewer

Every pipeline execution path whose work is review work SHALL invoke the resolved reviewer harness. This
SHALL cover, at minimum: plan review, each standard and adversarial review round, the pre-merge delta
review, the shipcheck gate, and the design-interrogation gate. The existing same-harness self-review
fallback SHALL be preserved: when the resolved reviewer cannot be spawned, the resolved implementer is
attempted next, and the recorded reviewer identity SHALL mark that outcome as a same-harness fallback
rather than as independent review.

#### Scenario: Review paths target the configured reviewer

- **WHEN** the repository declares `reviewer: codex` and plan review, review round 1, review round 2,
  the pre-merge delta review, shipcheck, and the design gate each run with injected fakes
- **THEN** each reviewer invocation SHALL target the `codex` harness

#### Scenario: Independence is judged against the resolved roles

- **WHEN** the resolved implementer and the resolved reviewer are different harnesses
- **THEN** the recorded reviewer identity SHALL be marked independent

#### Scenario: Same-harness fallback is preserved and labelled

- **WHEN** the resolved reviewer cannot be spawned and the resolved implementer is used instead
- **THEN** the review SHALL proceed on the implementer harness
- **AND** the recorded reviewer identity SHALL be marked as a same-harness fallback

---

### Requirement: Resolved role harnesses SHALL be validated before a run starts

A harness name that resolves to no registered harness adapter SHALL be rejected at configuration-resolve
time with a message naming the configuration key, the offending value, and the registered adapter names;
no stage SHALL execute. For role names that do resolve, CLI presence, authentication state, and the
ability to honor the requested model and effort SHALL be checked for **both** resolved roles by the
existing harness-adapter readiness preflight before the first model invocation of a run. A readiness
failure SHALL abort the run rather than substituting a different harness for the failing role.

#### Scenario: Unregistered harness name is rejected at parse time

- **WHEN** `harnesses.implementer` names a harness for which no adapter is registered
- **THEN** configuration resolution SHALL fail with a message naming the key, the value, and the
  registered adapter names
- **AND** no stage SHALL execute

#### Scenario: Both resolved roles are preflighted

- **WHEN** the resolved implementer and reviewer are different harnesses and run-start preflight runs
- **THEN** a readiness check SHALL be emitted for each of the two resolved role harnesses

#### Scenario: An unauthenticated role harness blocks the run without substitution

- **WHEN** a resolved role harness is installed but unauthenticated and run-start preflight is enabled
- **THEN** the run SHALL abort before the first model invocation
- **AND** no other harness SHALL be substituted for the failing role

#### Scenario: A model or effort the role harness cannot honor is reported distinguishably

- **WHEN** a resolved role harness is authenticated but cannot honor the configured model or effort
- **THEN** the readiness outcome SHALL be distinguishable from the missing-CLI and unauthenticated
  outcomes

---

### Requirement: Run evidence SHALL record the resolved roles, their sources, and treatment coordinates

The run's evidence bundle SHALL record, for the run, the resolved implementer and the resolved reviewer,
and for each role the source that determined it — the repository `harnesses` block, the `review_harness`
key, or the active profile. Each harness invocation's recorded treatment coordinates — adapter name, CLI
version, requested and resolved model, requested and resolved effort, and the native flags used — SHALL
continue to be recorded, so a run's harness pairing and per-call treatment are auditable after the run
ends. Recording SHALL remain non-fatal: a failure to record SHALL NOT fail the run.

#### Scenario: Resolved roles and sources are recorded

- **WHEN** a run executes with `harnesses.implementer` declared in repository config and the reviewer
  taken from the profile
- **THEN** the evidence bundle SHALL record the resolved implementer with source `repo-config`
- **AND** SHALL record the resolved reviewer with source `profile`

#### Scenario: review_harness-sourced reviewer is attributed to that key

- **WHEN** the reviewer is resolved from `review_harness` with no `harnesses.reviewer` present
- **THEN** the evidence bundle SHALL record the reviewer's source as `review_harness`

#### Scenario: Treatment coordinates accompany invocations

- **WHEN** a stage invokes a resolved role harness
- **THEN** the recorded treatment coordinates for that invocation SHALL include the adapter name and the
  requested model and effort, with unknown resolved values recorded as unknown rather than echoed from
  the request

#### Scenario: Evidence recording failure does not fail the run

- **WHEN** writing the role or treatment record fails
- **THEN** the run SHALL continue unaffected
