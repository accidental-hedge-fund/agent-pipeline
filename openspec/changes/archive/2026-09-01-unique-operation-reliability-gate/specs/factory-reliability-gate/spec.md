## ADDED Requirements

### Requirement: Release-eligible FRG evidence SHALL include a versioned operation_reliability section

Release-eligible FRG evidence with `pass: true` SHALL include a versioned `operation_reliability` object bound to the candidate SHA, the release identity, the pack-manifest fingerprint, required entry-point coverage, unique-operation numerators and denominators, stable exclusions, integrity counts, and per-operation evidence references. The section SHALL be computed from durable run, event, loop-store, and handoff evidence. GitHub labels and comment prose SHALL NOT be the source of unique-operation success. Offline `scoreInput` without live provenance SHALL NOT become release-eligible merely by including this section.

#### Scenario: Release-eligible pass carries the section

- **WHEN** the FRG driver writes release-eligible evidence with `pass: true` for version `X.Y.Z`
- **THEN** the evidence SHALL contain `operation_reliability` with candidate SHA, release identity, manifest fingerprint, entrypoint coverage, numerators, denominators, exclusions, integrity counts, and per-operation evidence references

#### Scenario: Labels are not unique-operation proof

- **WHEN** pack issues are closed or labeled `pipeline:ready-to-deploy`
- **AND** correlated durable evidence for those logical operations is missing
- **THEN** the driver SHALL NOT treat label or closure state as verified unique-operation completion

#### Scenario: Stale-candidate run-store artifacts are not current-candidate proof

- **WHEN** durable run-store artifacts carry a candidate SHA other than the scored FRG candidate
- **OR** they lack an authoritative candidate SHA while a scored candidate is bound
- **THEN** those artifacts SHALL NOT satisfy unique-operation coverage, verified-completion numerators, or train linkage for the scored candidate
- **AND** the driver SHALL NOT stamp the current pack provenance onto unbound or other-candidate operations as if they were scored-candidate proof

#### Scenario: Caller-supplied operation_reliability is not durable proof

- **WHEN** a caller provides a precomputed `operation_reliability` object
- **AND** durable run, event, loop-store, and handoff evidence was not aggregated into that section
- **THEN** the driver SHALL NOT treat the supplied object as release-eligible unique-operation evidence
- **AND** offline `scoreInput` SHALL remain fail-closed

---

### Requirement: Unmet unique-operation SLOs SHALL fail FRG promotion and release preparation

The FRG driver and shared release-eligibility validator SHALL refuse `pass: true` and SHALL stop release preparation when any of the following hold: required clean operations did not reach verified completion without Manual reinvocation; false-human projection count is not zero; ownerless terminal count is not zero; an applicable exact-candidate recovery fixture failed; an applicable independent-sibling continuation fixture failed; correlation is missing or contradictory; required public entry-point coverage is missing. Those gaps SHALL be integrity or SLO failures. They SHALL NOT be recorded as stable exclusions.

#### Scenario: Missing correlation fails release-eligible pass

- **WHEN** a required FRG entry point ran without a `logical_operation_id` or with contradictory parent/child identities
- **THEN** overall FRG `pass` SHALL be false
- **AND** release preparation SHALL stop
- **AND** the evidence SHALL expose a missing-correlation or contradictory-correlation integrity count

#### Scenario: False-human projection fails the gate

- **WHEN** the #1333 mechanical fault matrix, once integrated, records a mechanical fault projected as human ownership
- **THEN** `operation_reliability` false-human count SHALL be greater than zero
- **AND** release-eligible `pass: true` SHALL be refused

#### Scenario: Ownerless terminal fails the gate

- **WHEN** an admitted FRG operation ends with neither verified success, durable cooling or recovery, external-condition wait, typed request, nor explicit cancellation
- **THEN** ownerless-terminal count SHALL be greater than zero
- **AND** release-eligible `pass: true` SHALL be refused

#### Scenario: Clean completion requires no Manual reinvocation

- **WHEN** a required clean FRG operation reaches verified completion only after an operator or supervisor reinvokes the public command without a valid resume binding
- **THEN** clean-completion without Manual reinvocation SHALL fail
- **AND** release-eligible `pass: true` SHALL be refused

---

### Requirement: FRG unique-operation scoring SHALL require integrated #1301 and #1333 proofs

Release-eligible FRG pass SHALL require the #1301 live train-loop linkage, collision-safe train run identity, and merge-proof events, and SHALL require the #1333 mechanical fault matrix to cover every required lifecycle class for the scored candidate. Absence of those proofs SHALL fail FRG promotion. This capability SHALL NOT create a second scheduler, recovery owner, or fault-matrix runner.

#### Scenario: Missing #1333 coverage fails promotion

- **WHEN** a required lifecycle class in the #1333 matrix is uncovered for the candidate
- **THEN** FRG promotion SHALL fail
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

#### Scenario: Missing #1301 live linkage fails promotion

- **WHEN** a train-driven nested loop has no followable `train_loop_linked` identity from the child `onRunReady` handoff
- **THEN** FRG promotion SHALL fail as missing correlation or missing required coverage
- **AND** the driver SHALL NOT guess the child run by latest-run lookup
- **AND** a `train_loop_linked` event that carries only the parent logical id SHALL NOT count as followable child linkage

---

### Requirement: FRG operation_reliability SHALL reuse composition false-human counts rather than a parallel classifier

Unique-operation false-human projection SHALL be derived from the same durable classification that feeds `composition.false_human_authority_count` and the existing blocker taxonomy. The FRG scorer SHALL NOT reclassify GitHub labels or comment prose into a second false-human total. `composition.false_human_authority_count === 0` SHALL remain required, and the unique-operation false-human count SHALL also be zero for release-eligible pass.

#### Scenario: Composition and unique-operation false-human counts agree

- **WHEN** an injected recoverable class is projected as human authority without genuine human-authority grounds
- **THEN** `composition.false_human_authority_count` SHALL be greater than zero
- **AND** `operation_reliability` false-human count SHALL be greater than zero
- **AND** release-eligible pass SHALL fail

## MODIFIED Requirements

### Requirement: Release-eligible FRG evidence SHALL carry a producer HMAC attestation

A release-eligible FRG evidence artifact with `pass: true` SHALL include
`integrity.attestation` with algorithm `hmac-sha256-v1` and a MAC over a canonical payload
binding every field that can affect release eligibility, at minimum: `schema_version`,
`version`, `run_id`, `loop_run_id`, `pack_id`, `pass`, `thresholds`, `scenarios`,
`scoreboard`, `composition`, `operation_reliability`, recovery aggregates (when present), scoreboard fingerprint, and
composition fingerprint. The driver SHALL mint the MAC only when the producer key
`PIPELINE_FRG_ATTESTATION_KEY` is available. Release-eligibility validation used by auto-tag
(and any shared tag/release validator) SHALL require the same env key and SHALL reject
evidence when the key is missing, the attestation is absent, or the MAC does not verify
(including when eligibility-defining fields were mutated after mint while fingerprints stay
intact). Self-consistent scoreboard/composition fingerprints alone SHALL NOT satisfy the tag
path: hand-authored JSON that recomputes public hashes without the producer secret SHALL fail
validation.

#### Scenario: Mint without producer key is not release-eligible

- **WHEN** the FRG driver scores a pack that would otherwise meet composition and numeric
  criteria
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset and no explicit attestation key is supplied
- **THEN** the driver SHALL NOT emit release-eligible `pass: true`
- **AND** `integrity.attestation` SHALL be omitted

#### Scenario: Tag validation rejects forged MAC or missing key

- **WHEN** auto-tag (or `validateReleaseEligibleFrgEvidence`) validates evidence for version
  `X.Y.Z`
- **AND** the artifact is schema-complete and fingerprint-consistent but the attestation MAC
  is missing, forged, or signed under a different key than `PIPELINE_FRG_ATTESTATION_KEY`
- **THEN** validation SHALL fail closed
- **AND** no tag create/push path that depends on that validation SHALL proceed

#### Scenario: Matching producer key accepts attested evidence

- **WHEN** evidence was minted with key K and includes a valid `integrity.attestation`
- **AND** tag validation uses the same key K
- **AND** all other release-eligibility criteria pass
- **THEN** validation SHALL accept the evidence as release-eligible

#### Scenario: Mutating operation_reliability after mint fails verification

- **WHEN** release-eligible evidence was minted with a valid MAC
- **AND** a caller later changes an `operation_reliability` numerator, denominator, or integrity count while leaving public fingerprints intact
- **THEN** tag and release-eligibility validation SHALL fail closed
