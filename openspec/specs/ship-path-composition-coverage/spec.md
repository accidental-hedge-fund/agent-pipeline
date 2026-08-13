# ship-path-composition-coverage Specification

## Purpose
Defines hermetic ship-path composition regression coverage so train∘loop frontier advance, scratch-only recover, and independent-sibling merge under partial failure cannot regress as silent unit islands, with an optional stale-block re-review join before train STOP.

## Requirements

### Requirement: Ship-path composition class inventory SHALL be complete for hard classes

The repository SHALL maintain a machine-readable inventory of ship-path composition class ids that includes at least: `train-frontier-one-wave`, `train-code-dep-merge-barrier`, `train-independent-r2d-merge-partial-failure`, `scratch-only-no-needs-human`, and `scratch-only-unlink-not-repair`. Each hard class SHALL map to one or more automated tests that run under the normal unit suite consumed by `npm run ci`. A silent omission of both a covering test and an explicit open-issue waiver for a hard class SHALL NOT be permitted. Soft class `stale-blocked-rereview-before-train-stop` MAY be present in the inventory; when present without a covering test it SHALL name an open tracking issue waiver.

#### Scenario: Hard class without coverage fails the inventory guard

- **WHEN** a hard ship-path composition class id is missing from the inventory or has no registered covering test and no open-issue waiver
- **THEN** a drift-guard or inventory unit test SHALL fail
- **AND** the failure SHALL name the missing class id

#### Scenario: Complete hard inventory passes the guard

- **WHEN** every hard composition class id has a registered covering test (or an explicit open tracking-issue waiver where policy allows — hard classes for this issue SHALL use tests, not waivers, for the three issue acceptance bites)
- **THEN** the inventory guard SHALL pass

#### Scenario: Soft class may be waived with open issue

- **WHEN** soft class `stale-blocked-rereview-before-train-stop` is inventoried with an explicit open tracking issue and no covering test yet
- **THEN** the inventory guard SHALL NOT fail solely for that soft waiver
- **AND** hard classes SHALL still require tests

---

### Requirement: Composition tests SHALL fail if train returns to N×single STOP-on-first-blocked

The composition suite SHALL include automated coverage for class `train-frontier-one-wave` such that the suite fails when train advance of a multi-item base-eligible frontier issues more than one multi-item loop/advance-wave call for that frontier, loops N× one-item `single` as the production train path, or defaults production wiring to a serial single-item advance adapter. The suite SHALL also cover that STOP-on-first-blocked does not replace proven-independent continuation (paired with the independent R2D merge class). Tests SHALL inject train/loop deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Multiple advance-wave calls for one frontier fail the suite

- **WHEN** a hermetic test drives train advance for a frontier of two independent issues
- **AND** the system under test records more than one multi-item advance-wave call for that frontier, or N× one-item `single` as the train-layer composition
- **THEN** the test SHALL fail

#### Scenario: Production wiring regression fails the suite

- **WHEN** production `pipeline train` (or ship train) wiring is inspected or exercised under test
- **AND** it defaults to serial N×`single` / single-item-only advance for frontier members
- **THEN** the covering test SHALL fail

#### Scenario: Injected deps only

- **WHEN** the `train-frontier-one-wave` composition test runs
- **THEN** it SHALL use injected fakes for gh, harness, worktree, loop, and related seams as needed
- **AND** it SHALL NOT perform real network, git, or subprocess calls

---

### Requirement: Composition tests SHALL fail if code-dependent child advances before base containment

The composition suite SHALL include automated coverage for class `train-code-dep-merge-barrier` such that the suite fails when a code-dependent successor enters an advance wave while the prerequisite’s merge-result is not contained in the fetched configured base.

#### Scenario: Dependent scheduled too early fails the suite

- **WHEN** issue B declares a code dependency on issue A
- **AND** A’s merge-result is not contained in the fetched base
- **AND** the system under test includes B in an advance wave anyway
- **THEN** the covering composition test SHALL fail

#### Scenario: Containment then child advance is allowed

- **WHEN** A is merged and containment in the fetched base is proven
- **THEN** B MAY appear in a later frontier under the existing train contract
- **AND** the composition test SHALL not treat that later inclusion as a failure

---

### Requirement: Composition tests SHALL fail if partial failure aborts independent R2D merge

The composition suite SHALL include automated coverage for class `train-independent-r2d-merge-partial-failure` such that the suite fails when a parked or blocked item prevents merge of a proven-independent already ready-to-deploy sibling, or when the whole train aborts before that independent merge solely because of the parked peer. When independence cannot be proven, fail-closed behavior remains correct and SHALL NOT be treated as a composition failure.

#### Scenario: Independent R2D sibling must still merge

- **WHEN** item P is parked or blocked
- **AND** item S is ready-to-deploy with no dependency edge involving P and independence is proven
- **AND** the system under test does not merge S (or aborts before that merge solely because P is parked)
- **THEN** the covering composition test SHALL fail

#### Scenario: Unproven independence fail-closed is not a false failure

- **WHEN** independence between parked P and R2D S cannot be proven
- **AND** the system under test refuses the independent-sibling merge
- **THEN** the composition suite SHALL NOT treat that refusal as a `train-independent-r2d-merge-partial-failure` regression

---

### Requirement: Composition tests SHALL fail if scratch-only dirt parks as needs-human

The composition suite SHALL include automated coverage for class `scratch-only-no-needs-human` such that the suite fails when porcelain that is scratch-only under the engine-known non-product set causes `pipeline:needs-human`, block kind `needs-human` / `human-decision-required`, or `setBlocked` solely for that scratch-only porcelain at a dirt gate under test.

#### Scenario: Scratch-only needs-human parks fail the suite

- **WHEN** porcelain lists only engine-known scratch (for example `?? artifacts/challenge-response-N.json`)
- **AND** no product path is uncommitted
- **AND** a dirt gate under test sets `needs-human` / `pipeline:needs-human` or `setBlocked` solely for that porcelain
- **THEN** the covering composition test SHALL fail

#### Scenario: Product dirt hard-block is not a false failure

- **WHEN** porcelain includes uncommitted product paths under `core/` or dirty product `openspec/`
- **AND** the gate hard-blocks with product-path disclosure
- **THEN** the composition suite SHALL NOT treat that hard-block as a `scratch-only-no-needs-human` regression

---

### Requirement: Composition tests SHALL fail if scratch-only recovery invokes implementer repair

The composition suite SHALL include automated coverage for class `scratch-only-unlink-not-repair` such that the suite fails when scratch-only recovery invokes `repair_pipeline_item` (or equivalent implementer harness repair) for that attempt instead of (or before completing) deterministic unlink/clear for engine-known scratch.

#### Scenario: Repair on scratch-only fails the suite

- **WHEN** a recoverable diagnostic projects to engine-scratch / `workflow-engine-defect` with scratch-only porcelain
- **AND** the recovery path invokes `repair_pipeline_item` for that attempt without a successful scratch-only unlink/clear path
- **THEN** the covering composition test SHALL fail

#### Scenario: Unlink without repair passes

- **WHEN** recovery executes `unlink_engine_scratch` (or equivalent), product dirt remains empty, and `repair_pipeline_item` is not invoked for that attempt
- **THEN** the covering composition test SHALL pass for this class

---

### Requirement: Soft composition class MAY cover stale-block re-review before train STOP

The composition suite MAY include class `stale-blocked-rereview-before-train-stop`. When that class is covered (not waived), the suite SHALL fail if an item carries leftover `pipeline:blocked` from reviewed-sha S, PR HEAD H has newer non-pipeline-internal movement past S (per existing stale-block rules), and train/loop treats the pre-resume leftover label as terminal STOP without one stale-block resume / re-review attempt on that advance.

#### Scenario: STOP before resume fails the soft class when covered

- **WHEN** the soft class is registered with a covering test
- **AND** stale blocked + non-internal HEAD movement conditions hold
- **AND** the system under test terminal-STOPs without attempting stale-block resume/re-review
- **THEN** that covering test SHALL fail

#### Scenario: Soft class waived does not block hard acceptance

- **WHEN** the soft class is inventoried only with an open tracking-issue waiver
- **THEN** the three hard issue acceptance bites (frontier wave, scratch-only no needs-human, independent R2D merge) SHALL still be test-covered
- **AND** overall composition coverage for hard classes SHALL remain required

---

### Requirement: Ship-path composition coverage SHALL NOT require live network ship in CI

Composition tests that satisfy this capability for CI SHALL be hermetic: zero real network, git, or subprocess calls. Full live Tugboat / FRG Layer B ship composition SHALL remain out of scope for this capability’s CI gate. Mapping class results into FRG evidence with `source: layer_a` is allowed; inventing release-eligible FRG `pass: true` from offline composition alone without existing FRG live-loop provenance rules is forbidden.

#### Scenario: Unit suite is sufficient for this capability’s CI proof

- **WHEN** `npm run ci` runs the unit suite including the ship-path composition inventory and hard-class tests
- **THEN** that SHALL be sufficient evidence for this capability’s CI acceptance
- **AND** a live network ship SHALL NOT be required for this capability to pass

#### Scenario: Offline composition does not mint release FRG pass alone

- **WHEN** hermetic ship-path composition tests pass
- **THEN** the pipeline SHALL NOT treat that alone as a release-eligible FRG `pass: true` artifact
- **AND** existing FRG live-loop / attestation rules remain in force
