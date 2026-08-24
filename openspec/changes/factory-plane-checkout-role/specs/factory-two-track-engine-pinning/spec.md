## ADDED Requirements

### Requirement: Factory-control identity SHALL be a checkout role not a GitHub repository name

Factory-control identity for two-track pin policy SHALL be a checkout role: the live factory control checkout identified by factory-plane `REPO_DIR` or `AGENT_PIPELINE_FACTORY_CONTROL` (that directory, or a managed worktree of that directory). GitHub owner/name SHALL NOT be a factory-control signal. `config.repo` equal to `accidental-hedge-fund/agent-pipeline` SHALL NOT activate factory-control context. A `package.json` `repository` field that names that GitHub repository SHALL NOT activate factory-control context or factory-pin self-dogfood.

A non-control clone of `accidental-hedge-fund/agent-pipeline` SHALL be a non-factory checkout. On that checkout, with no explicit `--engine-track` / `engine_track`, `resolveEngineTrackIntent` for `doctor` and `train` SHALL be inactive (`null`). Host skill boot on that checkout SHALL NOT require `AGENT_PIPELINE_PRODUCTION_PIN`. A leftover `.agent-pipeline/production-engine-pin.json` under that clone SHALL NOT activate pinned two-track policy. Hermes-state `~/.local/state/hermes-factory/production-engine-pin.json` SHALL NOT be live pin authority and SHALL NOT activate factory-control context.

On the live factory control checkout, default two-track intent for `doctor` / `train` / loop / single / advance SHALL remain `pinned`. Pinned intent SHALL still fail closed on a `no-frg-*` or null-evidence pin. The single live pin file SHALL be `$REPO_DIR/.agent-pipeline/production-engine-pin.json` unless the operator has explicitly set `AGENT_PIPELINE_PRODUCTION_PIN` to that same path. Factory ship composers MAY export that env when `REPO_DIR` is the live control checkout; ordinary host skill boot SHALL NOT require that env to start.

Callers that currently treat GitHub owner/name as factory-plane identity SHALL use this checkout-role predicate instead. The next leftover `no-frg-*` pin on another clone or host SHALL NOT require a new mole issue.

#### Scenario: GitHub owner/name does not activate factory-control context

- **WHEN** `pipeline doctor` or `pipeline train` runs in a checkout whose `config.repo` is `accidental-hedge-fund/agent-pipeline`
- **AND** the invocation directory is not the live factory control checkout
- **AND** `AGENT_PIPELINE_FACTORY_CONTROL` is unset
- **AND** factory-plane `REPO_DIR` is unset
- **AND** no explicit `--engine-track` / `engine_track` is set
- **THEN** factory-control context SHALL be false
- **AND** `resolveEngineTrackIntent` for `doctor` and `train` SHALL be `null`

#### Scenario: package.json repository field is not factory-pin self-dogfood

- **WHEN** an operator runs `pipeline factory-pin` (show, init, promote, or rollback)
- **AND** the invocation directory is a clone of `accidental-hedge-fund/agent-pipeline` that is not the live factory control checkout
- **AND** `package.json` `repository` names `accidental-hedge-fund/agent-pipeline`
- **AND** neither factory-control directory (`AGENT_PIPELINE_FACTORY_CONTROL` or equivalent) nor an explicit pin path override is configured
- **THEN** the command SHALL refuse before reading or writing a production pin
- **AND** SHALL NOT treat the clone as factory-pin self-dogfood

#### Scenario: Leftover clone pin does not activate pinned policy

- **WHEN** a non-control clone of `accidental-hedge-fund/agent-pipeline` has `.agent-pipeline/production-engine-pin.json` with `frg_run_id` `no-frg-1.39.1`
- **AND** no explicit `--engine-track` / `engine_track` is set
- **AND** factory-control context is false
- **THEN** two-track pin policy SHALL remain inactive
- **AND** `pipeline doctor` / `pipeline train` SHALL NOT fail closed solely because that leftover pin exists

#### Scenario: Hermes-state pin is not live authority

- **WHEN** `~/.local/state/hermes-factory/production-engine-pin.json` exists on the host
- **AND** the invocation is a non-control clone
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **THEN** that Hermes-state file SHALL NOT be live pin authority
- **AND** SHALL NOT activate factory-control context
- **AND** host skill boot SHALL succeed without setting `AGENT_PIPELINE_PRODUCTION_PIN`

#### Scenario: Live control checkout stays pinned without PRODUCTION_PIN

- **WHEN** `pipeline doctor` or `pipeline train` runs on the live factory control checkout
- **AND** factory-plane `REPO_DIR` identifies that checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** no explicit `--engine-track` / `engine_track` is set
- **THEN** `resolveEngineTrackIntent` SHALL be `pinned`
- **AND** the live pin path SHALL be `$REPO_DIR/.agent-pipeline/production-engine-pin.json`

#### Scenario: Managed worktree of the live control checkout stays factory-control

- **WHEN** factory-plane `REPO_DIR` is the live factory control checkout
- **AND** the invocation `repo_dir` is a managed worktree of that checkout
- **AND** no explicit `--engine-track` / `engine_track` is set
- **THEN** factory-control context SHALL be true
- **AND** default two-track intent for advance / train item execution SHALL be `pinned`

#### Scenario: Managed worktree of a developer clone is not factory-control

- **WHEN** the invocation `repo_dir` is a managed worktree of a non-control clone of `accidental-hedge-fund/agent-pipeline`
- **AND** factory-plane `REPO_DIR` and `AGENT_PIPELINE_FACTORY_CONTROL` are unset
- **AND** no explicit `--engine-track` / `engine_track` is set
- **THEN** factory-control context SHALL be false
- **AND** `resolveEngineTrackIntent` SHALL be `null`

## MODIFIED Requirements

### Requirement: Pinned-track production and dogfood runs SHALL execute the production pin install

Factory production and dogfood runs that operate on the **pinned** track SHALL execute the
engine install corresponding to the production pin (the existing tag-pinned install path
`npx …#<tag> install` or an equivalent install of that tag), not an unpinned floating
default-branch install and not an ad-hoc unreleased working-tree engine used as if it were
production. The running engine version for a pinned-track run SHALL match the pin's
`version` (normalizing an optional leading `v`). Version equality alone SHALL NOT be
sufficient to classify a run as track `pinned`: the system SHALL also require verifiable
tag-install provenance (for example an installer receipt identifying the pin tag). A
same-version working-tree candidate without that provenance SHALL NOT be recorded as
`pinned`. Under default pinned intent (live factory control checkout production/dogfood only), a missing
or invalid production pin SHALL refuse the run before stages execute rather than silently
reclassifying to candidate and continuing. Ordinary non-factory advances (product
repositories that consume the installed skill without explicit `--engine-track` /
`engine_track`, and checkouts that are not the live factory control checkout, including a
non-control clone of `accidental-hedge-fund/agent-pipeline`) SHALL NOT apply pinned-track
enforcement and SHALL NOT require a production pin. The production pin authority SHALL be
the factory control checkout (or an explicitly configured pin path / factory-control dir),
not every target product `repo_dir` under advance. Under active pinned intent against a
non-factory target, when neither factory-control directory nor an explicit pin path is
configured, the system SHALL refuse rather than loading a product-local pin (or treating
a missing product-local pin as the factory pin). Candidate-track evidence SHALL NOT attach
the production pin's `git_sha` as the executing engine SHA.

#### Scenario: Pinned-track run matches the pin version

- **WHEN** a factory production/dogfood run is classified as track `pinned`
- **AND** the production pin version is `1.29.1`
- **THEN** the engine version recorded for that run SHALL equal `1.29.1` (ignoring a leading `v`)
- **AND** the run SHALL NOT silently substitute a different candidate build as the production engine

#### Scenario: Unpinned floating install is not a valid pinned-track production posture

- **WHEN** the installed/running engine does not match the production pin version
- **AND** the operator claims or configures pinned-track production intent
- **THEN** the system SHALL treat the posture as misconfigured (doctor fail or equivalent policy signal)
- **AND** SHALL NOT present the run as a coherent pinned production execution

#### Scenario: Same-version working-tree is not coherent pinned without install provenance

- **WHEN** pinned-track production intent applies
- **AND** the running engine version equals the production pin version
- **AND** tag-install provenance for the pin tag cannot be established (for example no
  matching installer receipt, or the engine is a control-repo working tree)
- **THEN** the system SHALL refuse to classify the run as coherent track `pinned`
- **AND** under default pinned intent SHALL refuse the advance before stages (or doctor
  fail with reinstall remediation)

#### Scenario: Working-tree signal outranks a copied or stale installer receipt

- **WHEN** the executing engine root is identified as a control-repo or managed worktree
- **AND** an installer receipt file is also present and parseable for the pin tag
- **THEN** install provenance SHALL classify as `working_tree` (not `tag_install`)
- **AND** pinned-track intent SHALL NOT treat the run as coherent track `pinned`

#### Scenario: Missing pin under pinned intent refuses the run

- **WHEN** pinned-track production intent applies
- **AND** the production pin artifact is missing or invalid
- **THEN** the advance path SHALL refuse before stages execute
- **AND** SHALL NOT continue while only labeling evidence as track `candidate`

#### Scenario: Ordinary non-factory advance does not require a production pin

- **WHEN** an ordinary advance runs against a non-factory product repository
- **AND** no explicit `--engine-track` / `engine_track` is set
- **AND** no production pin artifact is present in the target repository
- **THEN** the advance path SHALL NOT refuse for `missing_pin`
- **AND** SHALL proceed to stages without requiring factory pin policy

#### Scenario: Non-control clone of this GitHub repo does not require a production pin

- **WHEN** an ordinary advance, `pipeline doctor`, or `pipeline train` runs in a
  non-control clone of `accidental-hedge-fund/agent-pipeline`
- **AND** no explicit `--engine-track` / `engine_track` is set
- **AND** factory-plane `REPO_DIR` and `AGENT_PIPELINE_FACTORY_CONTROL` are unset
- **THEN** the path SHALL NOT refuse for `missing_pin`
- **AND** SHALL NOT apply default pinned-track enforcement
- **AND** SHALL NOT require `AGENT_PIPELINE_PRODUCTION_PIN` to boot

#### Scenario: Pin authority is factory control not every target repo

- **WHEN** pinned-track production intent applies
- **AND** the production pin is configured via factory control path or pin path override
- **AND** the advance target repository differs from that pin authority
- **THEN** pin resolution SHALL use the factory control / override path
- **AND** SHALL NOT require the pin file to exist under the product target `repo_dir`

#### Scenario: Pinned intent without factory pin authority refuses

- **WHEN** pinned-track production intent applies
- **AND** the target checkout is not the live factory control checkout
- **AND** neither factory-control directory (`AGENT_PIPELINE_FACTORY_CONTROL` or equivalent)
  nor an explicit pin path override is configured
- **THEN** the advance path SHALL refuse before stages execute
- **AND** doctor under the same pinned intent SHALL fail
- **AND** remediation SHALL require configuring factory-control directory or pin path
- **AND** SHALL NOT load a product-local pin file as production pin authority

#### Scenario: factory-pin refuses product repository as pin authority

- **WHEN** an operator runs `pipeline factory-pin` (show, init, promote, or rollback)
- **AND** the invocation directory is not the factory control checkout
- **AND** neither factory-control directory (`AGENT_PIPELINE_FACTORY_CONTROL` or equivalent)
  nor an explicit pin path override is configured
- **THEN** the command SHALL refuse before reading or writing a production pin
- **AND** SHALL NOT create or update `.agent-pipeline/production-engine-pin.json` under the
  product repository as if it were factory pin authority

#### Scenario: Candidate evidence does not inherit the production pin SHA

- **WHEN** a run is classified as track `candidate`
- **AND** a production pin with a non-empty `git_sha` is readable
- **THEN** run evidence SHALL NOT set `engine.git_sha` to that pin SHA solely because
  the pin is readable
- **AND** MAY omit `git_sha` when the candidate checkout SHA is not resolved
