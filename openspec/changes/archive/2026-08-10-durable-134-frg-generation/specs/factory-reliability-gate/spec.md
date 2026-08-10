## MODIFIED Requirements

### Requirement: The v1.33.0 pilot MAY use candidate-bound Layer A proof for unsafe fault classes

For release v1.33.0 only, pack `factory-gate-v1` MAY prove fault classes that have no safe production injection seam with a closed manifest list of exact Layer A probes. Live proof remains mandatory for fresh manifest issues, the exact loop item set, two clean ready items, blocker taxonomy, one real OpenSpec-bearing item, pull-request heads, and final checks. The runner SHALL execute every Layer A probe from the same clean candidate commit. It SHALL construct each command from the manifest and SHALL NOT accept a caller-supplied status, metric, receipt, or pass result. This temporary rule SHALL expire after v1.33.0. Later releases SHALL NOT use the hybrid rule. Later releases SHALL generate genuine FRG evidence through the durable candidate-native path (`pipeline factory-release prepare` and the fixed pack / `pipeline factory-gate` scorer) from the exact integrated candidate.

#### Scenario: Candidate-bound hybrid evidence may pass for v1.33.0

- **WHEN** the two fresh pack issues complete in the exact live candidate loop
- **AND** the live evidence proves the exact item set, throughput, taxonomy, OpenSpec content, pull-request heads, and green checks
- **AND** every manifest Layer A probe reports the exact named test as passed and not skipped on the unchanged clean candidate commit
- **THEN** the collector MAY project the mapped fault outcomes with source `layer_a`
- **AND** the scorer MAY produce release-eligible v1.33.0 evidence only when the producer attestation binds the release, candidate commit, manifest, loop, issue set, and proof digests

#### Scenario: Layer A proof is not reported as a live injection

- **WHEN** a fault outcome comes from a candidate-bound hermetic probe
- **THEN** its proof source SHALL be `layer_a`
- **AND** no report, journal, or release evidence SHALL describe it as a live production fault injection

#### Scenario: Hybrid proof is not reusable after v1.33.0

- **WHEN** the target release is not exactly `1.33.0`
- **THEN** the hybrid rule SHALL fail closed
- **AND** the wrapper SHALL NOT reinterpret static bootstrap or candidate-version config as current proof
- **AND** the durable factory-release prepare path and full current FRG policy SHALL apply through the fixed pack and scorer
- **AND** a synthetic trivial-docs or fixture-only pack SHALL NOT satisfy release-eligible FRG generation

#### Scenario: Unverified probe output fails closed

- **WHEN** a probe is missing, skipped, fails, lacks the exact named TAP pass, runs on another commit, moves or dirties the checkout, or has an unreadable output digest
- **THEN** the collector SHALL refuse the mapped outcomes
- **AND** it SHALL NOT produce a passing observation for those outcomes

## ADDED Requirements

### Requirement: Durable post-pilot FRG generation SHALL create a fresh candidate pack from the exact integrated base

For every release version after v1.33.0, the engine SHALL generate FRG evidence by instantiating a fresh fixed-pack instance bound to the exact integrated candidate commit, the target release version, the pack manifest identity, and a unique run id. The generator SHALL refuse issues, observations, loop runs, or evidence artifacts that are bound to an earlier release version, a different manifest hash, a different candidate commit, or a different run. An earlier release’s FRG pass SHALL NOT satisfy a later release’s request.

#### Scenario: Fresh pack for a new release version

- **WHEN** durable FRG generation runs for version `1.34.0` at integrated candidate commit `C`
- **THEN** it SHALL create or reconcile a new pack instance bound to `1.34.0` and `C`
- **AND** it SHALL NOT reuse pack issues or observations from version `1.33.0` as release-eligible evidence for `1.34.0`

#### Scenario: Stale candidate or foreign run is refused

- **WHEN** supplied evidence names a different candidate commit, version, or run than the active request
- **THEN** the generator or scorer SHALL refuse release-eligible pass for that request
- **AND** it SHALL exit non-zero or return a non-complete status that blocks release preparation

### Requirement: The durable FRG generator SHALL construct all probes and refuse caller-authored pass claims

The durable FRG generation path SHALL construct every probe, action, and observation input itself from the pack manifest, durable loop ledger, and concrete run artifacts. It SHALL NOT accept a caller-authored pass claim, scenario status, metric, evidence receipt, or all-pass observation file as authority for scoring. Production collection SHALL continue to forbid test-only required-observation or required-composition overrides.

#### Scenario: Caller-authored pass is ignored or rejected

- **WHEN** a prepare request or observation input includes a caller-supplied `pass: true`, scenario status map, metric, or evidence receipt intended to short-circuit scoring
- **THEN** the generator and scorer SHALL ignore or reject that field per the closed schema
- **AND** only runner-derived evidence MAY contribute to a release-eligible pass

#### Scenario: Missing required scenario evidence fails closed

- **WHEN** any required pack scenario lacks verifiable runner-derived evidence, or is recorded as `fail`, `skip`, `not_observed`, or an unsupported waiver
- **THEN** overall FRG pass SHALL be false or refused
- **AND** release preparation SHALL NOT proceed to a complete release PR for that request

### Requirement: Durable FRG generation SHALL stop release preparation when evidence is not release-eligible

Missing, stale, failed, mismatched, skipped, or waived required FRG evidence for the target version SHALL stop before release preparation treats the version as ready. The path SHALL exit non-zero or return a non-`complete` status that names the version and the evidence defect class. Fabricated or synthetic trivial packs that do not exercise the fixed representative scenario inventory SHALL NOT unlock release preparation for versions after v1.33.0.

#### Scenario: Failed gate blocks prepare completion

- **WHEN** durable generation scores `pass: false` for version `1.34.0`
- **THEN** the command SHALL NOT return `status: "complete"` with a release PR
- **AND** it SHALL surface that FRG failed for `1.34.0`

#### Scenario: Synthetic trivial pack is not release-eligible after the pilot

- **WHEN** a ship or adapter attempts to satisfy FRG for version `1.34.0` using only a trivial docs or fixture-only pack that does not exercise the fixed representative scenarios
- **THEN** the durable path SHALL refuse release-eligible pass
- **AND** release preparation SHALL remain blocked
