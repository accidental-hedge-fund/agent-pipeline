## MODIFIED Requirements

### Requirement: Structural validation gates the change

The change SHALL be validated with `openspec validate` at draft and again after revision. A
validation failure SHALL emit a canonical `implementation-ci` stage diagnostic with blocker kind
`openspec-invalid`, a reason containing the exact bounded CLI output, change id, and validation
phase, plus a stable evidence key. The stage SHALL return that diagnostic through the whole-item
response. Before terminalizing the run, the outer recovery controller SHALL route it through the
shared bounded remediation transaction when its keyed budget permits, then redispatch the whole
item so validation runs against the resulting current candidate. The item SHALL proceed only after
validation passes. Exhausted validation repair SHALL remain an engine-owned artifact failure and
SHALL NOT emit `human_intervention` without separate current authority evidence.

#### Scenario: Invalid change receives bounded repair before terminal block

- **WHEN** the authored or revised change fails `openspec validate` and an artifact-repair attempt
  remains for the diagnostic key
- **THEN** the stage SHALL return the exact recoverable diagnostic before terminalizing
- **AND** the outer controller SHALL repair and redispatch the item so validation re-runs against
  the current candidate

#### Scenario: Exhausted invalid change remains blocked but not human-owned

- **WHEN** structural validation still fails after the keyed repair budget is exhausted
- **THEN** the stage SHALL remain blocked with the exact canonical OpenSpec diagnostic
- **AND** it SHALL NOT create a needs-human authority hold or emit `human_intervention` solely for
  the validation failure

### Requirement: Archive into living specs at finalize

At pre-merge the change SHALL be archived by `openspec archive` in machine-readable mode, folding
its deltas into `openspec/specs/` and moving it under `openspec/changes/archive/`, and
`openspec validate --all` SHALL pass before the item reaches `ready-to-deploy`. Archive success
SHALL require both an explicit successful result for every intended change id and verification that
each corresponding active change directory is absent from the authoritative post-archive
candidate. Before archive, the pre-merge stage SHALL run the existing stale-delta consistency guard:
it SHALL block when both a later non-pipeline implementation commit exists after the last delta-spec
commit and the current structured review verdict carries `category: spec-divergence`. The guard
SHALL read the category marker and SHALL NOT infer divergence from reviewer prose.

#### Scenario: Archive on finalize when spec and code are consistent

- **WHEN** an OpenSpec-active item reaches pre-merge and the consistency guard does not detect a
  code-spec divergence
- **THEN** each active change SHALL be archived in machine-readable mode
- **AND** explicit archive results, active-directory removal, and `openspec validate --all` SHALL be
  verified before advancing

#### Scenario: Archive output without active-directory removal is not success

- **WHEN** the archive command exits successfully but an intended change directory remains active
  on the authoritative candidate
- **THEN** the archive gate SHALL emit a canonical `implementation-ci` diagnostic with blocker kind
  `openspec-invalid` and remain blocked
- **AND** it SHALL NOT record archive success or advance

#### Scenario: Pre-merge blocks when code moved but spec did not and a finding is tagged spec-divergence

- **WHEN** a non-pipeline commit changed implementation files after the last commit that changed
  the change's `specs/**`
- **AND** the most recent review verdict contains `category: spec-divergence`
- **THEN** pre-merge SHALL remain blocked with a diagnostic naming the stale-delta condition
- **AND** it SHALL NOT call `openspec archive`

#### Scenario: Pre-merge proceeds when no finding is tagged spec-divergence

- **WHEN** implementation files changed but the change's `specs/**` did not
- **AND** no review finding is tagged `category: spec-divergence`
- **THEN** the consistency guard SHALL NOT block on code/delta ordering alone
- **AND** archive evaluation SHALL proceed normally

#### Scenario: The consistency guard ignores prose

- **WHEN** a current review finding mentions spec divergence in prose but carries no structured
  `category: spec-divergence` marker
- **THEN** the consistency guard SHALL treat it as no divergence flag
- **AND** it SHALL NOT block on that prose alone

### Requirement: A failed `openspec archive` SHALL block pre-merge with the CLI output surfaced verbatim

Pre-merge SHALL, when `openspec archive <id>` exits nonzero, returns a non-success machine-readable
result, or leaves the change active, emit a canonical `implementation-ci` diagnostic with blocker
kind `openspec-invalid`, a reason containing the change id, archive result, and exact bounded
stdout/stderr, plus a stable evidence key.
It SHALL remain blocked and SHALL NOT advance toward `ready-to-deploy`. Before terminalizing the
run, the outer controller SHALL enter the shared bounded remediation transaction for that keyed
diagnostic when budget remains, then redispatch the item to re-evaluate archive preconditions and
archive the current candidate. A failed or no-action repair SHALL consume its claimed budget.
Exhaustion SHALL produce a typed engine-owned failure and SHALL NOT create a human-authority hold
without separate current authority evidence.

#### Scenario: Archive fails on a retitled MODIFIED requirement

- **WHEN** `openspec archive <id>` reports that a modified requirement header is absent from the
  living spec
- **THEN** pre-merge SHALL emit a canonical `implementation-ci` diagnostic containing the change
  id and exact CLI output in its bounded reason
- **AND** the item SHALL NOT reach `ready-to-deploy`

#### Scenario: Archive failure receives one keyed repair path

- **WHEN** a canonical OpenSpec archive diagnostic has an eligible repair attempt
- **THEN** pre-merge SHALL return that exact diagnostic to the outer recovery controller
- **AND** the controller SHALL remediate and redispatch only within the durable keyed budget

#### Scenario: Failed artifact repair consumes budget without human intervention

- **WHEN** a started artifact repair fails
- **THEN** the attempt SHALL remain charged and its exact error SHALL be recorded
- **AND** no `human_intervention` SHALL be emitted solely for that engine-owned failure
