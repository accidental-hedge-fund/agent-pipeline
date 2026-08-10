# factory-reliability-gate Specification

## Purpose
TBD - created by archiving change release-mandatory-factory-reliability-gate. Update Purpose after archive.
## Requirements
### Requirement: Every release version SHALL require a recorded Factory Reliability Gate pass

The pipeline SHALL treat a **Factory Reliability Gate (FRG)** pass as a mandatory precondition for
shipping any release version (patch, minor, or major). An FRG pass for version `X.Y.Z` SHALL be a
recorded, machine-readable evidence artifact that names that version, a unique `run_id`, an overall
`pass: true` outcome, and the scoreboard metrics required by this capability. Unit CI success
(`npm run ci`) alone SHALL NOT satisfy the FRG precondition. Optional two-item pilots and
ad-hoc self-dev soaks SHALL NOT substitute for an FRG pass unless they are executed through the
FRG driver and produce a conforming FRG evidence artifact for that version.

#### Scenario: Green unit CI without FRG is insufficient for release precondition

- **WHEN** `npm run ci` is green for a candidate release version `X.Y.Z`
- **AND** no FRG evidence artifact with `version: X.Y.Z` and `pass: true` exists
- **THEN** the FRG precondition for `X.Y.Z` SHALL be unsatisfied
- **AND** the missing FRG SHALL be distinguishable from a recorded FRG failure

#### Scenario: Recorded FRG pass satisfies the precondition for that version only

- **WHEN** an FRG evidence artifact exists with `version: 1.29.1`, `pass: true`, a non-empty
  `run_id`, a non-empty durable `loop_run_id`, and validated fixed-pack provenance (`pack_id`)
- **THEN** the FRG precondition for version `1.29.1` SHALL be satisfied
- **AND** the FRG precondition for a different version `1.30.0` SHALL remain unsatisfied until a
  separate pass artifact for `1.30.0` exists

#### Scenario: Offline score without live loop is not release-eligible

- **WHEN** an operator or test scores FRG fixtures offline (for example `scoreInput`) without a
  non-empty durable `loop_run_id` and validated fixed-pack `pack_id`
- **THEN** the driver SHALL NOT treat the result as release-eligible `pass: true` evidence
- **AND** runtime validation SHALL reject `pass: true` artifacts that omit live-loop provenance
- **AND** offline scoring SHALL NOT persist evidence by default

---

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

- **WHEN** the FRG driver scores a run and any required pack scenario lacks verifiable evidence
  (status `not_observed`)
- **THEN** the report SHALL set overall `pass: false`
- **AND** SHALL NOT treat throughput-only success as a release-usable FRG pass
- **AND** `not_observed` SHALL be reserved for reports that cannot be used as release evidence

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

---

### Requirement: FRG Layer A hermetic scenarios SHALL run in CI without real I/O

The repository SHALL provide hermetic composition tests (Layer A) for FRG scenario classes that can
be exercised with injected dependency seams. Those tests SHALL run as part of the normal unit test
suite consumed by `npm run ci`. Layer A tests SHALL perform zero real network, git, or subprocess
calls. For each of `capacity-blocked-retain`, `resume-mid-flight`, `openspec-multi-change`,
`implement-lockfile-dirt`, and `local-docs-parity`, the suite SHALL either (1) include a hermetic
test that fails when the defective composition is reintroduced, or (2) record an explicit waiver
naming a tracking issue — silent gaps SHALL NOT be permitted.

#### Scenario: Hermetic tests perform no real I/O

- **WHEN** Layer A FRG scenario tests execute in the unit suite
- **THEN** they SHALL use injected fakes for gh, harness, worktree, and filesystem seams as needed
- **AND** they SHALL NOT perform real network, git, or subprocess calls

#### Scenario: Missing coverage requires an explicit waiver

- **WHEN** a required Layer A scenario class has no hermetic test
- **THEN** the FRG runbook or co-located waiver inventory SHALL name that scenario id and a tracking
  issue
- **AND** a silent omission of both test and waiver SHALL be treated as incomplete FRG coverage

#### Scenario: Capacity cascade assertion bites

- **WHEN** a hermetic test for `capacity-blocked-retain` runs with low max concurrent worktrees and
  induced blocked retain at or above N
- **AND** the system under test false-blocks the next eligible item as needs-human solely for capacity
- **THEN** the test SHALL fail

---

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
  any scenario is `fail`, `not_observed`, or `skip`, or omits a non-empty durable `loop_run_id` or
  validated fixed-pack `pack_id`, or claims capacity pass without observed ≥ N
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

---

### Requirement: The FRG runbook SHALL document procedure, thresholds, and evidence layout

The repository SHALL include a checked-in FRG runbook under `docs/` (or hosts skill documentation
mirrored for operators) that specifies: how to invoke the driver, concurrency settings, how the
scenario pack is selected or created, numeric thresholds (K, N, max engine-class rate), blocker
taxonomy definitions (engine-class vs product-class vs human-authority), evidence artifact path and
schema, how to attach evidence to a release PR, and the rule that no release tag ships without an
FRG pass for that version. Thresholds MAY tighten over time via runbook updates but MUST remain
numeric and checked.

#### Scenario: Runbook names numeric thresholds

- **WHEN** the FRG runbook is read
- **THEN** it SHALL state numeric values or clearly versioned numeric tables for K, N, and maximum
  engine-class rate
- **AND** SHALL NOT leave those pass criteria as qualitative-only guidance

#### Scenario: Runbook defines evidence location

- **WHEN** an operator completes a live FRG run per the runbook
- **THEN** the runbook SHALL specify a stable path or lookup rule for the evidence artifact and the
  fields required for release attachment (`run_id`, version, pass summary)

---

### Requirement: FRG evidence SHALL be attachable to the release PR

A completed FRG run SHALL produce evidence that can be linked or embedded on the release pull
request for the same version: at minimum the `run_id` and a pass/fail summary (and preferably the
artifact path or JSON digest). The attachment MAY be a PR comment, a section of the release PR body,
or a checked-in/CI-uploaded artifact referenced from the PR. Absence of any linkable FRG evidence
for the version SHALL leave the release FRG precondition unsatisfied even if a private local pass
is claimed without a durable record.

#### Scenario: Pass summary is linkable

- **WHEN** a live FRG for version `X.Y.Z` passes
- **THEN** the evidence SHALL include a `run_id` and `pass: true` suitable for pasting or automated
  posting onto the release PR for `X.Y.Z`

#### Scenario: Unrecorded local claim does not satisfy attachment

- **WHEN** an operator asserts FRG success without a durable evidence artifact containing `run_id`
  and `pass: true` for the version
- **THEN** the FRG attachment requirement SHALL be unsatisfied

---

### Requirement: FRG SHALL NOT introduce auto-merge

The Factory Reliability Gate SHALL NOT merge pull requests, enable auto-merge, or create a release
tag as a side effect of a passing FRG. Human ownership of merge and tag paths remains as specified
by existing release and golden-rule constraints. FRG observes factory outcomes and records
pass/fail; after a release-eligible pass it MAY close synthetic pack pull requests and issues
without merging as post-pass hygiene, subject to the pack auto-close scope and fail-soft
requirements. Close-without-merge SHALL NOT be treated as merge authority.

#### Scenario: Passing FRG does not merge

- **WHEN** a live FRG run reaches `pass: true`
- **THEN** the driver SHALL NOT merge any pull request
- **AND** SHALL NOT create a git tag for the version as a side effect of the FRG run itself

#### Scenario: Close-without-merge is allowed as pack hygiene

- **WHEN** a live FRG run reaches release-eligible `pass: true`
- **AND** post-pass pack disposition closes a synthetic pack PR without merging
- **THEN** that close SHALL be permitted as hygiene
- **AND** SHALL NOT be treated as introducing auto-merge or human merge authority

### Requirement: Release-eligible FRG pass SHALL auto-close synthetic pack PRs and issues without merging

The FRG driver SHALL, when it successfully writes release-eligible evidence with `pass: true`
(non-empty durable `loop_run_id`, validated fixed-pack `pack_id` matching the versioned pack
manifest, and scenario criteria met as required for release-eligible pass), perform post-pass pack
disposition: close without merging each open pull request associated with a scored pack item that
is `ready_clean: true` on `scoreboard.per_item[]` and still has an open PR, and close the linked
GitHub issue for those items when the issue is still open. Close comments SHALL be deterministic
and auditable, include the FRG target version and evidence `run_id`, and state that the synthetic
factory-gate pack item was scored ready-to-deploy and is being closed without merge. The driver
SHALL NOT merge any pull request, enable auto-merge, or enqueue a merge-queue entry as part of
this disposition.

#### Scenario: Release-eligible pass closes ready_clean pack PR and issue

- **WHEN** `pipeline factory-gate` writes release-eligible evidence with `pass: true` for version
  `X.Y.Z` and `run_id` `R`
- **AND** `scoreboard.per_item[]` contains an item with `ready_clean: true` that has an open PR
  and an open linked issue carrying the pack selector label
- **THEN** the driver SHALL close that PR without merging
- **AND** SHALL close that issue
- **AND** SHALL attach a deterministic comment on each closed resource that cites version `X.Y.Z`
  and `run_id` `R` and states closing without merge

#### Scenario: Multiple open PRs for one ready_clean item are all closed

- **WHEN** release-eligible evidence with `pass: true` is written
- **AND** a scored `ready_clean` pack item has more than one open associated PR (for example a
  replacement PR and an abandoned draft still linked to the same issue)
- **THEN** the driver SHALL close each of those open associated PRs without merging
- **AND** SHALL close the linked open issue when it still carries the pack selector label
- **AND** a close failure on one PR SHALL NOT prevent remaining PR closes for that item
  (fail-soft per PR)

#### Scenario: Non-pass does not close pack artifacts

- **WHEN** the FRG driver produces evidence with `pass: false`
- **THEN** the driver SHALL NOT close pack PRs or issues as a side effect of that scoring run

#### Scenario: Non-release-eligible score does not close pack artifacts

- **WHEN** FRG scoring is not release-eligible (for example missing non-empty `loop_run_id` or
  validated fixed-pack `pack_id`) even if scenario outcomes would otherwise look successful
- **THEN** the driver SHALL NOT close pack PRs or issues as post-pass disposition

#### Scenario: Passing FRG still never merges

- **WHEN** post-pass pack disposition runs after a release-eligible `pass: true`
- **THEN** the driver SHALL NOT call merge on any pull request
- **AND** SHALL NOT enable auto-merge or enqueue merge-queue as a side effect of the FRG run

---

### Requirement: FRG pack auto-close SHALL hard-limit scope to scored pack items

Post-pass pack disposition SHALL close only resources that satisfy **all** of the following:
(1) the item appears on the scored run’s work-list / `scoreboard.per_item[]` for that FRG evidence
run, (2) the linked issue carries the pack selector label used for the fixed pack (the
`factory-gate` label or the documented pack selector validated for that run), and (3) the resource
is still open at close time. The driver SHALL NOT perform a repo-wide close of all
`factory-gate`-labeled issues or PRs, and SHALL NOT close product-milestone or other non-pack
items solely because they ran on the same host or in a different loop.

#### Scenario: Non-pack labeled item is never closed

- **WHEN** post-pass disposition considers an issue that does not carry the pack selector label
  for the scored run
- **THEN** the driver SHALL NOT close that issue
- **AND** SHALL NOT close any PR solely because it was associated with that non-pack issue

#### Scenario: Item absent from scored scoreboard is never closed

- **WHEN** an open issue carries the `factory-gate` label but is not present on the scored run’s
  work-list / `scoreboard.per_item[]` for the evidence being written
- **THEN** the driver SHALL NOT close that issue or its PRs as part of that FRG pass disposition

#### Scenario: Already-closed resources are skipped without failure

- **WHEN** a candidate pack PR or issue is already closed at disposition time
- **THEN** the driver SHALL skip that resource without treating the overall FRG pass as failed

---

### Requirement: FRG pack auto-close failures SHALL be fail-soft

A GitHub close or comment failure during post-pass pack disposition SHALL be reported to the
operator (stderr and/or structured run messaging) and MAY be summarized in CLI output or an
auditable note that does not rewrite `pass`. Such a failure SHALL NOT flip a recorded FRG
`pass: true` to fail, SHALL NOT delete or invalidate already-written evidence artifacts, and
SHALL NOT alone force a non-zero process exit when the scored evidence is `pass: true`. FRG
scoring remains authoritative; close is post-pass hygiene.

#### Scenario: Close error leaves pass and evidence intact

- **WHEN** release-eligible evidence with `pass: true` has been written
- **AND** closing one eligible pack PR or issue fails with a GitHub/API error
- **THEN** the driver SHALL report the failure
- **AND** the evidence artifact SHALL remain with `pass: true`
- **AND** the driver SHALL NOT delete the written evidence paths for that run
- **AND** remaining eligible closes MAY still be attempted (best-effort)

---

### Requirement: FRG driver SHALL offer opt-out of pack auto-close

The FRG driver CLI SHALL provide a flag (for example `--no-close-pack` or `--keep-pack-open`) that
skips post-pass pack disposition entirely for that invocation. When the flag is set, a
release-eligible `pass: true` run SHALL still write evidence and exit according to scoring rules
but SHALL NOT close pack PRs or issues. Default behavior without the flag SHALL perform auto-close
on release-eligible pass as specified by the post-pass disposition requirements.

#### Scenario: Opt-out skips closes on pass

- **WHEN** an operator runs the FRG driver with the pack auto-close opt-out flag
- **AND** the run writes release-eligible evidence with `pass: true`
- **THEN** the driver SHALL NOT close pack PRs or issues for that invocation
- **AND** evidence `pass: true` SHALL still be written according to scoring rules

---

### Requirement: FRG runbook SHALL document post-pass pack auto-close

The checked-in FRG runbook SHALL document that a release-eligible FRG pass auto-closes synthetic
pack open PRs and linked open issues without merging; that merge is never part of FRG; when
operators should use the opt-out flag (debugging, intentional provenance land); and that product
milestones / non-pack work are out of scope for this disposition.

#### Scenario: Runbook states close-without-merge on pass

- **WHEN** an operator reads the FRG runbook
- **THEN** it SHALL state that release-eligible pass auto-closes synthetic pack PRs/issues
  without merge
- **AND** SHALL name or describe the opt-out flag
- **AND** SHALL state that product-milestone items are not closed by FRG disposition

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

### Requirement: FRG Layer B SHALL be the designated candidate-track soak for promote eligibility

A live FRG Layer B run that exercises a release candidate engine build SHALL execute and record
evidence on the **candidate** engine track. The FRG driver SHALL ensure the resulting evidence
artifact continues to name the candidate `version` under test. An FRG `pass: true` for that
version is the eligibility signal for promoting the factory production pin to that version; the
FRG driver MAY offer an explicit opt-in promote step or command after pass, but SHALL NOT promote
silently without operator-visible action when a pin write would modify the repository. FRG
SHALL NOT merge pull requests, create git tags, or enable auto-merge as part of promote.

#### Scenario: Layer B soak is labeled candidate

- **WHEN** the FRG Layer B driver runs against a candidate engine for version `1.30.0`
- **THEN** the associated run evidence SHALL record engine track `candidate`
- **AND** the FRG evidence artifact SHALL name version `1.30.0`

#### Scenario: Pass is promote-eligible but not an autonomous merge

- **WHEN** FRG evidence for version `1.30.0` is recorded with `pass: true`
- **THEN** that artifact SHALL be sufficient eligibility for a subsequent production-pin promote
  of `1.30.0`
- **AND** the FRG driver SHALL NOT merge any PR or create any git tag as a side effect of
  recording the pass

#### Scenario: Failed FRG is not promote-eligible

- **WHEN** FRG evidence for version `1.30.0` exists with `pass: false`
- **THEN** the production pin SHALL NOT be promoted to `1.30.0` on the basis of that artifact

---

### Requirement: FRG documentation SHALL describe candidate soak vs pinned production dogfood

The FRG runbook (or a clearly linked two-track section) SHALL state that: (1) factory production
and dogfood loops run the **pinned** last-promoted FRG-passed release; (2) FRG Layer B soaks the
**candidate** until pass; (3) promote updates the production pin and requires reinstall from the
new tag; (4) rollback repoints the pin to a previous FRG-passed release and reinstalls. The
runbook SHALL NOT describe FRG pass as authorizing auto-merge.

#### Scenario: Runbook distinguishes pinned dogfood from candidate FRG

- **WHEN** an operator reads the FRG runbook two-track section
- **THEN** it SHALL state that production dogfood uses the pinned install
- **AND** SHALL state that Layer B exercises the candidate until FRG pass promotes the pin

### Requirement: Resolved fixed-pack selector provenance SHALL survive native loop compilation

When a fresh native loop resolves a supported label or milestone selector to a fixed issue list, the immutable loop contract SHALL retain the normalized source selector as `contract.selector`. It SHALL NOT replace that selector with `work-list` only because the compiler receives resolved issue numbers. Direct explicit issue lists and ranges SHALL retain `work-list` selector semantics. Resume SHALL preserve the accepted selector without recompilation.

#### Scenario: Label selector remains eligible for FRG validation

- **WHEN** `pipeline loop --label factory-gate` resolves issue numbers and creates a fresh contract
- **THEN** the contract selector SHALL remain `{ type: "label", value: "factory-gate" }`
- **AND** `validateFrgPackContract` SHALL evaluate that label selector instead of rejecting it as an ad-hoc work list

#### Scenario: Supported milestone selector remains identifiable

- **WHEN** a supported fixed-pack milestone selector resolves issue numbers and creates a fresh contract
- **THEN** the contract selector SHALL retain that normalized milestone identity
- **AND** run identity, issue order, and dependency compilation SHALL otherwise remain unchanged

#### Scenario: Explicit issue list is not promoted to a fixed pack

- **WHEN** a caller creates a loop from an explicit issue list or range
- **THEN** the contract selector SHALL remain `work-list`
- **AND** FRG fixed-pack validation SHALL reject it unless a future policy explicitly supports that selector

### Requirement: Every release SHALL instantiate the representative pack from a versioned manifest

The repository SHALL contain a versioned representative FRG pack manifest with deterministic issue templates, template identifiers and hashes, required clean-path items, scenario and fault recipes, evidence requirements, and expected composition. A release run SHALL create fresh synthetic issues from that manifest and bind each issue and observation to the exact release version, manifest version, template identity, and run. It SHALL NOT reuse prior release issues such as #749 or #750.

#### Scenario: Fresh release creates fresh pack instances

- **WHEN** the factory starts FRG for version `X.Y.Z`
- **THEN** it SHALL instantiate new synthetic pack issues from the checked-in manifest
- **AND** every issue SHALL carry the fixed selector label plus machine-readable manifest and template provenance

#### Scenario: Old pack item cannot satisfy a new release

- **WHEN** an issue or observation is bound to an earlier version, manifest hash, template, or run
- **THEN** the FRG collector and scorer SHALL refuse it for the current release

### Requirement: FRG observations SHALL be derived from concrete run and fault evidence

The representative pack SHALL provide a collector that creates the documented observation input from concrete Pipeline run events, action evidence, pull-request and check identities, and documented fault injection results. The collector SHALL refuse a required scenario when its evidence is absent or inconsistent. Production collection SHALL NOT import or expose test-only required-observation or required-composition overrides.

#### Scenario: Complete evidence produces an observation input

- **WHEN** every required scenario and fault recipe has concrete evidence bound to the current pack run
- **THEN** the collector SHALL emit a deterministic observation file that names those evidence identities
- **AND** the normal `pipeline factory-gate` scorer SHALL determine pass or fail

#### Scenario: Missing fault evidence fails closed

- **WHEN** one required injection or recovery outcome has no matching concrete evidence
- **THEN** the collector SHALL exit non-zero and name the missing scenario
- **AND** it SHALL NOT synthesize a passing observation

#### Scenario: Test-only overrides are absent from production pack code

- **WHEN** production pack scripts and their imports are inspected
- **THEN** they SHALL NOT import `frgRequiredObservationOverrides`, `frgRequiredCompositionOverrides`, or an equivalent all-pass override

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

### Requirement: FRG attestation SHALL remain production-owned and candidate-uncredentialed

The factory SHALL NOT place the FRG attestation key or its path in the candidate environment, inherited file descriptors, the candidate-action cgroup's credential mount, request, result, error, log, or notice. The existing scorer unit SHALL load the credential and run only a fixed wrapper-local trusted attestor. That attestor SHALL NOT start a child process, use the network, import or execute candidate code, or import a module selected by candidate output or the attestation request.

The pilot explicitly accepts the broad local authority of the `mcomardo` account and passwordless sudo. A malicious same-user process can read or control local resources. This requirement prevents automatic propagation and candidate-selected attestor behavior; it does not claim filesystem, process-control, or service-manager isolation from that account. Issues #618, #899, or later hardening own that privilege-separation boundary.

For v1.33.0, the attestor SHALL use the policy snapshot pinned with the reviewed #898 wrapper. For every later release, it SHALL use only the signer from the verified current production engine through a closed wrapper-owned selection rule. It SHALL stop on an unsupported request schema, evidence schema, signer identity, or policy. It SHALL NOT use candidate code as the signer.

The attestation request SHALL contain only versioned identity fields, wrapper-approved closed data paths, and expected digests. It SHALL contain no executable path, module name, command, network target, caller-authored pass claim, or signing result. The trusted attestor SHALL resolve each data path within its fixed allowed roots, reject traversal and unexpected file types, verify every digest, recompute the policy result, and emit only the bounded attestation result.

#### Scenario: Candidate action receives no automatic FRG credential

- **WHEN** the wrapper starts a candidate action and processes its attestation handoff
- **THEN** the candidate environment SHALL contain no FRG key or key path
- **AND** the candidate SHALL inherit no FRG key file descriptor
- **AND** the candidate-action cgroup SHALL have no FRG credential mount
- **AND** the request, result, error, journal record, log, and notice SHALL contain no key and SHALL redact its path

#### Scenario: Candidate cannot select trusted attestor behavior

- **WHEN** candidate output names a credential, executable, module, command, network target, traversal path, or symlink escape in an attestation request
- **THEN** the trusted attestor SHALL reject the request without importing or executing candidate code, starting a child process, using the network, reading the selected target, or returning secret data

#### Scenario: Same-user authority remains explicit

- **WHEN** a malicious process runs as `mcomardo` or uses the pilot's passwordless sudo outside the wrapper handoff
- **THEN** #898 SHALL make no claim that it prevents that process from reading or controlling local resources
- **AND** #618, #899, or later hardening SHALL own any required privilege separation

#### Scenario: Current production policy owns later signing

- **WHEN** a release after v1.33.0 requests attestation
- **THEN** the wrapper SHALL select the signer from the verified installed production engine without using a candidate-selected import or path
- **AND** the attestor SHALL stop if that signer does not support the request schema, evidence schema, or policy

#### Scenario: Candidate cannot claim a passing attestation

- **WHEN** candidate output includes a pass claim, MAC, signer identity, or other field outside the unsigned artifact contract
- **THEN** the wrapper and trusted attestor SHALL ignore or reject that field according to the closed schema
- **AND** only a policy result recomputed by the trusted attestor MAY be signed

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

### Requirement: Synthetic clean composition pack items for release 1.34.0 SHALL leave in-tree pack provenance

Synthetic pack work items used solely to contribute to FRG Layer B scenario `clean-item-throughput` for release `1.34.0` SHALL leave a minimal in-tree provenance artifact. The artifact SHALL be either (1) a docs or README provenance note under `docs/` or as a one-line note in the README, or (2) a run-scoped JSON fixture under `core/test/fixtures/frg/` with a hermetic unit test that pins the release identity. The artifact SHALL name the pack role (clean composition item index or equivalent) and the target release version `1.34.0`. The artifact SHALL NOT require changes to FRG scoring code, release preflight, evidence schema, thresholds, or scenario inventory. Product feature work SHALL NOT be required for a clean composition pack item to satisfy this provenance requirement.

#### Scenario: Clean composition item 1 for 1.34.0 has a provenance artifact

- **WHEN** the synthetic FRG pack clean composition item for release `1.34.0`
  (pack item 1 / `clean-item-throughput` contributor, issue #959) is implemented
- **THEN** the repository tree SHALL contain a docs/README provenance note **or**
  a run-scoped fixture under `core/test/fixtures/frg/` that names the clean
  composition pack role and release `1.34.0`
- **AND** the implementation SHALL NOT modify FRG scoring, factory-gate driver
  pass/fail logic, or release preflight solely to satisfy that pack item

#### Scenario: Provenance artifact does not invent a new scenario id

- **WHEN** an operator or test reader inspects the clean composition provenance
  artifact for release `1.34.0`
- **THEN** the artifact SHALL refer to existing pack vocabulary
  (`clean-item-throughput`, factory-gate / `factory-gate-v1`, or clean
  composition item index)
- **AND** SHALL NOT introduce a new required FRG scenario id beyond the fixed
  pack inventory

#### Scenario: Fixture form pins release_version when used

- **WHEN** the implementer chooses the run-scoped fixture form for clean
  composition item 1 for release `1.34.0`
- **THEN** the fixture SHALL declare a release identity field equal to the
  string `1.34.0`
- **AND** a unit test that loads only that fixture path SHALL fail if the
  release identity is not `1.34.0`
- **AND** that unit test SHALL NOT call real network, git, or subprocess APIs

### Requirement: Clean composition pack items for 1.34.0 SHALL be eligible for ready-to-deploy without engine-class block as their pack outcome

A synthetic clean composition pack item for FRG Layer B release `1.34.0` SHALL be scoped so that a correct implementation can reach label `pipeline:ready-to-deploy` without an engine-class block. The pack-scored outcome for such an item is clean ready-to-deploy throughput, not a product behavior change. Engine-class blocks caused by defects in the factory (capacity cascade, resume strand, OpenSpec archive false-pass, and other engine-class themes defined by the FRG taxonomy) SHALL count against the item for FRG scoreboard purposes when they occur; the item's own change set SHALL not deliberately introduce product-class or engine-class failure modes. This item alone SHALL NOT claim to satisfy full release-eligible representative pack composition.

#### Scenario: Item reaches ready-to-deploy as clean throughput

- **WHEN** the clean composition pack item's PR has a valid OpenSpec change
  (when OpenSpec is used), a docs or fixture-only provenance implementation, and
  green `npm run ci`
- **AND** no engine-class defect blocks the run
- **THEN** the issue SHALL be able to receive `pipeline:ready-to-deploy`
- **AND** that outcome SHALL count toward FRG scenario `clean-item-throughput`
  for release `1.34.0` when the fixed pack loop scores the run

#### Scenario: FRG may close without merge after pack pass

- **WHEN** a release-eligible or pack-scored FRG pass records this item as
  `ready_clean` with an open PR
- **THEN** the existing FRG post-pass disposition MAY close the PR and linked
  issue without merge
- **AND** this pack item's implementation SHALL NOT add a merge path

