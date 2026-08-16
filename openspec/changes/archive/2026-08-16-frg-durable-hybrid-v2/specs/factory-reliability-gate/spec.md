## ADDED Requirements

### Requirement: Durable hybrid v2 SHALL split required-live proof from a closed Layer A-allowed set

The FRG pack manifest and scorer SHALL encode a **durable hybrid v2** proof policy
that is not pinned to one SemVer. Every required pack scenario id and every
required composition dimension id SHALL have exactly one proof owner in one of
two disjoint sets:

1. **Required-live / ledger / derived** — MUST be observed on the **candidate**
   pack loop for the scored version: `clean-item-throughput`,
   `blocker-taxonomy`, `empty-depends-on-stack-honesty`, and at least one
   OpenSpec-bearing composition item (`openspec-bearing-item`).
2. **Layer A-allowed** — a **closed** set of named hermetic probes hashed to
   **this candidate SHA**, same class as the historical 1.33.0 `pilot_probes`.
   The closed scenario set is: `capacity-blocked-retain`, `resume-mid-flight`,
   `openspec-multi-change`, `implement-lockfile-dirt`, `local-docs-parity`,
   `pr-supersession`, and `release-plan-row` (including the auto-tag guard
   probe). Remaining required composition dimensions that the 1.33.0 matrix
   already mapped to those probes (including fix→re-review, concurrency
   contention, managed worktree dirt, process-restart hydration, forge HTTP
   5xx backoff, CI pending/red recovery, same-HEAD no-op re-entry, capacity
   live-run coexistence, and recovery-controller one-item / multi-item entry)
   SHALL stay Layer A-allowed. The set SHALL NOT grow without a later spec
   change.

Required-live ids SHALL use proof source `live`, `ledger`, or `derived` as
appropriate to the id. They SHALL NOT use source `layer_a`. Layer A-allowed
ids MAY use source `layer_a` only when a named probe from the closed set
reports the exact named test as passed and not skipped on the unchanged clean
candidate commit, with a hash of the actual TAP output bound to that SHA.

Hybrid Layer A provenance SHALL remain **refused** for ids that are not on the
closed Layer A-allowed set. The collector and scorer SHALL NOT accept a
caller-authored pass, scenario status, metric, evidence receipt, or all-pass
observation file as authority for either set.

This policy **succeeds** the 1.33.0-only hybrid v1 expiry. v1.33.0 evidence
bound to hybrid v1 remains historically valid for that version only. The scorer
SHALL resolve the expected pack-manifest SHA and closed Layer A probe matrix by
policy id: historical `factory-gate-v1-hybrid-v1` uses the frozen pre-v2
manifest identity; current `factory-gate-v1-hybrid-v2` uses the current
manifest identity. Relabeling current-manifest provenance as hybrid v1 SHALL
NOT satisfy historical v1.

#### Scenario: Historical hybrid v1 evidence with the frozen v1 manifest SHA remains valid

- **WHEN** a `1.33.0` evidence artifact binds policy `factory-gate-v1-hybrid-v1`
- **AND** its `pack_provenance.manifest_sha256` is the frozen pre-v2 hybrid-v1
  manifest SHA
- **AND** the closed v1 probe matrix and required-live / Layer A split hold
- **THEN** hybrid proof validation SHALL accept that artifact for version
  `1.33.0`
- **AND** SHALL refuse the same v1 policy identity when the SHA is the current
  v2 manifest SHA
- **AND** SHALL refuse that v1 artifact for any version other than `1.33.0`

#### Scenario: Required-live not_observed fails overall pass

- **WHEN** the FRG scorer scores a candidate pack run
- **AND** any required-live scenario or the required OpenSpec-bearing
  composition item has status `not_observed`
- **THEN** the report SHALL set overall `pass: false`
- **AND** valid TAP hashes for Layer A-allowed probes SHALL NOT make the
  evidence release-eligible

#### Scenario: Layer A-allowed proven by candidate TAP hash can pass

- **WHEN** required-live ids are observed on the candidate pack loop
  (`clean-item-throughput` and `blocker-taxonomy` from the ledger,
  `empty-depends-on-stack-honesty` derived, OpenSpec-bearing composition
  from the live pack item)
- **AND** every Layer A-allowed probe reports the exact named test as passed
  and not skipped on the same clean candidate commit
- **AND** the TAP output hash is bound to that candidate SHA
- **AND** existing numeric thresholds, representative composition, pack
  identity, loop provenance, and attestation criteria are met
- **THEN** the scorer MAY produce release-eligible `pass: true` for a version
  other than `1.33.0`
- **AND** each Layer A-allowed outcome SHALL record source `layer_a`
- **AND** no report SHALL describe a Layer A probe as a live production fault
  injection

#### Scenario: Unknown id as layer_a is refused

- **WHEN** a scenario or composition id that is not on the closed Layer
  A-allowed set claims source `layer_a`, or a probe id outside the closed
  manifest list is offered as Layer A proof
- **THEN** the collector or scorer SHALL refuse that provenance
- **AND** SHALL NOT treat the claim as proof of that id
- **AND** SHALL NOT emit release-eligible `pass: true` from that claim

#### Scenario: Missing skip or mismatched TAP fails the Layer A probe

- **WHEN** a Layer A-allowed probe is missing, skipped, fails, lacks the exact
  named TAP pass, runs on another commit, moves or dirties the checkout, or
  has an unreadable output digest
- **THEN** the collector SHALL refuse the mapped outcomes
- **AND** that probe SHALL fail
- **AND** overall FRG pass SHALL be false or refused

#### Scenario: Hybrid v2 is not a one-version waiver

- **WHEN** the target release is `1.34.0` or any later version
- **AND** required-live is observed on that version's candidate pack loop
- **AND** every closed Layer A-allowed probe is proven by TAP hash on that
  same candidate SHA
- **THEN** hybrid Layer A provenance for the closed set SHALL NOT be refused
  solely because the version is not `1.33.0`
- **AND** a 1.33.0 hybrid v1 policy id, 1.33.0-only release pin, or earlier
  candidate SHA SHALL NOT satisfy the later version

#### Scenario: Caller-authored pass is still refused

- **WHEN** a prepare request, observation input, or verified bundle includes a
  caller-supplied `pass: true`, scenario status map, metric, or evidence
  receipt intended to short-circuit scoring
- **THEN** the collector and scorer SHALL ignore or reject that field per the
  closed schema
- **AND** only runner-derived live/ledger/derived evidence and closed Layer A
  TAP hashes MAY contribute to a release-eligible pass

### Requirement: FRG runbook SHALL document durable hybrid v2 as current policy

The checked-in FRG runbook SHALL replace the hybrid-expiry paragraph that
forbids Layer A provenance after v1.33.0 with durable hybrid v2: required-live
must be observed on the candidate pack loop; Layer A-allowed may prove from
named TAP hashes on this candidate SHA; `not_observed` fails required-live
only; unknown `layer_a` ids are refused; caller-authored pass is refused.
The runbook SHALL keep v1.33.0 hybrid v1 as a historical note. It SHALL NOT
describe Layer A probes as live fault injection.

#### Scenario: Runbook states the two-set split

- **WHEN** an operator reads the FRG runbook hybrid section
- **THEN** it SHALL name the required-live ids and the closed Layer A-allowed
  set
- **AND** SHALL state that `not_observed` fails required-live only
- **AND** SHALL state that Layer A TAP hashes must bind to the current
  candidate SHA
- **AND** SHALL mark v1.33.0 hybrid v1 as historical

---

## MODIFIED Requirements

### Requirement: The FRG SHALL exercise a fixed multi-item scenario pack

Every FRG run (live Layer B) SHALL exercise a **fixed scenario pack** that proves multi-item
composition behavior, not only single-issue advance. The pack SHALL include at least the following
named scenarios (ids stable for scoring and tests):

1. `capacity-blocked-retain` — capacity under blocked retain does not false-block eligible work as
   needs-human solely for capacity
2. `resume-mid-flight` — supervisor kill/resume leaves every in-flight item with a live next action;
   no permanent dead `pr_opened` strand
3. `openspec-multi-change` — partial archive / foreign active change: archive result and residual
   still-active check agree
4. `implement-lockfile-dirt` — implement leaving uncommitted lockfile after HEAD advances is folded
   or cleaned without human-blocking known lock dirt at zero attempts
5. `local-docs-parity` — docs/generator checks that would fail on CI fail before PR open (or before
   ready-to-deploy)
6. `clean-item-throughput` — at least K easy items reach `pipeline:ready-to-deploy` without
   engine-class block
7. `blocker-taxonomy` — scoreboard of engine-class vs product-class vs human-authority; engine-class
   rate above threshold fails the gate
8. `pr-supersession` — a stale second PR for the same issue does not remain open after a new head
9. `release-plan-row` — release-cut path has plan-row present or scaffolded and documents the tag path
10. `empty-depends-on-stack-honesty` — items with empty `depends_on` that still stack OpenSpec
    changes across branches produce a warn or fail (process honesty)

The pack SHALL NOT require the full product milestone as its work-list. Exact numeric thresholds
for K, capacity stress N, and maximum engine-class rate SHALL be defined in the FRG runbook as
numbers and SHALL be checked by the FRG driver.

#### Scenario: Scenario pack inventory is fixed and named

- **WHEN** the FRG runbook and driver configuration are inspected
- **THEN** they SHALL list the stable scenario ids above (or a documented superset)
- **AND** each id SHALL map to pass criteria that are numeric or boolean, not free-form narrative only

#### Scenario: Product milestone is not required as the work-list

- **WHEN** an operator runs the live FRG for a release version
- **THEN** the driver SHALL select a dedicated synthetic work-list, labeled fixtures, or a known
  reliability-selector pack
- **AND** SHALL NOT require the full product milestone backlog to be in-scope for a valid FRG run

#### Scenario: Empty depends_on stacking is surfaced

- **WHEN** the live FRG work-list contains items with empty `depends_on` that still introduce stacked
  OpenSpec changes across branches during the run
- **THEN** the FRG report SHALL record a warn or fail for scenario
  `empty-depends-on-stack-honesty`
- **AND** SHALL NOT silently omit that condition from the scoreboard

#### Scenario: Unobserved required scenarios fail the gate

- **WHEN** the FRG driver scores a run and any **required-live** pack scenario
  (`clean-item-throughput`, `blocker-taxonomy`,
  `empty-depends-on-stack-honesty`) or the required OpenSpec-bearing
  composition item lacks verifiable live/ledger/derived evidence (status
  `not_observed`)
- **THEN** the report SHALL set overall `pass: false`
- **AND** SHALL NOT treat throughput-only success as a release-usable FRG pass
- **AND** `not_observed` SHALL fail required-live only
- **AND** a Layer A-allowed id MAY remain unobserved on the live loop when a
  valid same-candidate TAP hash proves that closed probe

#### Scenario: Required scenarios cannot be skipped without failing the gate

- **WHEN** a required pack scenario is recorded with status `skip`
- **THEN** the driver SHALL treat that scenario as failing overall pass
- **AND** SHALL NOT accept caller status overrides of `skip` as pass-permitting for Layer B
  required scenarios

#### Scenario: Capacity stress N is machine-validated from observations

- **WHEN** scenario `capacity-blocked-retain` claims status `pass`
- **AND** its observed blocked-retain count is missing or strictly less than threshold N
  (`capacity_stress_n`)
- **THEN** the driver SHALL set that scenario to `fail` (or refuse overall `pass: true`)
- **AND** SHALL NOT accept a bare status override as proof that capacity stress was exercised

#### Scenario: Non-pack durable loop is refused as FRG evidence

- **WHEN** an operator runs the FRG driver with `--from-run` against a durable loop whose contract
  selector is not the versioned FRG fixed pack (for example a product milestone or ad-hoc work-list)
- **THEN** the driver SHALL refuse to write a passing FRG evidence artifact for a release version
- **AND** SHALL surface that the run is not the fixed factory-gate pack

### Requirement: FRG Layer B live driver SHALL produce machine-readable pass or fail evidence

The pipeline SHALL provide a scripted FRG driver command (for example `pipeline factory-gate` or
`pipeline release-check --for <version>`) that starts a multi-item durable loop against the fixed
scenario pack (or documented selector), uses documented concurrency settings, and writes an
immutable evidence report. The report SHALL be parseable as a single JSON object (file and/or
stdout with `--json`) containing at least: `schema_version`, `version`, `run_id`, `pass` (boolean),
`scenarios` (per-scenario outcomes), `scoreboard` (including engine-class / product-class /
human-authority counts or rates), and `thresholds` applied. The driver SHALL exit non-zero when
`pass` is false or when required evidence cannot be produced. Pass/fail SHALL be machine-checkable
from durable loop ledger and events where possible; human judgment SHALL be limited to
intentionally injected product-class holds defined by the pack.

#### Scenario: Driver emits a parseable pass report

- **WHEN** the live FRG driver completes a successful pack run for version `1.29.1`
- **THEN** it SHALL write evidence including `version: "1.29.1"`, a unique `run_id`, `pass: true`,
  per-scenario outcomes, and a scoreboard
- **AND** `JSON.parse` of the machine-readable report SHALL succeed

#### Scenario: Incomplete evidence schema is rejected

- **WHEN** an FRG evidence artifact claims `pass: true` but omits the required named scenario
  inventory, numeric thresholds, scoreboard metrics, or timestamps, or declares `pass: true` while
  any **required-live** scenario is `fail`, `not_observed`, or `skip`, or while any Layer
  A-allowed scenario is `fail` or `skip`, or while any Layer A-allowed scenario is
  `not_observed` without a valid same-candidate TAP proof, or omits a non-empty durable
  `loop_run_id` or validated fixed-pack `pack_id`, or claims capacity pass without observed ≥ N
- **THEN** runtime validation SHALL reject the artifact as unparsable against the expected FRG schema
- **AND** the release FRG precondition SHALL remain unsatisfied

#### Scenario: Engine-class rate above threshold fails the gate

- **WHEN** the live FRG scoreboard computes an engine-class blocker rate strictly greater than the
  runbook threshold
- **THEN** the report SHALL set `pass: false`
- **AND** the driver SHALL exit non-zero
- **AND** the report SHALL name the threshold and observed rate

#### Scenario: Clean-item throughput below K fails the gate

- **WHEN** fewer than K pack items reach `pipeline:ready-to-deploy` without an engine-class block
- **THEN** the report SHALL set `pass: false` for scenario `clean-item-throughput`
- **AND** the overall `pass` SHALL be false

#### Scenario: Driver reuses the durable loop runtime

- **WHEN** the live FRG driver starts a multi-item run
- **THEN** it SHALL drive the shipped durable loop / `pipeline:loop` composition path
- **AND** SHALL NOT create a second authoritative ledger, lock namespace, or alternate advance engine
  for the pack items

#### Scenario: Same driver and runbook are reused across releases

- **WHEN** operators run FRG for version `X.Y.Z` and later for version `X.Y+1.0` (or next release)
- **THEN** both runs SHALL use the same FRG driver entrypoint and runbook procedure
- **AND** each version SHALL have its own evidence artifact keyed by that version

### Requirement: The v1.33.0 pilot MAY use candidate-bound Layer A proof for unsafe fault classes

For release v1.33.0 only, pack `factory-gate-v1` MAY prove fault classes that have no safe production injection seam with a closed manifest list of exact Layer A probes under historical hybrid v1. Live proof remains mandatory for fresh manifest issues, the exact loop item set, two clean ready items, blocker taxonomy, one real OpenSpec-bearing item, pull-request heads, and final checks. The runner SHALL execute every Layer A probe from the same clean candidate commit. It SHALL construct each command from the manifest and SHALL NOT accept a caller-supplied status, metric, receipt, or pass result. This historical hybrid v1 rule applies to v1.33.0 evidence only. Later releases SHALL use durable hybrid v2 (required-live vs closed Layer A-allowed hashed to the current candidate SHA). Later releases SHALL NOT reuse v1.33.0 hybrid v1 policy identity, 1.33.0-only release pins, or 1.33.0 candidate artifacts. Later releases SHALL still generate FRG evidence through the durable candidate-native path (`pipeline factory-release prepare` and the fixed pack / `pipeline factory-gate` scorer) from the exact integrated candidate.

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
- **THEN** historical hybrid v1 (`factory-gate-v1-hybrid-v1` pinned to release `1.33.0`) SHALL NOT satisfy that later version
- **AND** the wrapper SHALL NOT reinterpret static bootstrap or candidate-version config as current proof
- **AND** durable hybrid v2 and the durable factory-release prepare path SHALL apply through the fixed pack and scorer
- **AND** a synthetic trivial-docs or fixture-only pack SHALL NOT satisfy release-eligible FRG generation

#### Scenario: Unverified probe output fails closed

- **WHEN** a probe is missing, skipped, fails, lacks the exact named TAP pass, runs on another commit, moves or dirties the checkout, or has an unreadable output digest
- **THEN** the collector SHALL refuse the mapped outcomes
- **AND** it SHALL NOT produce a passing observation for those outcomes

### Requirement: The durable FRG generator SHALL construct all probes and refuse caller-authored pass claims

The durable FRG generation path SHALL construct every probe, action, and observation input itself from the pack manifest, durable loop ledger, and concrete run artifacts. It SHALL NOT accept a caller-authored pass claim, scenario status, metric, evidence receipt, or all-pass observation file as authority for scoring. Production collection SHALL continue to forbid test-only required-observation or required-composition overrides.

#### Scenario: Caller-authored pass is ignored or rejected

- **WHEN** a prepare request or observation input includes a caller-supplied `pass: true`, scenario status map, metric, or evidence receipt intended to short-circuit scoring
- **THEN** the generator and scorer SHALL ignore or reject that field per the closed schema
- **AND** only runner-derived evidence MAY contribute to a release-eligible pass

#### Scenario: Missing required scenario evidence fails closed

- **WHEN** any **required-live** pack scenario or the required OpenSpec-bearing
  composition item lacks verifiable runner-derived live/ledger/derived
  evidence, or is recorded as `fail`, `skip`, `not_observed`, or an unsupported
  waiver
- **THEN** overall FRG pass SHALL be false or refused
- **AND** release preparation SHALL NOT proceed to a complete release PR for that request

#### Scenario: Missing Layer A-allowed TAP proof fails closed

- **WHEN** any Layer A-allowed probe lacks a valid TAP hash on the current
  candidate SHA, or is recorded as `fail`, `skip`, mismatch, or an unsupported
  waiver
- **THEN** overall FRG pass SHALL be false or refused
- **AND** a live-loop `not_observed` for that Layer A-allowed id SHALL NOT by
  itself be the failure reason when a valid same-candidate TAP proof exists
