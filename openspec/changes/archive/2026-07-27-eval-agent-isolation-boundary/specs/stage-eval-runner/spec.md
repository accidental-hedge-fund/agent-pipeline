## MODIFIED Requirements

### Requirement: A versioned experiment manifest SHALL define the experiment

The runner SHALL accept a versioned, repo-local experiment manifest declaring: `schema_version`;
a stable `experiment_id`; the set of `fixture_ids` under test; an execution `mode` that is either
a single named stage or `end-to-end`; the treatment axes (`harness`, `provider`, `model`,
`effort`); a `replicates` count; a randomization `seed`; a `concurrency` bound; a per-cell
`timeout`; an `output_dir`; and the execution sandbox mode its cells run under. The sandbox mode
SHALL be optional with a default that preserves the harness's own managed sandbox, so an existing
manifest that omits it stays valid and unchanged in behavior.

Manifest validation SHALL occur before any treatment is executed. A manifest that omits a
required field, names an unknown execution mode, names an unsupported sandbox mode, references an
unknown fixture, or declares an unsupported `schema_version` SHALL be rejected with a message
naming the offending field, and no treatment SHALL be executed.

#### Scenario: Complete manifest is accepted

- **WHEN** a manifest declaring `schema_version`, `experiment_id`, `fixture_ids`, `mode`,
  treatment axes, `replicates`, `seed`, `concurrency`, `timeout`, and `output_dir` is loaded
- **THEN** the manifest SHALL be accepted as valid

#### Scenario: Manifest with a missing required field is rejected

- **WHEN** a manifest omits a required field
- **THEN** loading SHALL fail with a message naming the missing field
- **AND** no treatment SHALL be executed

#### Scenario: Manifest naming an unknown mode or fixture is rejected

- **WHEN** a manifest declares an execution mode that is neither a supported stage name nor
  `end-to-end`, or references a `fixture_id` that does not resolve to a fixture
- **THEN** loading SHALL fail naming the unknown value
- **AND** no treatment SHALL be executed

#### Scenario: Manifest naming an unsupported sandbox mode is rejected

- **WHEN** a manifest declares an execution sandbox mode that is not a supported value
- **THEN** loading SHALL fail naming the offending field
- **AND** no treatment SHALL be executed

#### Scenario: Manifest omitting the sandbox mode keeps the managed-sandbox default

- **WHEN** a manifest declares no execution sandbox mode
- **THEN** it SHALL be accepted
- **AND** its cells SHALL run under the harness's own managed sandbox

---

### Requirement: Evaluation mode SHALL perform no production GitHub writes

While executing an experiment, the runner and every stage it invokes SHALL perform no mutating
GitHub operation against production state. In particular, evaluation mode SHALL NOT set or remove
a label, post or edit a comment, create, edit, or merge a pull request, or push to a production
branch, and SHALL NOT transition any real issue's authoritative pipeline state. This restriction
SHALL be enforced by the evaluation-mode GitHub surface refusing mutating operations, rather than
relying on individual call sites to check a mode flag.

Because a local CLI harness can shell out directly rather than through that surface, evaluation
mode SHALL additionally deny mutating GitHub operations, pushes, and remote mutations at the
harness child process boundary. Every refusal by the evaluation-mode GitHub surface and every
denial at the process boundary SHALL be recorded in the cell's durable evidence, not only returned
in memory or written to the console.

#### Scenario: No mutating GitHub call occurs during an experiment

- **WHEN** a full experiment matrix is executed in either stage mode or end-to-end mode
- **THEN** no label set or removal, no comment creation or edit, no pull-request creation, edit,
  or merge, and no push to a production branch SHALL be performed

#### Scenario: A stage attempting a production write fails loudly

- **WHEN** a stage invoked in evaluation mode attempts a mutating GitHub operation
- **THEN** the evaluation-mode GitHub surface SHALL refuse the operation
- **AND** the cell SHALL record the refusal rather than silently completing as if the write had
  succeeded

#### Scenario: A harness shelling out directly is denied at the process boundary

- **WHEN** a treatment invokes the GitHub CLI or a push directly, bypassing the evaluation-mode
  GitHub surface
- **THEN** the attempt SHALL be denied at the harness child process boundary
- **AND** no production GitHub or remote state SHALL change

#### Scenario: Refusals and denials are durably recorded on the cell

- **WHEN** a cell records a GitHub-surface refusal or a process-boundary denial
- **THEN** that record SHALL be present in the cell's persisted record in the experiment output

#### Scenario: No real issue changes authoritative state

- **WHEN** an experiment references a fixture derived from a real issue
- **THEN** that issue's pipeline stage label and authoritative state SHALL be unchanged after the
  experiment completes

---

### Requirement: Every cell record SHALL carry the identity keys needed to join it to normal run evidence

Every cell record SHALL include `experiment_id`, `fixture_id`, `treatment_id`, `replicate`,
`prompt_hash`, `config_hash`, `base_sha`, the fixture's `env_surface_hash` (the
environment-and-surface provenance hash), and the resolved execution sandbox mode under which the
cell ran. `prompt_hash` SHALL be computed over the materialized prompt text used for that cell,
`config_hash` over the effective configuration for that cell — which SHALL include the resolved
sandbox mode — and `env_surface_hash` SHALL be carried from the fixture's resolved
environment-fidelity contract and resolved capability surface, so that a prompt-template change, a
configuration change, a sandbox-mode change, or an environment/surface change is each detectable as
a difference between populations.

#### Scenario: Identity keys are present on every record

- **WHEN** any cell record is read from the experiment output
- **THEN** it SHALL contain `experiment_id`, `fixture_id`, `treatment_id`, `replicate`,
  `prompt_hash`, `config_hash`, `base_sha`, `env_surface_hash`, and the resolved sandbox mode

#### Scenario: Prompt and config changes are visible as hash differences

- **WHEN** two cells are executed with the same fixture and treatment but a different
  materialized prompt or a different effective configuration
- **THEN** their `prompt_hash` or `config_hash` values SHALL differ

#### Scenario: A sandbox-mode change is visible as a config-hash difference

- **WHEN** two cells are executed with the same fixture and treatment but different resolved
  execution sandbox modes
- **THEN** their `config_hash` values SHALL differ

#### Scenario: An environment or surface change is visible as a hash difference

- **WHEN** two cells are executed for fixtures identical except for one dependency's environment
  mode or a difference in the resolved capability surface
- **THEN** their `env_surface_hash` values SHALL differ

#### Scenario: A cell joins to ordinary run evidence

- **WHEN** a cell record and an ordinary pipeline run artifact are compared
- **THEN** the recorded identity keys SHALL be sufficient to determine whether they describe the
  same fixture, treatment, and base commit
