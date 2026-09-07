## ADDED Requirements

### Requirement: Deterministic candidate qualification SHALL precede remote fixture creation

Factory-release preparation SHALL run or re-observe exact-candidate installed-CLI qualification before creating a remote FRG fixture issue or PR. Missing or failed qualification SHALL stop at a typed preflight defect with the artifact path and failed cells. It SHALL NOT create, replace, or dispatch a remote fixture pack. A passing qualification artifact SHALL be reused idempotently for the same candidate.

#### Scenario: Qualification failure creates no fixtures

- **WHEN** exact-candidate installed-CLI qualification is missing, stale, malformed, or has a failed required case
- **THEN** factory-release preparation SHALL fail before its first remote fixture mutation
- **AND** no successor fixture pair SHALL be created

#### Scenario: Passing qualification is reused

- **WHEN** the same candidate and matrix version are prepared again after qualification passed
- **THEN** preparation SHALL validate and reuse the existing artifact
- **AND** it SHALL NOT rerun qualification or create an additional fixture pair solely to rediscover local faults

### Requirement: Remote FRG SHALL be one final candidate-bound canary

After deterministic qualification passes, a release candidate MAY create at most one active remote fixture pair. A canary failure SHALL retain its pack identity and artifacts for replay and diagnosis. Automatic retry SHALL reconcile or resume that same pack; it SHALL NOT manufacture a fresh pair for the unchanged candidate. A changed candidate SHALL require new deterministic qualification before one successor canary is permitted, and the prior pack SHALL be reconciled first.

#### Scenario: Same-candidate retry reuses the pack

- **WHEN** candidate `C` has a failed or interrupted canary pack with persisted identity
- **AND** release preparation is retried without changing `C`
- **THEN** preparation SHALL replay or resume the same pack artifacts
- **AND** it SHALL NOT create a new pair

#### Scenario: Changed candidate gets one successor only after qualification

- **WHEN** candidate changes from `C1` to `C2`
- **THEN** the `C1` pack SHALL be reconciled before any successor mutation
- **AND** exact-candidate qualification for `C2` SHALL pass before the single `C2` canary pair is created

## MODIFIED Requirements

### Requirement: Ship FRG unique-operation scoring SHALL use control-host durable evidence bound to the scored candidate

Ship FRG unique-operation scoring SHALL collect unique-operation attempts and #1301 live train-loop linkage from the control-host generic run store used for train, advance, and merge (`<control-repo>/.agent-pipeline/runs`) and from the loop state-home runs root. Followable `train_loop_linked` child run, event, and handoff paths SHALL resolve inside those control-host roots; a path that escapes into the candidate worktree SHALL NOT be loaded as unique-operation evidence. It SHALL NOT treat an empty candidate-worktree `.agent-pipeline/runs` directory as proof that train, loop, merge, or merge-queue never ran. In-flight ship scoring SHALL keep unbound control-host attempts that lack `candidate_sha`. Standalone factory-gate scoring SHALL omit unbound attempts. In-flight ship scoring SHALL pass candidate-bound #1333 executed matrix rows through the existing unique-operation coverage seam, including rows from a validated exact-candidate qualification artifact. Static inventory SHALL NOT be converted into executed rows. GitHub pack-issue labels, comment prose, and factory-gate 2-item pack proofs (clean-docs, clean-openspec, hybrid v2 Layer A) SHALL NOT substitute for unique-operation coverage. When the control-host generic store and the loop state-home are both empty of collectable train, loop, and merge evidence, unique-operation coverage SHALL fail closed as missing required coverage. This capability SHALL NOT add a second unique-operation aggregator, Factory Reliability Gate runner, or scheduler.

#### Scenario: Empty candidate-worktree run-store does not fail a host-proven ship

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the candidate worktree `.agent-pipeline/runs` is empty
- **AND** the control-host durable store has train, loop, and merge unique-operation evidence bound to `C`
- **AND** hybrid v2 pack proofs pass
- **THEN** FRG structural eligibility SHALL NOT fail solely because the candidate worktree run-store is empty
- **AND** `isReleaseEligibleFrgPass` with attestation optional SHALL be true when remaining unique-operation SLOs and bindings hold

#### Scenario: Empty candidate worktree plus populated generic host store observes required entrypoints under in-flight ship

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the candidate worktree `.agent-pipeline/runs` is empty
- **AND** the control-host generic run store has recognized public-entrypoint artifacts
- **THEN** required public entrypoints present in that generic store SHALL be observed
- **AND** FRG structural eligibility SHALL NOT fail solely because the loop state-home was the only root scanned

#### Scenario: Empty control-host store remains fail-closed

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host generic run store has no collectable train, loop, or merge unique-operation evidence
- **AND** the loop state-home has no collectable train, loop, or merge unique-operation evidence
- **THEN** unique-operation coverage SHALL fail as missing required coverage
- **AND** release-eligible pass SHALL be refused
- **AND** pack-issue `pipeline:ready-to-deploy` labels SHALL NOT satisfy that coverage

#### Scenario: Empty control-host store remains fail-closed when candidate-worktree artifacts match

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host generic run store has no collectable train, loop, or merge unique-operation evidence
- **AND** the loop state-home has no collectable train, loop, or merge unique-operation evidence
- **AND** the candidate worktree `.agent-pipeline/runs` has matching unique-operation attempts and executed-matrix rows bound to `C`
- **THEN** unique-operation coverage SHALL fail as missing required coverage
- **AND** release-eligible pass SHALL be refused

#### Scenario: Pack proofs are not unique-operation substitutes

- **WHEN** factory-gate 2-item pack proofs (clean-docs, clean-openspec, hybrid v2 Layer A) pass
- **AND** durable unique-operation evidence collectable from the control-host stores is absent
- **THEN** release-eligible pass SHALL be refused
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

#### Scenario: #1333 rows come from control-host or engine evidence for the candidate

- **WHEN** ship FRG unique-operation scoring runs for candidate SHA `C`
- **AND** executed matrix rows bound to `C` exist in control-host or engine evidence
- **THEN** those rows SHALL feed #1333 `covered_lifecycle_classes` through the existing binder
- **AND** helper stamps and pack labels SHALL NOT populate that coverage

#### Scenario: In-flight ship inventory alone receives no executed coverage

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** durable executed matrix rows bound to `C` are absent from host run artifacts
- **AND** the candidate tree's inventory is complete but no validated qualification artifact exists
- **THEN** inventory completeness alone SHALL NOT populate #1333 `covered_lifecycle_classes`
- **AND** helper stamps SHALL NOT populate that coverage
- **AND** missing executed coverage SHALL fail as missing required coverage

#### Scenario: Candidate-worktree child handoff does not satisfy host #1301 linkage

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host train stream bound to `C` carries `train_loop_linked` whose events path resolves in the candidate worktree
- **AND** that child run exists only in the candidate worktree
- **THEN** that child SHALL NOT be loaded as unique-operation evidence
- **AND** #1301 live train-loop linkage SHALL NOT be treated as present from that handoff
- **AND** release-eligible pass SHALL be refused

#### Scenario: Candidate-only host artifacts without release identity remain fail-closed

- **WHEN** standalone factory-gate scoring runs for candidate SHA `C` and release identity `R`
- **AND** the control-host store has unique-operation artifacts bound to `C` with no durable release identity
- **THEN** unique-operation coverage SHALL fail as missing required coverage
- **AND** release-eligible pass SHALL be refused

#### Scenario: In-flight ship keeps unbound host artifacts that lack candidate SHA

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the control-host generic run store has train and loop artifacts with no `candidate_sha`
- **THEN** those artifacts SHALL be kept as unique-operation attempts
- **AND** entrypoint coverage SHALL observe `train` and `loop`


## REMOVED Requirements

### Requirement: In-flight ship FRG scoring SHALL attach candidate-bound #1333 executed rows from a complete matrix inventory

### Requirement: In-flight ship #1333 attach SHALL succeed on a live from-run score when the commit-bound inventory at the scored SHA is complete
