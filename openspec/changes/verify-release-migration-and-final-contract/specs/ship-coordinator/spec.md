## MODIFIED Requirements

### Requirement: The CLI SHALL provide one explicit ship coordinator

The CLI SHALL expose `pipeline ship --milestone vX.Y.Z` as the operator product command. When the milestone title is a semantic version (`vX.Y.Z` or `X.Y.Z`), the coordinator SHALL derive the release version from that title and SHALL NOT require a separate `--for` flag. It SHALL compose the existing integrated train in merge mode, bounded Pipeline recovery, and ship-final-delegation: exactly one call to independently complete `pipeline release`. It SHALL NOT reimplement stage dispatch, merge gates, release mutation, or retry taxonomy. It SHALL NOT compose factory-pack FRG, `release finish`, `release ensure-tag`, `engine-promote`, installation, promotion, or deployment as the live tail.

The command SHALL remain loop-isolated: `advance`, `single`, and `loop` SHALL never invoke it. Operator invocation of `pipeline ship --milestone` SHALL be sufficient authority to compose those existing loop-isolated surfaces. The command SHALL NOT require `--authorization` or a signed grant document.

The coordinator SHALL execute this phase order for a semver milestone: `train --merge` → exactly one complete-release delegation. Continuous ship SHALL stop after integration. It SHALL NOT invent a second merge policy. Historical optional-FRG, finish, and ship-promotion sequences SHALL remain identifiable as historical and SHALL NOT be the live procedure.

#### Scenario: One command composes existing lifecycle utilities

- **WHEN** an operator runs `pipeline ship --milestone v1.39.3`
- **THEN** the coordinator SHALL call the existing Pipeline implementations for train and complete release
- **AND** it SHALL NOT create a second issue scheduler, merge implementation, FRG scorer, release builder, or model router

#### Scenario: Milestone-only argv does not require a grant document

- **WHEN** an operator runs `pipeline ship --milestone v1.39.3` with no `--authorization` and no `--for`
- **THEN** the command SHALL admit and compose the ship phases
- **AND** it SHALL NOT exit for a missing grant file or a missing `--for`

#### Scenario: Advance surfaces do not acquire ship authority

- **WHEN** `pipeline advance`, `pipeline single`, or `pipeline loop` reaches
  `pipeline:ready-to-deploy`
- **THEN** it SHALL still stop without invoking the ship coordinator

#### Scenario: SemVer ship delegates once without promotion

- **WHEN** SemVer train integration completes
- **THEN** ship SHALL invoke complete release once and accept its post-metadata candidate `C`
- **AND** ship SHALL perform no separate factory-pack FRG, finish, tag, publication, promotion, installation, or deployment orchestration

### Requirement: Ship coordinator post-train phases SHALL execute the candidate engine

After `train --merge` is complete or resumed complete, in-engine `pipeline ship` SHALL run ship-final-delegation on the candidate engine bound to the SHA being released: exactly one independently complete `pipeline release`. The candidate engine SHALL be the control checkout at that SHA, or an explicit candidate install of that SHA. The coordinator SHALL obtain that root from the shared asynchronous resolve-and-prepare seam. Identity-only resolution SHALL NOT authorize leaf spawn. The live tail SHALL NOT run factory-pack FRG (`factory-release prepare` and `factory-gate`), `release finish`, or `release ensure-tag`.

When the operator started `pipeline ship` from the previous production-pin CLI, the coordinator SHALL keep that pin process as the durable coordinator and SHALL spawn the candidate engine for the complete-release leaf. It SHALL NOT re-exec `pipeline ship`. It SHALL NOT rerun train. Train SHALL remain on the production pin. `engine-promote` SHALL NOT be part of the live ship tail.

The coordinator SHALL fail closed before the complete-release leaf if it cannot resolve-and-prepare a matching runnable candidate engine. A failed resolution or failed candidate readiness SHALL persist the train checkpoint and SHALL NOT start release mutation. Setup failure, abandoned ownership, and lock uncertainty SHALL remain supervised lifecycle states (bounded treatment, Cooling, or External-condition wait) and SHALL NOT become generic blocked, needs-human, or terminal mechanical failure. They SHALL NOT create a DecisionRequest or AuthorityRequest. This requirement does not authorize `--skip-frg` as the default. It does not add a new recover recipe, `auto_merge`, a merge stage, or a special ship of the readiness gate.

#### Scenario: Production-pin ship switches to candidate after train

- **WHEN** an operator runs production-pin `pipeline ship --milestone v1.40.1`
- **AND** train completes with candidate SHA `C` whose version is `1.40.1`
- **THEN** the coordinator SHALL spawn complete `pipeline release` on the candidate engine at `C`
- **AND** it SHALL NOT open a metadata PR using the prior production-pin release helper as a second release engine

#### Scenario: Unresolvable candidate stops ship before release

- **WHEN** train is complete
- **AND** the coordinator cannot resolve a candidate engine matching the bound SHA
- **THEN** ship SHALL stop before complete `pipeline release`
- **AND** status SHALL name the candidate-engine identity defect
- **AND** persisted train evidence SHALL remain so a retry does not retrain

#### Scenario: Handoff does not re-enter ship or train

- **WHEN** the pin coordinator spawns the candidate for a post-train verb
- **THEN** the spawned argv SHALL be a leaf CLI verb
- **AND** it SHALL NOT be `pipeline ship --milestone`
- **AND** it SHALL NOT be `pipeline train`

#### Scenario: Candidate FRG pack converges prepare after attestation

- **WHEN** historical factory-pack FRG text is read
- **THEN** that factory-pack prepare and factory-gate sequence SHALL be identifiable as historical
- **AND** the live post-train tail SHALL NOT spawn `factory-release prepare` or `factory-gate`

#### Scenario: Coordinator-invoked tag runs candidate ensure-tag

- **WHEN** historical `release ensure-tag` text is read
- **THEN** that ensure-tag sequence SHALL be identifiable as historical
- **AND** the live post-train tail SHALL NOT spawn `release ensure-tag`

#### Scenario: Live tail does not run factory-pack or ensure-tag

- **WHEN** SemVer train is complete and ship enters the post-train tail
- **THEN** ship SHALL invoke complete release once
- **AND** it SHALL NOT spawn `factory-release prepare`, `factory-gate`, `release finish`, or `release ensure-tag` as the live procedure

#### Scenario: Unready candidate stops ship before leaf spawn

- **WHEN** train is complete
- **AND** a candidate-engine root matches the bound SHA
- **AND** resolve-and-prepare fails to prove candidate readiness
- **THEN** ship SHALL stop before complete `pipeline release`
- **AND** persisted train evidence SHALL remain so a retry does not retrain
- **AND** no candidate leaf command SHALL have spawned

#### Scenario: Setup failure is not needs-human

- **WHEN** in-engine `pipeline ship` fails closed on candidate setup or abandoned ownership
- **THEN** the outcome SHALL be a supervised lifecycle state (bounded treatment, Cooling, or External-condition wait)
- **AND** it SHALL NOT be generic blocked, needs-human, or terminal mechanical failure
- **AND** it SHALL NOT create a DecisionRequest or AuthorityRequest solely for that failure

## ADDED Requirements

### Requirement: Historical optional-FRG, finish, and ship-promotion SHALL remain identifiable as historical

Historical optional-FRG, `release finish` as a tag or publish owner, `release ensure-tag`, and ship-promotion instructions SHALL remain identifiable as historical. They SHALL NOT be the live `pipeline ship` procedure. Exact-candidate FRG SHALL remain owned by independently complete release. `engine-promote` SHALL remain a separate operator command and SHALL NOT be invoked by live ship-final-delegation.

#### Scenario: Historical ship-promotion is not the live tail

- **WHEN** an operator reads the live ship procedure
- **THEN** the procedure SHALL end at complete-release delegation
- **AND** factory-pack FRG, finish, ensure-tag, promotion, and install SHALL be identifiable as historical rather than required live steps

## REMOVED Requirements

### Requirement: Ship FRG generation for post-pilot releases SHALL use the durable engine path

**Reason:** Live ship-final-delegation does not own factory-pack FRG. Exact-candidate FRG is owned by independently complete release.

**Migration:** Operators follow complete `pipeline release`. Historical factory-pack FRG text remains labeled historical in operator docs.

### Requirement: Ship durable FRG handoff SHALL remain restart-safe and non-duplicating

**Reason:** Live ship no longer drives the durable factory-pack prepare and attestation protocol.

**Migration:** Restart safety for publication remains in complete release and `release.yml`. Historical factory-pack handoff text remains labeled historical.

### Requirement: Ship coordinator promote phase SHALL install to all hosts by default

**Reason:** Neither direct-release nor ship-final-delegation deploys, promotes, or installs.

**Migration:** Operators who need promotion after publication invoke `pipeline engine-promote` as a separate command. Historical ship-promotion text remains labeled historical.

### Requirement: Candidate ensure-tag SHALL prove the supplied OID is the merged release

**Reason:** Live complete release owns annotated-tag creation and publication. `release ensure-tag` is not the live command contract.

**Migration:** Direct-release creates or verifies the annotated tag at candidate `C`. Remaining `ensure-tag` dispatch, if any after #1560, is historical compatibility and is not the live ship tail.
