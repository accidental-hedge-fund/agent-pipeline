## MODIFIED Requirements

### Requirement: The config schema SHALL accept a strict `harnesses` role block

`.github/pipeline.yml` SHALL accept a strict `harnesses` block with exactly two keys, `implementer` and `reviewer`, each a non-empty string naming a harness. The block SHALL be strict: any other key inside it SHALL be rejected at validation time with a message naming the offending key. For execution-policy resolution, omitting the block or omitting either key SHALL fail closed as specified by `required-repository-harness-roles`.

The block SHALL appear in the generated config JSON Schema with a description for each key that identifies the key as required repository execution policy. `pipeline config sync` SHALL preserve an existing complete `harnesses` block's effective values. Sync SHALL NOT comment either required role out, SHALL NOT document profile fallback for live workers, and SHALL NOT invent a missing live role from the active profile.

#### Scenario: Both roles declared

- **WHEN** `.github/pipeline.yml` contains `harnesses:` with `implementer: grok` and `reviewer: codex`
- **THEN** validation SHALL succeed
- **AND** `resolveConfig()` SHALL NOT throw

#### Scenario: Unknown key inside the block is rejected

- **WHEN** `.github/pipeline.yml` contains a `harnesses:` block with a key that is neither `implementer` nor `reviewer`
- **THEN** validation SHALL fail with a message naming the offending key
- **AND** no stage SHALL run

#### Scenario: Block absent

- **WHEN** `.github/pipeline.yml` contains no `harnesses:` block
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.implementer` and `harnesses.reviewer`

#### Scenario: Schema and sync expose the block

- **WHEN** `pipeline config schema` runs
- **THEN** its output SHALL describe the `harnesses` block with a description for `implementer` and for `reviewer`
- **AND** those descriptions SHALL NOT state that an omitted role falls back to the active profile
- **AND** `pipeline config sync` on a config already containing both roles SHALL preserve that config's effective behavior

### Requirement: Reviewer-role precedence between `harnesses.reviewer` and `review_harness` SHALL be explicit and non-silent

`review_harness` SHALL remain supported in both its string and structured forms as a structured overlay. Execution-policy resolution SHALL still require `harnesses.reviewer`. When `review_harness` is present and `harnesses.reviewer` is absent, resolution SHALL fail closed rather than treating `review_harness` as the live reviewer declaration. When both are present and name **different** commands, the configuration SHALL be rejected with a message naming both keys and both values, rather than silently selecting one. When both are present and name the **same** command, the configuration SHALL be accepted, and the structured `review_harness` model, effort, and prompt-delivery settings SHALL continue to apply to the reviewer invocation.

#### Scenario: Conflicting reviewer declarations are rejected

- **WHEN** `harnesses.reviewer` is `codex` and `review_harness.command` is `claude`
- **THEN** configuration resolution SHALL fail with a message naming both keys and both values
- **AND** no stage SHALL run

#### Scenario: Agreeing declarations keep the structured reviewer settings

- **WHEN** `harnesses.reviewer` is `codex` and `review_harness` is `{ command: codex, model: gpt-5.6-terra, effort: high }`
- **AND** `harnesses.implementer` is also declared
- **THEN** the resolved reviewer SHALL be `codex`
- **AND** the resolved reviewer model SHALL be `gpt-5.6-terra` and the resolved reviewer effort SHALL be `high`

#### Scenario: review_harness alone still overrides the profile reviewer

- **WHEN** `review_harness: my-reviewer` is set and no `harnesses` block is present
- **THEN** execution-policy resolution SHALL fail with a diagnostic naming `harnesses.reviewer`
- **AND** the live reviewer SHALL NOT be `my-reviewer` by fallback from `review_harness` or the profile

### Requirement: Run evidence SHALL record the resolved roles, their sources, and treatment coordinates

The run's evidence bundle SHALL record, for the run, the resolved implementer and the resolved reviewer, and for each role the source that determined it. For execution runs the live role source SHALL be the repository `harnesses` block (`repo-config`). Structured reviewer model, effort, and prompt-delivery MAY still be attributed to `review_harness` when that overlay is present and agrees. Execution-run evidence SHALL NOT record the active profile as the source of a live implementer or reviewer. Each harness invocation's recorded treatment coordinates — adapter name, CLI version, requested and resolved model, requested and resolved effort, and the native flags used — SHALL continue to be recorded, so a run's harness pairing and per-call treatment are auditable after the run ends. Recording SHALL remain non-fatal: a failure to record SHALL NOT fail the run.

#### Scenario: Resolved roles and sources are recorded

- **WHEN** a run executes with both `harnesses.implementer` and `harnesses.reviewer` declared in repository config
- **THEN** the evidence bundle SHALL record the resolved implementer with source `repo-config`
- **AND** SHALL record the resolved reviewer with source `repo-config`

#### Scenario: review_harness-sourced reviewer is attributed to that key

- **WHEN** the reviewer command is declared in `harnesses.reviewer` and agreeing structured settings come from `review_harness`
- **THEN** the evidence bundle SHALL record the live reviewer command source as `repo-config`
- **AND** SHALL NOT record the active profile as the live reviewer source

#### Scenario: Treatment coordinates accompany invocations

- **WHEN** a stage invokes a resolved role harness
- **THEN** the recorded treatment coordinates for that invocation SHALL include the adapter name and the requested model and effort, with unknown resolved values recorded as unknown rather than echoed from the request

#### Scenario: Evidence recording failure does not fail the run

- **WHEN** writing the role or treatment record fails
- **THEN** the run SHALL continue unaffected

## ADDED Requirements

### Requirement: Live implementer and reviewer roles SHALL resolve only from the repository harnesses block

Role resolution for execution SHALL set the live implementer from `harnesses.implementer` and the live reviewer from `harnesses.reviewer`. Resolution SHALL be independent of which host invoked the pipeline: the same complete repository configuration SHALL resolve to the same pair of roles under every profile. The active profile SHALL NOT supply either live role when a key is missing.

#### Scenario: Repository config wins over the profile

- **WHEN** the active profile declares implementer `claude` and reviewer `codex`, and the repository declares `implementer: grok` and `reviewer: codex`
- **THEN** the resolved implementer SHALL be `grok` and the resolved reviewer SHALL be `codex`

#### Scenario: Resolution is host-independent

- **WHEN** the same repository configuration declaring both roles is resolved under the `claude` profile and separately under the `codex` profile
- **THEN** both resolutions SHALL yield the identical implementer and reviewer

#### Scenario: Partial declaration does not fall back per role

- **WHEN** the repository declares only `implementer` in the `harnesses` block
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail closed
- **AND** the resolved reviewer SHALL NOT equal the active profile's reviewer

## REMOVED Requirements

### Requirement: Repository role configuration SHALL override the profile default per role

**Reason**: Replaced by fail-closed repository declaration. Per-role profile fallback let an outer host select a live worker when either key was missing.

**Migration**: Add both `harnesses.implementer` and `harnesses.reviewer` to `.github/pipeline.yml`. A partial block that previously inherited the missing role from the profile now fails until the omitted key is set. The replacement requirement is "Live implementer and reviewer roles SHALL resolve only from the repository harnesses block".
