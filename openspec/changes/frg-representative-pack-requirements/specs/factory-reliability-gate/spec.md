## ADDED Requirements

### Requirement: Release-eligible FRG pass SHALL enforce representative pack composition

A release-eligible FRG evidence artifact with `pass: true` SHALL prove **representative pack
composition**, not merely clean-item throughput at K. The driver SHALL require verifiable
evidence that the scored pack satisfied **all** of the following minimum dimensions:

1. **OpenSpec-bearing item** — at least one pack item carried a real OpenSpec change through
   archive/coherence paths (not comment-only or docs-only no-op work).
2. **Fix → re-review cycle** — at least one pack item traversed a blocking review finding, a fix
   round, and re-review (not a path that never entered blocking review).
3. **Concurrency with worktree contention** — the pack run exercised multi-item concurrency with
   observed worktree contention satisfying N≥2 (`capacity_stress_n` or equivalent observed
   concurrency metric).
4. **Recovery and composition classes** — the pack inventory (runbook + driver) names and the
   release-eligible run observes or hermetically covers: missing and dirty managed worktrees;
   process death followed by fresh-process restart/hydration; forge HTTP 5xx with bounded
   backoff; pending/red CI with bounded recovery; same-HEAD no-op re-entry; concurrent capacity
   pressure and live-run coexistence.
5. **Autonomous recovery controller (#787)** — the production recovery controller is exercised
   through both a one-item entry point and a multi-item entry point during the pack run (or
   documented Layer B procedure scored into the same evidence).

A pack composed solely of clean comment-only / trivial no-op items (the #749/#750 class) SHALL
NOT satisfy release-eligible pass even when K clean-ready items and other numeric thresholds
would otherwise pass. The driver SHALL record a machine-readable failure reason naming each
missing composition dimension. Legacy clean-only fixtures SHALL be documented as retired and
non-representative in the FRG runbook.

#### Scenario: Clean-only pack fails representative composition

- **WHEN** the FRG driver scores a fixed-pack loop whose items are only comment-only or trivial
  no-op composition work with no OpenSpec change and no fix → re-review cycle
- **THEN** the driver SHALL set overall `pass: false` (or refuse release-eligible pass)
- **AND** the evidence or error SHALL name the missing representative composition dimensions
- **AND** satisfying K clean-ready alone SHALL NOT yield release-eligible `pass: true`

#### Scenario: OpenSpec-bearing and fix-rereview dimensions are both required

- **WHEN** a pack run has concurrent N≥2 contention and K clean-ready items
- **AND** it lacks either a real OpenSpec-bearing item or a blocking-finding → fix → re-review
  cycle
- **THEN** release-eligible `pass: true` SHALL be refused
- **AND** the missing dimension(s) SHALL be named in the failure detail

#### Scenario: Representative pack with required dimensions can pass

- **WHEN** a scored pack provides verifiable evidence for OpenSpec-bearing work, a fix →
  re-review cycle, N≥2 worktree contention, the required recovery/composition classes, and
  one-item plus multi-item recovery-controller entry
- **AND** numeric thresholds (K, N, max engine-class rate) and other existing scenario criteria
  are met
- **THEN** representative composition SHALL NOT alone block release-eligible `pass: true`

#### Scenario: Runbook retires clean-only fixtures

- **WHEN** an operator reads the FRG runbook after this change
- **THEN** it SHALL document that #749/#750-class clean-only pack issues are non-representative
  and retired for release-eligible FRG
- **AND** SHALL describe the minimum representative dimensions above

---

### Requirement: Engine-class rate SHALL be computable whenever at least one pack item was processed

The FRG scoreboard `engine_class_rate` SHALL be a finite number in the closed interval `[0, 1]`
whenever `scoreboard.item_count` is greater than or equal to 1, and SHALL NOT be `null` in that
case. The rate denominator SHALL be **processed pack item count** (`item_count`): 

```text
engine_class_rate = engine_class_count / item_count
```

where `engine_class_count` is the number of scored pack items whose projected blocker class is
`engine-class` under the existing FRG blocker taxonomy. When no item is engine-class,
`engine_class_rate` SHALL be `0` (not “n/a”). CLI output and release-PR FRG sections SHALL NOT
print `Engine-class rate: n/a` when `item_count ≥ 1`. When `item_count` is 0, the run SHALL NOT
be release-eligible. The gate continues to fail when `engine_class_rate` is strictly greater
than `thresholds.max_engine_class_rate`. Product-class and human-authority counts remain on the
scoreboard for honesty and SHALL NOT serve as the rate denominator.

#### Scenario: Clean multi-item pack reports rate zero

- **WHEN** the driver scores a pack with `item_count ≥ 1` and zero engine-class items
- **THEN** `scoreboard.engine_class_rate` SHALL equal `0`
- **AND** CLI and PR formatting SHALL present a numeric rate (for example `0.0%`), not `n/a`

#### Scenario: Mixed pack uses item_count denominator

- **WHEN** a pack has 4 processed items and exactly 1 item classified engine-class
- **THEN** `scoreboard.engine_class_rate` SHALL equal `0.25`
- **AND** SHALL NOT equal `1.0` from a classified-blocker-only denominator when other items had
  no blocker class

#### Scenario: Rate above threshold still fails

- **WHEN** `engine_class_rate` is strictly greater than `thresholds.max_engine_class_rate`
- **THEN** the report SHALL set overall `pass: false` for the blocker-taxonomy criterion
- **AND** the driver SHALL exit non-zero for a live scoring run that writes that evidence

#### Scenario: Empty pack is not release-eligible

- **WHEN** scoring yields `item_count === 0`
- **THEN** the driver SHALL NOT produce release-eligible `pass: true` evidence

---

### Requirement: FRG evidence SHALL accumulate in a release-over-release trend ledger

Each durable Layer B FRG evidence write SHALL append a machine-readable trend-ledger entry so
operators can review K, ready-clean counts, engine-class rate, thresholds applied, and recovery
aggregates across releases without reconstructing history by hand. The ledger SHALL be
append-only (prior entries retained), including under concurrent writers on the same host:
append serialization SHALL use a path-scoped host-local lock (or equivalent durable append
primitive) and MUST NOT rely on a single shared temporary filename that concurrent renames can
clobber. The stable path SHALL be documented in the FRG runbook
(default: `.agent-pipeline/frg/trend-ledger.jsonl` under the repository root, or an equivalent
documented path). Each entry SHALL include at least: `version`, `run_id`, `loop_run_id` (when
present), `pass`, `pack_id` (when present), `created_at`, `item_count`, `ready_clean_count`,
`engine_class_count`, `engine_class_rate`, and a snapshot of applied thresholds. Recovery
aggregates (success, exhaustion, resume counts, elapsed time by canonical reason code), when
available from the pack run, SHALL be included or referenced so they feed release-over-release
review. Primary immutable `evidence.json` remains authoritative for a single version pass;
ledger append failure after a successful primary write SHALL be reported and SHALL NOT delete
already-written evidence (fail-soft for ledger I/O).

#### Scenario: Passing evidence write appends a ledger line

- **WHEN** the FRG driver successfully writes release evidence for version `1.30.0` with
  `run_id` `R`
- **THEN** the trend ledger SHALL gain a new entry containing `version: 1.30.0`, `run_id: R`,
  `pass`, item and rate fields, and thresholds
- **AND** prior ledger entries SHALL remain present

#### Scenario: Subsequent release retains prior history

- **WHEN** FRG evidence is later written for version `1.30.1`
- **THEN** the ledger SHALL contain both the `1.30.0` and `1.30.1` entries
- **AND** neither entry SHALL overwrite the other

#### Scenario: Ledger I/O failure does not delete evidence

- **WHEN** primary evidence.json has been written successfully
- **AND** appending the trend ledger fails
- **THEN** the driver SHALL report the ledger failure
- **AND** SHALL NOT delete the written evidence paths for that run

---

### Requirement: FRG runbook SHALL document bootstrap thresholds and representative pack procedure

The checked-in FRG runbook SHALL document: (1) that current numeric values K=`2` and
`max_engine_class_rate`=`0.25` are **bootstrap/provisional** values chosen for the first
mandatory gate, not multi-release empirical optima; (2) that changing those values is a
follow-on once the trend ledger has sufficient history (out of scope for the representative-pack
strengthening change); (3) the engine-class rate formula with `item_count` denominator; (4) the
trend ledger path and fields; (5) representative pack composition minimums and retirement of
clean-only fixtures; (6) the scenario-observation CLI surface; (7) recovery-controller exercise
expectations for one-item and multi-item entry.

#### Scenario: Runbook states bootstrap origin of K and rate cap

- **WHEN** an operator reads the FRG runbook threshold section
- **THEN** it SHALL state that K=2 and max engine-class rate 25% are provisional bootstrap
  values
- **AND** SHALL direct operators to the trend ledger for empirical review before tightening

#### Scenario: Runbook documents observation CLI and composition minimums

- **WHEN** an operator reads the Layer B procedure
- **THEN** the runbook SHALL name how to supply scenario observations via CLI
- **AND** SHALL list representative composition dimensions required for release-eligible pass

---

### Requirement: Scenario observations SHALL be suppliable through a documented factory-gate CLI surface

Operators SHALL be able to supply live scenario observations for non-auto-scored pack scenarios
through a documented `pipeline factory-gate` CLI surface (observation file and/or repeated
scenario flags). The surface SHALL map into the driver’s scenario-override path without requiring
ad-hoc in-process module scripting. Auto-scored scenarios (at least clean-item throughput and
blocker taxonomy from the ledger) SHALL continue to derive from pack outcomes. Test-only helpers
that mark every required scenario `pass` SHALL NOT be the supported operator path for minting
release-eligible evidence. The FRG runbook SHALL document the CLI flags, observation file schema,
and examples.

#### Scenario: Observation file is accepted on from-run scoring

- **WHEN** an operator runs `pipeline factory-gate --for X.Y.Z --from-run <id>` with a documented
  observations file that sets required scenario outcomes
- **THEN** the driver SHALL apply those observations when scoring
- **AND** SHALL NOT require the operator to import TypeScript modules to supply overrides

#### Scenario: Missing observations still fail unobserved required scenarios

- **WHEN** scoring runs without observations for a required non-auto-scored scenario and the
  ledger does not project that scenario
- **THEN** that scenario SHALL remain `not_observed` (or fail)
- **AND** overall release-eligible `pass: true` SHALL be refused

#### Scenario: Runbook documents the observation surface

- **WHEN** the FRG runbook is inspected
- **THEN** it SHALL document the observation CLI surface and file schema (or equivalent flag
  contract)

---

### Requirement: Layer A FRG waivers SHALL not cite closed tracking issues

For each required Layer A scenario class, the suite SHALL either (1) include a hermetic test that
fails when the defective composition is reintroduced, or (2) record an explicit waiver naming a
**still-open** tracking issue. A waiver that cites a closed issue (including historical citation
of closed #730 for `release-plan-row`) SHALL be treated as incomplete coverage and refreshed
before the change is done: either land a biting test or retarget the waiver to an open issue.
Silent gaps remain forbidden.

#### Scenario: Closed-issue waiver is rejected as incomplete

- **WHEN** the Layer A waiver inventory is inspected for `release-plan-row` or any required
  Layer A scenario
- **THEN** no waiver entry SHALL cite only a closed tracking issue without a replacement open
  issue or a landed hermetic test

#### Scenario: Refreshed coverage is explicit

- **WHEN** `release-plan-row` (or a successor scenario covering release-cut / tag-path honesty)
  is covered after refresh
- **THEN** either a hermetic test exists in the unit suite or the waiver names an open tracking
  issue
- **AND** the runbook waiver table matches that state

---

### Requirement: Representative FRG pack SHALL exercise the autonomous recovery controller without false human-authority projections

The representative pack SHALL drive the production autonomous recovery controller (the #787
controller path) through both one-item and multi-item entry points. Injected recoverable classes
(workflow, OpenSpec, CI, restart, capacity, forge 5xx, worktree dirt/missing, same-HEAD no-op)
SHALL require **bounded convergence** or typed exhaustion that feeds the engine-class scoreboard.
A release-eligible pass SHALL require **zero false product-judgment / `human_authority`
projections** for those injected recoverable classes (the controller MUST NOT mis-label
engine-owned recoverables as human authority solely from those injections). Recovery success,
exhaustion, resumes, and elapsed time by canonical reason code SHALL be available to the
computable engine-class rate path (via item classification) and to the trend ledger aggregates.

#### Scenario: One-item and multi-item controller entry are both required

- **WHEN** release-eligible FRG evidence claims `pass: true`
- **THEN** the evidence or composition record SHALL show the recovery controller was exercised
  on a one-item path and on a multi-item path
- **AND** absence of either path SHALL refuse release-eligible pass

#### Scenario: False human_authority projection fails the gate

- **WHEN** an injected recoverable class is projected as `human_authority` (or equivalent false
  product-judgment hold) without genuine human-authority grounds
- **THEN** the FRG scoreboard/composition check SHALL fail release-eligible pass
- **AND** the failure detail SHALL name the false projection class

#### Scenario: Recovery aggregates feed the trend ledger

- **WHEN** a pack run records recovery success, exhaustion, resume, or elapsed metrics by
  canonical reason code
- **THEN** those aggregates SHALL appear on the trend-ledger entry and/or evidence scoreboard
  for that run
- **AND** terminal engine-owned exhaustion SHALL contribute to engine-class item classification
  under existing taxonomy rules

---

### Requirement: Release-eligible FRG evidence SHALL carry a producer HMAC attestation

A release-eligible FRG evidence artifact with `pass: true` SHALL include
`integrity.attestation` with algorithm `hmac-sha256-v1` and a MAC over a canonical payload
binding every field that can affect release eligibility, at minimum: `schema_version`,
`version`, `run_id`, `loop_run_id`, `pack_id`, `pass`, `thresholds`, `scenarios`,
`scoreboard`, `composition`, recovery aggregates (when present), scoreboard fingerprint, and
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
