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
artifact path or JSON digest). The attachment SHALL be a PR comment or a section of the release PR
body. When `.agent-pipeline/frg/` is gitignored, that attachment SHALL NOT be a `git add` of that
tree, including `git add -f`. On-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` remains the durable
local record. Absence of any linkable FRG evidence for the version SHALL leave the release FRG
precondition unsatisfied even if a private local pass is claimed without a durable record.

#### Scenario: Pass summary is linkable

- **WHEN** a live FRG for version `X.Y.Z` passes
- **THEN** the evidence SHALL include a `run_id` and `pass: true` suitable for pasting or automated
  posting onto the release PR for `X.Y.Z`

#### Scenario: Unrecorded local claim does not satisfy attachment

- **WHEN** an operator asserts FRG success without a durable evidence artifact containing `run_id`
  and `pass: true` for the version
- **THEN** the FRG attachment requirement SHALL be unsatisfied

#### Scenario: Gitignored FRG is not attached by git add

- **WHEN** `.agent-pipeline/frg/` is gitignored
- **AND** `pipeline release` prepares a release PR after an FRG pass for `1.39.5`
- **THEN** the release PR body or an attached comment SHALL include the FRG `run_id` and pass summary
- **AND** the staging `git add` SHALL NOT include `.agent-pipeline/frg` or any path under it

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

### Requirement: FRG Layer A ownership SHALL not silently omit ship-path composition classes

When the repository maintains ship-path composition class ids under `ship-path-composition-coverage` (including at least frontier one-wave, code-dep merge barrier, independent R2D partial-failure merge, scratch-only no needs-human, and scratch-only unlink-not-repair), the FRG Layer A ownership map, composition inventory, or an explicit co-located ship-path composition inventory consulted by the unit suite SHALL record each hard class as either (1) covered by a hermetic test, or (2) waived with an open tracking issue. Silent omission of a hard ship-path composition class from both test coverage and waiver inventory SHALL NOT be permitted. This requirement does **not** expand the fixed Layer B scenario pack ids and does **not** require live network ship in CI. Hard classes for issue #1029 acceptance SHALL be satisfied by tests, not by waivers.

#### Scenario: Hard ship-path class missing from Layer A / composition inventory fails

- **WHEN** a hard ship-path composition class has neither a hermetic covering test registration nor an open-issue waiver entry in the consulted inventory
- **THEN** the inventory or Layer A ownership guard SHALL fail under the unit suite
- **AND** the failure SHALL name the missing class id

#### Scenario: Layer B pack ids remain frozen by this requirement

- **WHEN** this requirement is implemented
- **THEN** the fixed FRG Layer B scenario id list SHALL NOT be required to add new live pack scenario ids solely for ship-path composition
- **AND** hermetic / Layer A / unit composition SHALL remain sufficient for CI proof of these classes

#### Scenario: Hermetic ship-path composition is not release FRG pass alone

- **WHEN** ship-path composition unit tests pass without a conforming live FRG evidence artifact
- **THEN** the FRG release precondition for a version SHALL remain governed by existing FRG live-loop and attestation rules
- **AND** unit composition success SHALL NOT substitute for release-eligible FRG `pass: true`

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

### Requirement: Durable post-pilot FRG generation SHALL start or resume a request-bound pack loop

For every release version after v1.33.0, the durable FRG generator SHALL start
or resume one `factory-gate` pack loop bound to the active prepare request.
When no request-bound loop exists, the generator SHALL create or reuse pack
issues from the checked-in `factory-gate-v1` templates so the item count meets
the pack manifest minimum, allocate the candidate-track run id, persist
`factory-release-binding.json` on that loop (request fingerprint, candidate
git SHA, target version, pack/manifest identity) together with a non-null
`loop_run_id` on the pack instance, and only then spawn or resume the loop.
Spawn SHALL exec the verified candidate launcher that wrote the contract
from a typed candidate invocation (absolute executable, immutable argv, and
candidate SHA). PATH `pipeline` and `PIPELINE_BIN` SHALL NOT be production
fallbacks. `--engine-track candidate` SHALL remain intent metadata and SHALL
NOT select the binary. The generator SHALL persist a durable dispatch state
machine on the binding: `bound` (never started or retryable OS spawn
failure), `starting` (OS accepted, observation deadline set), `dispatched`
(valid durable handoff), and `failed` (terminal pre-handoff failure). It
SHALL persist `bound` before spawn. It SHALL persist `starting` plus the
observation deadline after OS accept. It SHALL persist `dispatched` only
after a valid `loop_run_handoff` for that `loop_run_id` with realpath-contained
artifact paths, matching candidate SHA, and matching `supervisor.json`
process identity. A failed OS spawn (child never started, including throw or
ENOENT) SHALL fail that tick and SHALL leave the request `bound` to the same
`loop_run_id` so a later invoke can retry spawn. A child that exits with
status `0` or non-zero before the first valid handoff SHALL persist `failed`
and SHALL NOT be retried as a second blind spawn. While that bound loop is
not terminal, the generator SHALL return a machine-readable in-progress
status that includes the authoritative pack-loop liveness object, and SHALL
NOT treat the missing terminal loop as `missing_generator` or
`pack_loop_missing`. A re-invoke of the same request SHALL resume the same
`loop_run_id` and SHALL NOT start a second unbound pack. Before spawning, the
generator SHALL reconcile persisted state: adopt a valid existing holder,
observe an in-window `starting` child, retry only `bound`, and fail closed on
`failed`. It SHALL NOT blindly create a second child. The generator SHALL NOT
adopt an unbound newest `factory-gate` loop as the bound run or as
release-eligible evidence.

#### Scenario: First prepare with no bound loop dispatches a candidate pack loop

- **WHEN** durable FRG generation runs for a post-1.33 version
- **AND** no `factory-release-binding.json` matches the request fingerprint,
  candidate SHA, version, and manifest
- **THEN** the generator SHALL create or reuse pack issues from
  `factory-gate-v1` templates that meet the manifest minimum item count
- **AND** it SHALL persist a non-null `loop_run_id` on the pack instance
  together with a matching `factory-release-binding.json` before spawn
- **AND** it SHALL then dispatch one durable loop on the candidate engine
  launcher for that SHA with the pack work-list or the `factory-gate` label
- **AND** it SHALL return in-progress status without inventing `pass: true`

#### Scenario: Second prepare resumes the same bound loop

- **WHEN** a later invoke uses the same prepare request
- **AND** the pack instance already records `loop_run_id` `L` with a matching
  binding
- **THEN** the generator SHALL resume `L`
- **AND** it SHALL NOT start another pack loop

#### Scenario: Unbound newest factory-gate loop is not adopted

- **WHEN** an unbound newest `factory-gate` loop exists
- **AND** no `factory-release-binding.json` matches the active request
- **THEN** the generator SHALL NOT adopt that unbound loop as the bound run
- **AND** it SHALL start or resume only a request-bound pack loop

#### Scenario: Crash after persist before spawn resumes the same bound run

- **WHEN** the generator has persisted pack-instance `loop_run_id` `L` and a
  matching `factory-release-binding.json`
- **AND** the process stops before spawn confirms
- **THEN** a later invoke of the same request SHALL resume `L`
- **AND** it SHALL NOT start a second unbound pack

#### Scenario: Failed detached spawn is retried on the same bound run

- **WHEN** detached spawn fails at startup before the child starts (including ENOENT)
- **THEN** that tick SHALL NOT return in-progress as if the loop were running
- **AND** `dispatch_state` SHALL remain `bound`
- **AND** a later invoke of the same request SHALL retry spawn of the same
  `loop_run_id`
- **AND** it SHALL NOT start a second unbound pack

#### Scenario: Pre-handoff child exit is not retried

- **WHEN** the OS accepted the child
- **AND** the child exits `0` or non-zero before a valid `loop_run_handoff`
- **THEN** that tick SHALL fail closed
- **AND** it SHALL persist `dispatch_state` `failed`
- **AND** a later invoke SHALL NOT blindly spawn a second child

#### Scenario: OS accept does not mark dispatched

- **WHEN** the OS reports spawn success for the pack child
- **AND** no valid `loop_run_handoff` has been observed
- **THEN** `dispatch_state` SHALL be `starting`
- **AND** it SHALL NOT be `dispatched`

#### Scenario: Concurrent prepare does not spawn a second child

- **WHEN** a persisted binding for loop `L` is `starting` inside the observation window
- **AND** a second prepare invoke of the same request runs
- **THEN** the second invoke SHALL NOT spawn another pack-loop child
- **AND** it SHALL observe `L`

### Requirement: Terminal pack-loop scoring SHALL use factory-gate from-run without observations

When the request-bound pack loop is terminal, the durable generator SHALL
score that run with `pipeline factory-gate --for <target-version> --from-run
<loop_run_id>` or the in-process equivalent that implements the same scorer
contract. The score invocation SHALL NOT pass `--observations` or any
caller-authored observations file. Hybrid v2 scoring SHALL apply: required-live
ids MUST come from the candidate pack loop; Layer A-allowed ids MAY prove from
a TAP hash on the same candidate SHA. The generator SHALL NOT invent scenario
statuses, metrics, receipts, or `pass: true`.

#### Scenario: Terminal loop is scored from the bound run id

- **WHEN** the request-bound pack loop `L` is terminal for version `1.39.0`
- **THEN** the generator SHALL invoke factory-gate scoring for `1.39.0` with
  `--from-run L` (or the in-process equivalent)
- **AND** that invocation SHALL omit `--observations`

#### Scenario: Synthetic observations cannot unlock a pass

- **WHEN** a caller or work directory supplies an observations file
- **THEN** the terminal score path SHALL ignore that file
- **AND** only runner-derived hybrid v2 evidence MAY contribute to
  release-eligible pass

### Requirement: Release-eligible latest.json pass SHALL be written only on a genuine scorer pass

The durable generator SHALL write `.agent-pipeline/frg/<version>/latest.json`
with `pass: true` only when the factory-gate scorer produces a genuine
release-eligible pass for that version, candidate, pack, and bound
`loop_run_id`. A fail score SHALL remain `pass: false`. A fail result MAY
write `latest.json` with `pass: false`. The generator SHALL NOT rewrite a fail
into a pass, and SHALL NOT treat a fail `latest.json` as release-eligible.

#### Scenario: Genuine pass writes release-eligible latest.json

- **WHEN** factory-gate scoring of the bound terminal loop yields
  release-eligible `pass: true`
- **THEN** the generator MAY write `.agent-pipeline/frg/<version>/latest.json`
  with `pass: true` for that version

#### Scenario: Fail stays fail

- **WHEN** factory-gate scoring of the bound terminal loop yields
  `pass: false`
- **THEN** any written `latest.json` SHALL keep `pass: false`
- **AND** release preparation SHALL NOT treat that artifact as
  release-eligible

### Requirement: Ship-path skip-frg default restore SHALL stay blocked until one post-1.33 honest FRG pass exists

The pipeline SHALL treat a ship-path change that drops the default `--skip-frg` flag on Tugboat, `pipeline release`, or `engine-promote` as blocked until at least one release version after `1.33.0` has a `.agent-pipeline/frg/<version>/latest.json` that an honest-pass check accepts. After that check accepts, the factory Option 1 composer default SHALL omit `--skip-frg` and SHALL run the FRG pack phase before release. A `1.33.0`-only artifact, a `pass: false` artifact, a product-milestone loop, a caller-authored observations file, or a hand-edited `pass: true` SHALL NOT satisfy this precondition and SHALL NOT restore skip-as-default. The next identical skip-frg restore request SHALL reuse this same check and SHALL NOT require a new mole issue. Auto-tag fail-closed restore is the child of this unblock and SHALL require a release-eligible `latest.json` for the version being tagged **on the local tag path**. When `.agent-pipeline/frg/` is gitignored, auto-tag SHALL NOT fail the ship for a missing tree-file copy of that artifact. Pin default changes remain a sibling child.

#### Scenario: Missing post-1.33 honest pass blocks skip-frg restore

- **WHEN** no `.agent-pipeline/frg/<version>/latest.json` after `1.33.0` passes the honest-pass check
- **THEN** the skip-frg default restore SHALL remain blocked
- **AND** Tugboat, release, and engine-promote default argv SHALL keep `--skip-frg`

#### Scenario: Accepted honest pass unblocks Tugboat default no-skip

- **WHEN** at least one `.agent-pipeline/frg/<version>/latest.json` after `1.33.0` passes the honest-pass check
- **THEN** Tugboat default release and promote argv SHALL omit `--skip-frg`
- **AND** Tugboat SHALL run the FRG pack phase before release
- **AND** the restore SHALL reuse `isHonestPost133FrgPass` (or the same check) and SHALL NOT invent a second pass definition

#### Scenario: Historical 1.33.0 pass does not satisfy the precondition

- **WHEN** `.agent-pipeline/frg/1.33.0/latest.json` exists with `pass: true`
- **AND** no later version has an accepted honest-pass artifact
- **THEN** the skip-frg default restore SHALL remain blocked

#### Scenario: Fail latest.json does not unlock skip-frg restore

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` exists with `pass: false`
- **THEN** the skip-frg default restore SHALL remain blocked
- **AND** the artifact SHALL NOT be rewritten to `pass: true`

#### Scenario: Unblocked ship path fail-closes auto-tag without latest.json

- **WHEN** the post-1.33 honest-pass check has already accepted and Tugboat default no-skip is in force
- **AND** a detected release merge for version `X.Y.Z` has no release-eligible `.agent-pipeline/frg/<X.Y.Z>/latest.json` in the tree
- **AND** `.agent-pipeline/frg/` is not gitignored
- **THEN** auto-tag SHALL fail closed
- **AND** SHALL NOT create or push `vX.Y.Z`

#### Scenario: Gitignored missing tree latest.json does not fail auto-tag

- **WHEN** the post-1.33 honest-pass check has already accepted and Tugboat default no-skip is in force
- **AND** a detected release merge for version `X.Y.Z` has no tree-file `.agent-pipeline/frg/<X.Y.Z>/latest.json`
- **AND** `.agent-pipeline/frg/` is gitignored
- **THEN** auto-tag SHALL NOT fail the job for that missing tree file
- **AND** local `release ensure-tag` SHALL remain the fail-closed tag path for on-disk HMAC evidence

### Requirement: Honest post-1.33 FRG pass SHALL come from the bound candidate pack scored without observations

The first post-1.33 honest FRG pass SHALL be produced by the durable
generator path: a request-bound `factory-gate` pack on the **candidate**
engine track, scored with `pipeline factory-gate --for <version>
--from-run <loop_run_id>` or the in-process equivalent. That score
invocation SHALL NOT pass `--observations` or any caller-authored
observations file. The scored work-list SHALL be the request-bound
candidate pack. It SHALL NOT be the product v1.39 milestone work-list.
The written `.agent-pipeline/frg/<version>/latest.json` SHALL include
`pass: true`, a non-empty `run_id`, a non-empty bound `loop_run_id`,
pack identity `factory-gate-v1`, and `pack_provenance.candidate_git_sha`
for that candidate. The evidence object SHALL record runner-stamped
`score_source` `from-run` and `work_list` `factory-gate-pack`. Free-text
notes and caller options SHALL NOT establish those fields. Persist SHALL
require those fields already present on the scored object and SHALL NOT
stamp them from caller options.

#### Scenario: Bound pack from-run writes honest pass latest.json

- **WHEN** the request-bound candidate pack loop `L` is terminal for a
  version after `1.33.0`
- **AND** factory-gate scores `L` with `--from-run L` and no
  `--observations`
- **AND** hybrid v2 scoring yields a genuine `pass: true`
- **THEN** `.agent-pipeline/frg/<version>/latest.json` SHALL record
  `pass: true`, `run_id`, `loop_run_id` `L`, `pack_id` `factory-gate-v1`,
  and the candidate git SHA

#### Scenario: Product milestone work-list is refused as FRG evidence

- **WHEN** a loop's work-list is the product v1.39 milestone rather than
  the request-bound `factory-gate` pack
- **THEN** the honest-pass check SHALL reject that loop as evidence
- **AND** the skip-frg default restore SHALL remain blocked

#### Scenario: Missing or other work-list is refused as FRG evidence

- **WHEN** the evidence object has no `work_list`, or `work_list` is
  `other`, or a caller option names `other`
- **THEN** the honest-pass check SHALL reject that evidence
- **AND** free-text notes SHALL NOT establish `factory-gate-pack`
  identity

#### Scenario: Observations file cannot create an honest pass

- **WHEN** a caller or work directory supplies an observations file to
  the score path
- **THEN** that file SHALL NOT be used as authority for `pass: true`
- **AND** only runner-derived hybrid v2 evidence MAY contribute to an
  honest pass

#### Scenario: Note-only or caller-opt from-run does not establish honest pass

- **WHEN** the evidence object has no `score_source` of `from-run`
- **AND** notes begin with a from-run prefix or a caller option claims
  `from-run`
- **THEN** the honest-pass check SHALL reject that evidence
- **AND** lookup of a hand-edited `latest.json` that only adds that note
  SHALL NOT accept the artifact

#### Scenario: Persist caller options cannot stamp missing provenance

- **WHEN** the scored object has no `score_source` or no `work_list`
- **AND** persist is called with caller options that name `from-run` and
  `factory-gate-pack`
- **THEN** persist SHALL NOT add those fields to the scored object
- **AND** persist SHALL NOT return `pass: true`

### Requirement: Honest-pass required-live ids SHALL not be not_observed

An honest post-1.33 FRG pass SHALL record required-live scenario ids
`clean-item-throughput`, `blocker-taxonomy`, and
`empty-depends-on-stack-honesty`, plus the required OpenSpec-bearing
composition item, with a status other than `not_observed`. Those ids
SHALL use proof source `live`, `ledger`, or `derived` as appropriate.
They SHALL NOT use source `layer_a`.

#### Scenario: Required-live not_observed fails the honest-pass check

- **WHEN** a post-1.33 `latest.json` has `pass: true`
- **AND** any required-live id or the required OpenSpec-bearing
  composition item has status `not_observed`
- **THEN** the honest-pass check SHALL reject the artifact
- **AND** the skip-frg default restore SHALL remain blocked

#### Scenario: Required-live observed on the candidate pack can pass

- **WHEN** required-live ids are observed on the request-bound candidate
  pack loop (`clean-item-throughput` and `blocker-taxonomy` from the
  ledger, `empty-depends-on-stack-honesty` derived, OpenSpec-bearing
  composition from the live pack item)
- **AND** remaining honest-pass criteria hold
- **THEN** the honest-pass check MAY accept the artifact

### Requirement: Honest-pass Layer A-allowed ids SHALL cite candidate-SHA TAP hashes

An honest post-1.33 Layer A-allowed outcome SHALL cite a named TAP hash
bound to the same `pack_provenance.candidate_git_sha` when source is
`layer_a`. Hybrid Layer A provenance SHALL remain refused for ids that
are not on the closed Layer A-allowed set. A missing, skipped,
mismatched, or other-commit TAP SHALL fail that probe and SHALL fail the
honest-pass check.

#### Scenario: Layer A-allowed TAP on the candidate SHA can pass

- **WHEN** every Layer A-allowed id used in the report cites a TAP hash
  bound to the same candidate git SHA
- **AND** required-live ids are not `not_observed`
- **AND** remaining honest-pass criteria hold
- **THEN** the honest-pass check MAY accept the artifact

#### Scenario: Unknown layer_a id is refused

- **WHEN** a scenario or composition id that is not on the closed Layer
  A-allowed set claims source `layer_a`
- **THEN** the honest-pass check SHALL reject the artifact
- **AND** SHALL NOT treat the claim as proof of that id

#### Scenario: Missing or other-commit TAP fails the Layer A probe

- **WHEN** a Layer A-allowed probe is missing, skipped, fails, or binds
  its TAP hash to a different git SHA than `pack_provenance.candidate_git_sha`
- **THEN** the honest-pass check SHALL reject the artifact

### Requirement: Honest-pass evidence SHALL be cited on the tracking issue

When an honest post-1.33 `latest.json` exists, the implementer SHALL post
a comment on the tracking issue for this proof (issue #1038) that names
the evidence path and the `frg_run_id` (`run_id`). A chat paste or
hand-edited observations file SHALL NOT substitute for that citation.

#### Scenario: Comment names evidence path and frg_run_id

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` is an accepted
  honest pass with `run_id` `frg-1`
- **THEN** issue #1038 SHALL receive a comment that cites that path and
  `frg-1`

#### Scenario: Missing citation leaves the issue incomplete

- **WHEN** an honest `latest.json` exists
- **AND** issue #1038 has no comment naming the path and `frg_run_id`
- **THEN** this issue's acceptance SHALL remain unsatisfied
- **AND** the on-disk artifact MAY still satisfy the skip-frg restore
  precondition

### Requirement: Failed honest-pass attempt SHALL not waive into the Tugboat skip-frg child

The pipeline SHALL keep the tracking issue open and SHALL NOT start the
Tugboat `--skip-frg` default flip when the bound candidate pack cannot
produce an accepted honest pass. A fail score, a missing artifact, or an
operator waiver SHALL NOT grant that permission. The written
`latest.json`, if any, SHALL keep `pass: false`. Persist SHALL NOT
rewrite a scorer `pass: false` to `pass: true`.

#### Scenario: Pack fail keeps the issue open

- **WHEN** factory-gate scoring of the bound terminal loop yields
  `pass: false`
- **THEN** any written `latest.json` SHALL keep `pass: false`
- **AND** persist SHALL NOT validate `{ ...scored, pass: true }` and
  rewrite the scorer result
- **AND** issue #1038 SHALL remain open
- **AND** the Tugboat skip-frg child SHALL stay blocked

### Requirement: Honest-pass check SHALL be machine-checkable and reusable

The pipeline SHALL expose one deterministic honest-pass check over a
`latest.json` (or equivalent evidence object). That check SHALL accept
only evidence that meets the post-1.33, from-run, required-live,
Layer A TAP, pack-identity, and no-observations rules in this change.
The check SHALL require a runner-issued `integrity.score_receipt` that
binds the computed `pass` to the evidence run. That receipt SHALL be an
HMAC-SHA256 under `PIPELINE_FRG_ATTESTATION_KEY` (or an explicit injected
test key). A public hash of evidence fields SHALL NOT satisfy the check.
A hand-edited `pass: true` on an unsigned or failed score SHALL NOT match
that receipt, including when the editor also remints `score_receipt`
without the producer key. Full HMAC attestation (`integrity.attestation`)
remains optional for this check. Later skip-frg restore, auto-tag, and
pin work SHALL reuse this check. They SHALL NOT invent a second pass
definition.

#### Scenario: Checker accepts a conforming post-1.33 from-run pass

- **WHEN** a `latest.json` for version `1.39.0` has `pass: true`, a
  bound `loop_run_id`, pack `factory-gate-v1`, observed required-live
  ids, and candidate-SHA TAP hashes for any Layer A-allowed ids
- **AND** provenance records `--from-run` scoring with no observations
  file
- **THEN** the honest-pass check SHALL return accept

#### Scenario: Checker rejects fabricated or pre-1.33 evidence

- **WHEN** the evidence is only version `1.33.0`, or has required-live
  `not_observed`, or lacks a candidate-SHA TAP for a used Layer A id,
  or was scored from an observations file, or used the product
  milestone work-list
- **THEN** the honest-pass check SHALL return reject

#### Scenario: Checker rejects a hand-edited pass on an unsigned fail

- **WHEN** the runner writes a structurally eligible unsigned score with
  `pass: false`
- **AND** a caller clones the object with `pass: true`
- **THEN** the honest-pass check SHALL return reject

#### Scenario: Checker rejects a reminted public receipt on an unsigned fail

- **WHEN** the runner writes a structurally eligible unsigned score with
  `pass: false`
- **AND** a caller clones the object with `pass: true` and a recomputed
  public `score_receipt` hash, or a MAC under a different key
- **THEN** the honest-pass check SHALL return reject

### Requirement: Per-ship FRG pack failure SHALL not restore skip-frg as the Tugboat default

When a later milestone's FRG pack fails or writes `pass: false`, the pipeline SHALL fail that ship closed. It SHALL NOT put `--skip-frg` back on Tugboat default argv. The operator escape with a logged reason remains the only skip path. A fail `latest.json` SHALL keep `pass: false`.

#### Scenario: Pack fail does not revive default skip

- **WHEN** Tugboat's FRG pack phase fails for version `1.40.0`
- **THEN** that ship SHALL stop before `pipeline release`
- **AND** default Tugboat argv for a later ship SHALL still omit `--skip-frg`
- **AND** persist SHALL NOT rewrite the fail artifact to `pass: true`

### Requirement: Shared tag-path FRG validation SHALL name the latest.json path and pack remediation

The shared release-eligible tag validator SHALL fail closed when
`.agent-pipeline/frg/<X.Y.Z>/latest.json` is missing, unparsable, `pass: false`,
or otherwise not release-eligible for version `X.Y.Z` on the **local on-disk** tag
path (`pipeline release ensure-tag` / `ensureAnnotatedReleaseTag`). The fail-closed
message SHALL name that `latest.json` path and SHALL name `factory-release prepare` or
the Tugboat FRG pack phase as the remediation. The validator SHALL NOT say FRG
is optional or advisory on the tag path. The local tag helper SHALL reuse this
validator. Auto-tag SHALL reuse this validator when FRG is not gitignored. Auto-tag
SHALL NOT use this validator to fail the job when FRG is gitignored and the tree
file is absent. Callers SHALL NOT invent a second tag eligibility checker.
The validator SHALL return the parsed HMAC-validated snapshot from that same
file read so `release ensure-tag` can bind `--packed-candidate` without
reopening `latest.json`. HMAC `candidate_git_sha` SHALL be an attested field:
the canonical attestation payload SHALL include `factory_release_binding` when
that field is present on the snapshot. An unauthenticated top-level
`factory_release_binding` overlay SHALL fail HMAC verification. The validator
SHALL NOT fall back from a present but invalid binding to another carrier.

#### Scenario: Missing latest.json names path and remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` is absent
- **THEN** validation SHALL fail closed
- **AND** the message SHALL name `.agent-pipeline/frg/1.39.0/latest.json`
- **AND** the message SHALL name `factory-release prepare` or the Tugboat FRG pack phase

#### Scenario: Failed latest.json names path and remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` exists with `pass: false`
- **THEN** validation SHALL fail closed
- **AND** the message SHALL name `.agent-pipeline/frg/1.39.0/latest.json`
- **AND** the message SHALL name `factory-release prepare` or the Tugboat FRG pack phase

#### Scenario: Release-eligible pass does not emit the fail-closed remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` is release-eligible with `pass: true`
- **THEN** validation SHALL succeed
- **AND** SHALL NOT treat the artifact as a hard block

#### Scenario: Tag binding uses the HMAC-validated snapshot

- **WHEN** the shared tag validator reads `.agent-pipeline/frg/1.39.0/latest.json`
- **AND** HMAC validation succeeds
- **THEN** it SHALL return the parsed snapshot from that same read
- **AND** a later replacement of the on-disk file SHALL NOT change the returned snapshot

#### Scenario: Unauthenticated factory_release_binding overlay fails HMAC

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` is HMAC-valid for packed candidate `A`
- **AND** a writer adds or changes `factory_release_binding.candidate_git_sha` to `B` after signing
- **THEN** tag-path validation SHALL fail closed
- **AND** SHALL NOT treat `B` as HMAC `candidate_git_sha`
- **AND** SHALL NOT fall back to `pack_provenance.candidate_git_sha`

### Requirement: FRG runtime files SHALL NOT dirty the factory control checkout

`.agent-pipeline/frg/` (including `<X.Y.Z>/latest.json` and the rest of that tree) SHALL
be treated as an engine-written runtime artifact on the factory control checkout. A pack
or promote write of `latest.json` SHALL NOT fail the next train's `worktree-clean` check.
The FRG runbook SHALL NOT require that directory to stay unignored on the protected
checkout. Host-only `skip-worktree` SHALL NOT be the product fix.

Local `latest.json` SHALL remain the ship-host lookup for `pipeline release`,
`pipeline engine-promote`, and `pipeline release ensure-tag` on the host that just packed.
Release-eligible evidence SHALL NOT need to be committed, comment-attached, or
`git add -f`'d so auto-tag can see it. `pipeline release` SHALL NOT `git add` that
gitignored tree in order to open a release PR. Auto-tag SHALL NOT block the ship when that
path is gitignored. Local `release ensure-tag` SHALL create `vX.Y.Z` from on-disk HMAC
evidence. That posture SHALL NOT require leaving `.agent-pipeline/frg/` unignored on the
factory control checkout.

#### Scenario: Pack write does not fail the next train worktree-clean

- **WHEN** Tugboat or `pipeline factory-release prepare` writes
  `.agent-pipeline/frg/1.39.3/latest.json` on the factory control checkout
- **AND** that file is not committed
- **THEN** the next `pipeline train` / `pipeline doctor` `worktree-clean` check SHALL
  pass
- **AND** SHALL NOT fail solely because `latest.json` exists as an untracked file

#### Scenario: Runbook no longer requires unignored FRG on the protected checkout

- **WHEN** an operator reads the FRG runbook evidence-path section after this change
- **THEN** it SHALL state that `.agent-pipeline/frg/` is gitignored on the factory
  control checkout
- **AND** SHALL NOT require operators to commit leftover `latest.json` onto the
  protected checkout to keep the next train clean

#### Scenario: Auto-tag evidence remains attachable

- **WHEN** a release PR for version `1.39.3` is prepared after an FRG pack
- **THEN** release-eligible evidence for `1.39.3` MAY still be attachable
- **AND** that attachment SHALL NOT be required for auto-tag or for local `release ensure-tag`
- **AND** SHALL NOT require the factory control checkout to keep `.agent-pipeline/frg/`
  unignored

#### Scenario: Auto-tag does not require attached tree evidence when FRG is gitignored

- **WHEN** a release PR for version `1.39.5` is merged after an FRG pack
- **AND** `.agent-pipeline/frg/` is gitignored
- **AND** on-disk HMAC `latest.json` is release-eligible
- **THEN** ship-end SHALL create `v1.39.5` via `release ensure-tag` from disk
- **AND** auto-tag SHALL NOT fail the job because the merged tree has no `latest.json`
- **AND** the factory control checkout SHALL keep `.agent-pipeline/frg/` gitignored

#### Scenario: Release prepare does not git add gitignored FRG

- **WHEN** `.agent-pipeline/frg/` is gitignored
- **AND** on-disk HMAC `latest.json` for `1.39.5` is release-eligible
- **AND** `pipeline release 1.39.5 --no-edit` runs
- **THEN** it SHALL NOT pass `.agent-pipeline/frg` to `git add`
- **AND** it SHALL still require that on-disk `latest.json` (`pass: true`, HMAC)
- **AND** `--skip-frg` SHALL NOT be the path

### Requirement: Ship-path FRG pack composers SHALL attest outside prepare

A ship-path Factory Reliability Gate (FRG) pack composer (Tugboat, the installed `pipeline-ship-playbook` copy, or any later composer of the same durable prepare protocol) SHALL keep production attestation out of the `factory-release prepare` process. The composer SHALL invoke prepare with `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in that child. After prepare returns `status: "awaiting_frg_attestation"` or unsigned eligible artifacts exist for the bound request, the composer SHALL run `pipeline factory-gate --for <target-version> --from-run <loop_run_id>` (no `--observations`) in a separate process that has the producer credential. Pack-done for that composer SHALL require `.agent-pipeline/frg/<X.Y.Z>/latest.json` `pass: true` bound to the request candidate. Prepare status `awaiting_frg_attestation` alone SHALL NOT be release-eligible pack-done. The composer SHALL NOT persist the key body in ship state. The next supervisor that sources `PIPELINE_FRG_ATTESTATION_KEY_FILE` into the parent environment SHALL NOT require a new mole issue or a human unset to finish pack.

This requirement does not change prepare's refuse of attestor env. It does not authorize `--skip-frg` as the ship path. It does not place the key in the candidate-loop environment.

#### Scenario: Prepare process remains uncredentialed

- **WHEN** a ship-path composer invokes `pipeline factory-release prepare` and the parent environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set
- **THEN** the prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** prepare SHALL still refuse to run if those variables are present in its environment

#### Scenario: Unsigned wait is not release-eligible pack-done

- **WHEN** prepare returns `status: "awaiting_frg_attestation"`
- **AND** no bound `latest.json` `pass: true` exists for the request candidate
- **THEN** a ship-path composer SHALL NOT declare pack-done
- **AND** it SHALL NOT invoke `pipeline release` for that version on that evidence

#### Scenario: Attestor runs in a separate credentialed process

- **WHEN** unsigned eligible artifacts exist for bound loop `L` and version `X.Y.Z`
- **THEN** the composer SHALL invoke `pipeline factory-gate --for X.Y.Z --from-run L` in a process other than prepare
- **AND** that process SHALL have the producer credential
- **AND** that process SHALL NOT pass `--observations`

#### Scenario: In-progress unsigned eligible artifacts still get an attestor child

- **WHEN** prepare returns `status: "in_progress"` with unsigned eligible artifacts for bound loop `L` and version `X.Y.Z`
- **AND** no bound `latest.json` `pass: true` exists
- **THEN** the composer SHALL invoke `pipeline factory-gate --for X.Y.Z --from-run L` in a process other than prepare
- **AND** that process SHALL have the producer credential
- **AND** that process SHALL NOT pass `--observations`
- **AND** the composer SHALL NOT wait that tick as status-only retry

#### Scenario: Next identical supervisor env fault needs no new mole

- **WHEN** a later ship parent environment again sources `PIPELINE_FRG_ATTESTATION_KEY_FILE`
- **AND** train is complete and the operator escape is not active
- **THEN** the same composer isolation SHALL unset those variables for prepare and sign in the attestor child
- **AND** FRG pack SHALL be able to reach bound `latest.json` `pass: true` without a human unsetting env

### Requirement: Ship-path FRG pack composers SHALL wait until the bound pack loop is terminal

A ship-path Factory Reliability Gate (FRG) pack composer (Tugboat, the installed `pipeline-ship-playbook` launcher, in-engine `pipeline ship`, or any later composer of the same durable prepare protocol) SHALL keep re-invoking the same `factory-release prepare` request while prepare status is `in_progress` and the bound pack loop is live. Live SHALL mean the authoritative pack-loop liveness status object (`live` only after a valid `loop_run_handoff` for that exact loop, plus the exact PID, process-start identity, boot identity, and a fresh heartbeat). TypeScript and Bash consumers SHALL NOT each keep a ledger-derived classifier. They SHALL consume that status from candidate prepare JSON (field `liveness`) or from the same TypeScript probe that produces it. A non-terminal ledger SHALL NOT prove live. Wait-budget expiry while that loop is live SHALL NOT be pack-fail. The composer SHALL heartbeat running ship state on each wait tick. The composer SHALL NOT kill the pack loop. The composer SHALL NOT treat a CI-length poll cap (about 20 minutes) as the live-loop stop. Wait-budget expiry MAY be pack-fail when the bound loop is not live. Unreadable identity evidence SHALL consume the bounded observation window and then fail closed with a typed observer or identity error. It SHALL NOT keep wait-budget from applying as not-live after that window. Real pack-fail (failed or missing FRG that is not omitted-HMAC-only, `latest.json` `pass: false` after a terminal **ineligible** score, attestor child failure) SHALL still fail closed. `latest.json` `pass: false` caused only by omitted HMAC on a structurally eligible pack SHALL NOT be pack-fail. The next identical 20-minute live-loop wait SHALL not require a new mole issue. The next identical dead-pack stall SHALL not require a new mole issue.

This requirement does not raise the implementer 2400s cap. It does not authorize `--skip-frg` as the ship path. It does not change CI / release-PR check wait.

#### Scenario: Live bound loop outlives a short wait cap

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** `L` is live under acknowledged-process liveness
- **AND** a numeric wait cap equal to a CI poll (about 20 minutes) expires
- **THEN** the composer SHALL NOT declare pack-fail for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request
- **AND** it SHALL NOT kill loop `L`

#### Scenario: Dead bound loop may still fail on wait budget

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** `L` is not live
- **AND** the not-live wait budget is exhausted
- **THEN** the composer MAY fail the pack phase
- **AND** it SHALL NOT invoke `pipeline release` for that version on that evidence

#### Scenario: Dead pid plus open ledger does not disable the wait cap

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** lock pid for `L` is dead or missing
- **AND** the ledger for `L` is present without `stop`
- **AND** events for `L` are not terminal
- **THEN** the composer SHALL NOT classify `L` as live
- **AND** wait-budget expiry MAY be pack-fail

#### Scenario: Unreadable liveness state is not pack-fail

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** identity evidence for `L` is unreadable or malformed
- **AND** the bounded observation window has not expired
- **THEN** the composer SHALL NOT declare pack-fail for wait-budget exhaustion
- **AND** it SHALL keep observing `L`

#### Scenario: Unreadable identity after the observation window is pack-fail

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** identity evidence for `L` is unreadable or malformed
- **AND** the bounded observation window has expired
- **THEN** the composer SHALL fail closed with a typed observer or identity error
- **AND** it SHALL NOT keep re-invoking as if `L` were live

#### Scenario: Next identical 20-minute live pack needs no new mole

- **WHEN** a later 2-item factory-gate pack is still `in_progress` after 20 minutes
- **AND** the bound loop is live under acknowledged-process liveness
- **THEN** the same composer wait law SHALL keep ticking prepare
- **AND** the ship SHALL NOT require a human re-detach or a new mole issue to finish the pack

### Requirement: Unsigned eligible omitted-HMAC FRG evidence SHALL await attestation, not fail closed

A Factory Reliability Gate (FRG) score with HMAC omitted SHALL remain unsigned `pass: false`. That score SHALL NOT claim `pass: true`. When the bound pack is terminal and scoreboard and composition meet release-eligibility except HMAC is absent, the evidence SHALL be unsigned-eligible omitted-HMAC evidence. Structural eligibility SHALL NOT treat attested `pass: false` as structural fail when HMAC is the only missing piece.

`pipeline factory-release prepare` SHALL return `status: "awaiting_frg_attestation"` with closed unsigned artifact identities and the bound `loop_run_id` for that evidence. It SHALL NOT return `status: "failed"` or `defect_class: "frg_not_eligible"` for omitted HMAC only.

A ship-path FRG pack composer (Tugboat, the installed `pipeline-ship-playbook` launcher, in-engine `pipeline ship`, or any later composer of the same durable prepare protocol) SHALL treat that tick as attestation, not pack-fail. The composer SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <bound-loop>` in a separate child that has the producer credential. That child SHALL NOT pass `--observations`. Prepare SHALL keep `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset.

Pack-done SHALL still require `.agent-pipeline/frg/<X.Y.Z>/latest.json` `pass: true` bound to the request candidate. Real ineligible scoreboards (composition missing, required scenarios fail, wrong pack, engine-class over threshold) SHALL remain `frg_not_eligible` / pack-fail. The next identical unsigned eligible score SHALL not require a new mole issue or a human attestor command.

This requirement does not authorize `--skip-frg` as the ship path. It does not persist the key body in ship state. It does not commit `.agent-pipeline/frg/`.

#### Scenario: Omitted HMAC is awaiting attestation

- **WHEN** the bound pack loop is terminal
- **AND** scoreboard and composition meet release-eligibility except HMAC is absent
- **THEN** prepare SHALL return `status: "awaiting_frg_attestation"`
- **AND** it SHALL NOT return `status: "failed"`
- **AND** it SHALL NOT return `defect_class: "frg_not_eligible"`

#### Scenario: Unsigned latest.json stays pass false until attested

- **WHEN** prepare scores a structurally eligible terminal pack without the producer credential
- **THEN** `.agent-pipeline/frg/<X.Y.Z>/latest.json` MAY record `pass: false`
- **AND** that file SHALL NOT record `pass: true` until HMAC is present
- **AND** a composer SHALL NOT treat that `pass: false` as pack-fail

#### Scenario: Composer attests unsigned eligible pass false

- **WHEN** a ship-path composer sees unsigned-eligible omitted-HMAC `latest.json` `pass: false` for version `1.39.5`
- **AND** the bound pack `loop_run_id` is `L`
- **THEN** the composer SHALL invoke `pipeline factory-gate --for 1.39.5 --from-run L` in a child other than prepare
- **AND** that child SHALL have the producer credential
- **AND** that child SHALL NOT pass `--observations`
- **AND** the composer SHALL NOT mark the FRG pack phase failed on that tick

#### Scenario: Real ineligible score still fails closed

- **WHEN** a terminal pack score has composition missing or a required scenario fail
- **THEN** prepare SHALL NOT return `status: "awaiting_frg_attestation"` for omitted HMAC
- **AND** it SHALL return a failure status that names `frg_not_eligible` or the structural defect
- **AND** a composer SHALL fail the FRG pack phase
- **AND** it SHALL NOT invoke `pipeline release` for that version on that evidence

#### Scenario: Next identical unsigned eligible pack needs no new mole

- **WHEN** a later `Ship milestone` scores a terminal structurally eligible pack without HMAC in the prepare child
- **THEN** the same prepare status and composer attest law SHALL run `factory-gate --from-run`
- **AND** the ship SHALL NOT require a human attestor command or a new mole issue to finish the pack

### Requirement: FRG from-run collect SHALL treat GitHub ready-to-deploy as ready over a stale blocked ledger

`factory-gate --from-run` and FRG pack collect SHALL re-observe live GitHub for each pack issue. When an issue carries `pipeline:ready-to-deploy` and its bound PR checks are all green, collect SHALL score that item as finished clean at ready-to-deploy even when the durable loop ledger still records `blocked` or the run stop is `recovery_exhausted`. Collect SHALL still throw when GitHub is not ready-to-deploy or checks are not green. Collect SHALL NOT require a human `ledger.json` edit or `pipeline unblock` as the ship-end path.

#### Scenario: Ledger blocked plus GitHub ready-to-deploy scores ready

- **WHEN** the durable ledger item for issue `#1158` has `state` `blocked`
- **AND** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** the bound PR checks are all green
- **THEN** collect SHALL NOT throw `did not finish clean at ready-to-deploy`
- **AND** HMAC scoring SHALL proceed for that item

#### Scenario: Ledger blocked without GitHub ready still throws

- **WHEN** the durable ledger item is `blocked`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** collect SHALL throw `did not finish clean at ready-to-deploy`

#### Scenario: Ledger ready without GitHub ready still throws

- **WHEN** the durable ledger item is `ready`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** collect SHALL throw `did not finish clean at ready-to-deploy`

#### Scenario: Ledger ready with failed or pending checks still throws

- **WHEN** the durable ledger item is `ready`
- **AND** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** the bound PR checks include a failed or pending check
- **THEN** collect SHALL throw `did not finish clean at ready-to-deploy`

### Requirement: Engine HMAC-verify SHALL present KEY_FILE as KEY

Engine HMAC-verify entries SHALL present the producer credential using one recipe before HMAC mint or verify. Those entries are `pipeline factory-gate --from-run` and `pipeline release ensure-tag`. The recipe SHALL be:

1. If `PIPELINE_FRG_ATTESTATION_KEY` is already set, inherit it and unset `PIPELINE_FRG_ATTESTATION_KEY_FILE` for that HMAC operation.
2. Else if `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty, fail closed with named reason `missing_attestor_credential` (or equivalent) and SHALL NOT mint or verify HMAC.
3. Else if that file is unreadable, fail closed with named reason `unreadable_attestor_key_file` (or equivalent) and SHALL NOT mint or verify HMAC.
4. Else if that file is empty (zero bytes), fail closed with named reason `missing_attestor_credential` (or equivalent) and SHALL NOT mint or verify HMAC.
5. Else set `PIPELINE_FRG_ATTESTATION_KEY` from the file body after removing trailing LF bytes (Tugboat `KEY="$(cat -- "$KEY_FILE")"` command substitution) and unset `PIPELINE_FRG_ATTESTATION_KEY_FILE` for that HMAC operation.

HMAC mint and verify SHALL still authenticate with `PIPELINE_FRG_ATTESTATION_KEY` after presentation. The engine SHALL NOT leave HMAC mint or verify without a credential when `PIPELINE_FRG_ATTESTATION_KEY_FILE` is a readable non-empty file. The engine SHALL NOT require a Tugboat-only env wrap or a human `env PIPELINE_FRG_ATTESTATION_KEY=…` as the product path. GitHub Actions auto-tag SHALL still use repo secret `PIPELINE_FRG_ATTESTATION_KEY`. Unsigned `factory-release prepare` SHALL still have `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in that child. The engine SHALL NOT persist the key body in ship state.

This requirement does not authorize `--skip-frg` as the ship path. It does not authorize tagging from unsigned `pass: true`. It does not place the key body in SKILL.md.

#### Scenario: factory-gate --from-run presents KEY_FILE as KEY

- **WHEN** the process environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file whose body is `dummy-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `pipeline factory-gate --from-run` would mint or verify HMAC
- **THEN** that HMAC operation SHALL use `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key`
- **AND** it SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** it SHALL NOT require a Tugboat env wrap

#### Scenario: release ensure-tag presents KEY_FILE as KEY

- **WHEN** the process environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file whose body is `dummy-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `pipeline release ensure-tag` would verify HMAC
- **THEN** that HMAC operation SHALL use `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key`
- **AND** it SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset
- **AND** it SHALL NOT require a Tugboat env wrap

#### Scenario: KEY_FILE trailing LF is stripped like Tugboat command substitution

- **WHEN** the process environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file whose body is `dummy-key` followed by a trailing LF
- **AND** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `pipeline factory-gate --from-run` or `pipeline release ensure-tag` would mint or verify HMAC
- **THEN** that HMAC operation SHALL use `PIPELINE_FRG_ATTESTATION_KEY` equal to `dummy-key` with no trailing LF
- **AND** the resulting attestation SHALL verify with `dummy-key`

#### Scenario: HMAC inherits KEY and unsets KEY_FILE

- **WHEN** the process environment has `PIPELINE_FRG_ATTESTATION_KEY` set to `inline-key`
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is also set
- **AND** `factory-gate --from-run` or `release ensure-tag` would mint or verify HMAC
- **THEN** that HMAC operation SHALL use `PIPELINE_FRG_ATTESTATION_KEY` equal to `inline-key`
- **AND** it SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: HMAC-verify fails closed without a credential

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` is unset or empty
- **AND** `factory-gate --from-run` or `release ensure-tag` would mint or verify HMAC
- **THEN** the engine SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT mint or verify HMAC

#### Scenario: HMAC-verify fails closed on unreadable KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names an unreadable file
- **AND** `factory-gate --from-run` or `release ensure-tag` would mint or verify HMAC
- **THEN** the engine SHALL fail closed with named reason `unreadable_attestor_key_file` (or equivalent)
- **AND** it SHALL NOT mint or verify HMAC

#### Scenario: HMAC-verify fails closed on empty KEY_FILE

- **WHEN** `PIPELINE_FRG_ATTESTATION_KEY` is unset
- **AND** `PIPELINE_FRG_ATTESTATION_KEY_FILE` names a readable empty file
- **AND** `factory-gate --from-run` or `release ensure-tag` would mint or verify HMAC
- **THEN** the engine SHALL fail closed with named reason `missing_attestor_credential` (or equivalent)
- **AND** it SHALL NOT mint or verify HMAC

#### Scenario: Prepare stays uncredentialed when parent has KEY_FILE

- **WHEN** a ship-path composer invokes `pipeline factory-release prepare`
- **AND** the parent environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set
- **THEN** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Next identical KEY_FILE-only HMAC-verify needs no new mole

- **WHEN** a later Claude Code or Hermes host has only `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file
- **AND** that host runs `factory-gate --from-run` or `release ensure-tag`
- **THEN** the same presentation recipe SHALL supply `PIPELINE_FRG_ATTESTATION_KEY` from that file
- **AND** HMAC mint or verify SHALL NOT require a Tugboat wrap, a human `env PIPELINE_FRG_ATTESTATION_KEY=…`, or a new mole issue

### Requirement: FRG runbook SHALL place factory-release prepare request files outside the target checkout

The Factory Reliability Gate (FRG) runbook SHALL document `--request` as an
absolute path outside the target checkout (`$TMPDIR`,
`AGENT_PIPELINE_STATE_HOME`, or the Tugboat `$RUN_DIR`).
`pipeline factory-release prepare` help SHALL use the same off-repo rule.
They SHALL NOT present `$REPO_DIR/.agent-pipeline/request.json` or another
in-checkout path as the example dest. They SHALL state that an in-checkout
request dirties protected `main` and fails doctor `worktree-clean` on the
pack loop.

#### Scenario: Runbook names an off-repo request dest

- **WHEN** an operator reads the FRG runbook prepare invocation
- **THEN** the documented `--request` path SHALL be outside the target checkout
- **AND** the runbook SHALL name `$TMPDIR`, the state dir, or Tugboat `$RUN_DIR` as valid dests

#### Scenario: Help does not show an in-checkout example dest

- **WHEN** `pipeline factory-release prepare --help` is read
- **THEN** it SHALL NOT use `$REPO_DIR/.agent-pipeline/request.json` as the example dest
- **AND** it SHALL state that `--request` must resolve outside the target checkout

### Requirement: Missing FRG evidence diagnostics SHALL name the pack-loop command and native-goal profile

When Factory Reliability Gate (FRG) evidence is missing, unparsable, or otherwise not release-eligible, `pipeline release`, in-engine `pipeline ship`, and `pipeline factory-gate` (including missing-`--from-run` usage) SHALL name the exact next operator commands required to produce a release-eligible pass. Those commands SHALL include (1) the durable pack loop with a native-`/goal` engine profile, using `pipeline loop --label factory-gate --profile claude` (or an equivalent documented native-`/goal` profile), and (2) the scorer `pipeline factory-gate --for <version> --from-run <loop-run-id>`. Naming only `pipeline factory-gate --for <version>` SHALL NOT satisfy this requirement. Durable `factory-release prepare` MAY appear as an additional line. This requirement SHALL NOT auto-run the pack loop inside ship or release, SHALL NOT change native-`/goal` attestation defaults, and SHALL NOT treat unit CI success as an FRG pass.

#### Scenario: Release missing-pass names loop, profile, and from-run

- **WHEN** `pipeline release <X.Y.Z>` fails closed because `.agent-pipeline/frg/<X.Y.Z>/latest.json` is missing
- **THEN** the failure text SHALL contain `pipeline loop --label factory-gate --profile claude`
- **AND** it SHALL contain `pipeline factory-gate --for <X.Y.Z> --from-run`
- **AND** it SHALL NOT consist only of `Run: pipeline factory-gate --for <X.Y.Z>`

#### Scenario: Factory-gate missing from-run names loop and profile

- **WHEN** an operator runs `pipeline factory-gate --for <X.Y.Z>` without `--from-run`
- **THEN** the usage / failure text SHALL contain `pipeline loop --label factory-gate --profile claude`
- **AND** it SHALL contain `pipeline factory-gate --for <X.Y.Z> --from-run`

#### Scenario: Ship missing FRG names the same runnable path

- **WHEN** in-engine `pipeline ship` fails closed because FRG evidence for the shipment version is missing or not release-eligible
- **THEN** the failure text SHALL contain `pipeline loop --label factory-gate --profile claude`
- **AND** it SHALL contain `pipeline factory-gate --for <version> --from-run`

### Requirement: Missing FRG diagnostics SHALL NOT present skip-frg as the implied recovery

Missing-FRG failure text on `pipeline release`, `pipeline ship`, and `pipeline factory-gate` SHALL NOT present `--skip-frg` as the only next command and SHALL NOT imply `--skip-frg` as the recovery for a non-claude active profile. `--skip-frg` MAY appear as a last-line documented escape. A skip pin SHALL remain a non-production `no-frg-*` marker. Default release and ship SHALL still require a recorded FRG pass.

#### Scenario: Skip is not the only named recovery

- **WHEN** `pipeline release <X.Y.Z>` fails closed because FRG evidence is missing
- **THEN** the failure text SHALL name the pack-loop command and `--from-run` scorer
- **AND** if `--skip-frg` appears, it SHALL NOT be the first or only named recovery
- **AND** the text SHALL NOT tell a non-claude profile that skip is how that profile ships

#### Scenario: Skip escape remains non-production

- **WHEN** an operator uses `pipeline release --skip-frg` (or the equivalent documented escape)
- **THEN** the resulting pin SHALL remain a non-production `no-frg-*` marker
- **AND** it SHALL NOT satisfy a production-quality FRG pin

### Requirement: FRG runbook and supervisor ship text SHALL document already-integrated freeze and the pack-loop profile

The Factory Reliability Gate runbook and supervisor ship documentation SHALL document (1) that `pipeline ship --milestone` on an all-integrated milestone (every freeze-eligible issue closed at `pipeline:ready-to-deploy` with merged contained PRs) proceeds past train freeze and records `already-integrated`, and (2) that a missing FRG pass is recovered by running the `factory-gate` pack loop on a native-`/goal` engine (`--profile claude`) and then `pipeline factory-gate --for <version> --from-run <loop-run-id>`. The docs SHALL NOT present `--skip-frg` as the default or implied path for a non-claude profile.

#### Scenario: Runbook names already-integrated ship freeze

- **WHEN** an operator reads `docs/factory-reliability-gate-runbook.md` after this change
- **THEN** the runbook SHALL state that an all-integrated milestone does not stop at `no open issues to freeze`
- **AND** SHALL state that those items are recorded `already-integrated` before the FRG / release phase

#### Scenario: Runbook and supervisor name pack-loop profile

- **WHEN** an operator reads the FRG runbook or supervisor ship text after this change
- **THEN** the text SHALL name `pipeline loop --label factory-gate --profile claude`
- **AND** SHALL name `pipeline factory-gate --for <version> --from-run <loop-run-id>`
- **AND** SHALL NOT present `--skip-frg` as the default recovery

### Requirement: Missing-FRG diagnostic regressions SHALL be guarded by automated tests

The test suite SHALL fail if a missing-FRG diagnostic for `pipeline release`, `pipeline ship`, or `pipeline factory-gate` omits the pack-loop command or the native-`/goal` profile (`--profile claude`). The suite SHALL fail if that diagnostic names only `pipeline factory-gate --for <version>` as the next command. These tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Scorer-only release diagnostic fails CI

- **WHEN** a hermetic fixture exercises `requireFrgPassForRelease` (or the release missing-pass path) with no FRG artifact
- **AND** the diagnostic omits `pipeline loop --label factory-gate --profile claude` or omits `--from-run`
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Factory-gate usage omission fails CI

- **WHEN** a hermetic fixture exercises `pipeline factory-gate --for <version>` without `--from-run`
- **AND** the usage / failure text omits `--profile claude` or the pack-loop command
- **THEN** the test SHALL fail

### Requirement: FRG observe-path consumers SHALL map tag-path ineligibility to not-observed without matching formatter copy

Ship FRG observation and any other observe-path consumer of the shared tag validator SHALL treat missing, unreadable, or not-release-eligible `.agent-pipeline/frg/<X.Y.Z>/latest.json` as not observed. They SHALL NOT classify that outcome by matching a substring of the tag-path fail-closed message, including `evidence missing`. They SHALL NOT invent a second release-eligibility definition. Tag-path callers (`release ensure-tag`, `--validate-tag`, and auto-tag when Factory Reliability Gate evidence is not gitignored) SHALL keep fail-closed with the existing remediating message that names `latest.json` and `factory-release prepare` or the Tugboat FRG pack phase.

#### Scenario: Observe mapping does not key off formatter copy

- **WHEN** the shared tag validator fails because `latest.json` is missing, unreadable, or not release-eligible
- **AND** the caller is observing whether a pack has produced release-eligible evidence
- **THEN** the caller SHALL treat the outcome as not observed
- **AND** that classification SHALL remain correct if the tag-path fail-closed message no longer contains `evidence missing`
- **AND** the caller SHALL NOT match `evidence missing` or any other tag-path formatter substring as the only not-observed signal

#### Scenario: Tag path stays fail-closed on the same missing file

- **WHEN** `release ensure-tag` or `--validate-tag` runs for version `1.39.14`
- **AND** `.agent-pipeline/frg/1.39.14/latest.json` is absent or not release-eligible
- **THEN** validation SHALL fail closed
- **AND** the message SHALL name `.agent-pipeline/frg/1.39.14/latest.json`
- **AND** the command SHALL NOT create or push `v1.39.14`

#### Scenario: Observe mapping reuses tag eligibility, not a second checker

- **WHEN** observe-path mapping decides that `latest.json` is not release-eligible
- **THEN** that decision SHALL use the same eligibility rules as the shared tag validator
- **AND** it SHALL NOT accept a `pass: false` or HMAC-invalid artifact as observed evidence

### Requirement: From-run hybrid-v2 collect SHALL stamp the request packed candidate, not control HEAD

Hybrid-v2 collect for `pipeline factory-gate --from-run` (and the in-process equivalent) SHALL set `pack_provenance.candidate_git_sha` to one packed-candidate OID `C` resolved from named sources, not from `git rev-parse HEAD` of the factory control checkout `repoDir`. The named sources SHALL be (1) scored-loop `factory-release-binding.json` `candidate_git_sha` when that file is present and (2) factory-release request `integrated_candidate.git_sha` when the in-process scorer holds the request. Collect SHALL normalize each value to an exact 40-hex OID. When both values are in hand, collect SHALL require equality. A request-bound ship-path score (request SHA provided, or binding file present) SHALL fail closed before Layer A probes or evidence write when the binding file is missing, a present source is malformed, or the two parsed OIDs conflict. A present malformed source SHALL NOT fall back to the other source or to control HEAD. CLI `--from-run` without a request object SHALL use a present valid loop binding as `C`. Standalone `--from-run` (no request object and no binding file) MAY keep `git rev-parse HEAD` of `repoDir`. Request-bound ship-path collect SHALL NOT call `git rev-parse HEAD` of `repoDir` for identity. Fast-forwarding the control checkout SHALL NOT be required for collect to stamp the packed candidate. Skipping HMAC SHALL NOT be the path.

#### Scenario: Control checkout behind the train stamps the request candidate

- **WHEN** factory-release request `integrated_candidate.git_sha` is packed candidate `C`
- **AND** the factory control checkout HEAD is pin `P`
- **AND** `P` is not `C`
- **AND** `factory-gate --from-run` collects hybrid-v2 provenance
- **THEN** `pack_provenance.candidate_git_sha` SHALL equal `C`
- **AND** it SHALL NOT equal `P`

#### Scenario: Missing ship-path binding does not stamp control HEAD

- **WHEN** a request-bound ship-path `--from-run` score has no factory-release loop binding packed-candidate SHA
- **THEN** collect SHALL fail closed
- **AND** it SHALL NOT write `pack_provenance.candidate_git_sha` from control-checkout HEAD

#### Scenario: Collect regression fails when provenance stamps the pin

- **WHEN** a unit test provides `repoDir` HEAD pin `P` and request packed candidate `C`
- **AND** collected provenance sets `pack_provenance.candidate_git_sha` to `P`
- **THEN** that test SHALL fail

#### Scenario: Binding and request agree on packed candidate C

- **WHEN** loop `factory-release-binding.json` `candidate_git_sha` is packed candidate `C`
- **AND** in-process request `integrated_candidate.git_sha` is packed candidate `C`
- **AND** control checkout HEAD is pin `P` that is not `C`
- **THEN** collect SHALL set `pack_provenance.candidate_git_sha` to `C`
- **AND** it SHALL NOT call `git rev-parse HEAD` of `repoDir` for identity

#### Scenario: Conflicting request and binding fail closed

- **WHEN** loop binding `candidate_git_sha` is packed candidate `C`
- **AND** request `integrated_candidate.git_sha` is a different exact 40-hex OID
- **THEN** collect SHALL fail closed before Layer A probes
- **AND** it SHALL NOT write `pack_provenance.candidate_git_sha`

#### Scenario: Present malformed binding does not fall back

- **WHEN** the loop binding file is present
- **AND** `candidate_git_sha` is missing or is not an exact 40-hex OID
- **THEN** collect SHALL fail closed
- **AND** it SHALL NOT use request `integrated_candidate.git_sha` as a fallback from that present invalid binding
- **AND** it SHALL NOT use control-checkout HEAD

#### Scenario: Standalone from-run without binding keeps repoDir HEAD

- **WHEN** `factory-gate --from-run` has no factory-release request object
- **AND** the scored loop has no `factory-release-binding.json`
- **THEN** collect MAY set `pack_provenance.candidate_git_sha` from `git rev-parse HEAD` of `repoDir`

### Requirement: Layer A probe records SHALL use the same packed-candidate OID as pack provenance

Every Layer A probe record produced by from-run hybrid-v2 collect SHALL set `candidate_git_sha` to the same packed-candidate OID as `pack_provenance.candidate_git_sha`. Layer A probes for that score SHALL execute against candidate engine sources for that OID. Collect SHALL resolve those sources with the existing candidate-engine resolver at packed candidate `C` and SHALL pass the resolved engine root as the probe working directory. They SHALL NOT treat factory control checkout HEAD as the candidate identity when it differs. Collect SHALL fail closed when it cannot resolve a clean checkout whose HEAD is `C`. Collect SHALL fail closed rather than bind TAP output from pin sources to the packed candidate.

#### Scenario: Probe records match pack provenance

- **WHEN** hybrid-v2 collect stamps `pack_provenance.candidate_git_sha` `C`
- **THEN** every Layer A probe record `candidate_git_sha` SHALL equal `C`

#### Scenario: Probes run on candidate engine sources for C

- **WHEN** control checkout HEAD is pin `P`
- **AND** packed candidate is `C`
- **AND** `P` is not `C`
- **AND** from-run collect runs Layer A probes
- **THEN** those probes SHALL execute against engine sources for `C`
- **AND** the probe working directory SHALL be the resolved candidate engine root for `C`
- **AND** that directory SHALL NOT be the control checkout `repoDir` when `repoDir` HEAD is `P`
- **AND** collect SHALL NOT hash pin-source TAP output and label it `C`

#### Scenario: Unresolved candidate engine for C fails closed

- **WHEN** packed candidate is `C`
- **AND** collect cannot resolve a clean candidate engine checkout whose HEAD is `C`
- **THEN** collect SHALL fail closed before Layer A TAP
- **AND** it SHALL NOT write provenance that binds pin-source TAP to `C`

### Requirement: FRG from-run throughput SHALL count GitHub ready-to-deploy as clean-ready over a stale blocked ledger

FRG throughput scoring on `factory-gate --from-run` and `factory-release prepare` (which scores through that from-run path) SHALL count a pack item as clean-ready when live GitHub shows `pipeline:ready-to-deploy` and the bound PR checks are all green, even when the durable loop ledger still records that item as `blocked` and even when the run stop is `recovery_exhausted`. The overlay SHALL be the same GitHub ready-to-deploy plus green-checks class that FRG pack collect already uses (`githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub`). Collect overlay SHALL remain. The overlay SHALL consume injected per-item GitHub observations (labels, bound PR number, checks on that PR's head). The from-run projector SHALL decide that class independently of ledger state. When that proof is absent, the overlay SHALL NOT count a ledger `ready`, `merged`, or `released` item as clean-ready: it SHALL clear `ready_clean` and project an ineligible state. When that proof is present, a ledger `merged` or `released` item SHALL stay at that terminal state and count as clean-ready. `itemsFromLoopLedger` SHALL remain a pure ledger projector and SHALL NOT read GitHub. The factory-gate `startLoop` scoring path SHALL remain ledger-only. Throughput SHALL NOT require a human `ledger.json` edit, a `ledger.stop` delete, or `pipeline unblock` as the ship-end path. Throughput SHALL NOT count `needs-human` as clean-ready. Throughput SHALL still treat an item as not clean-ready when GitHub is not ready-to-deploy, the bound PR is absent, GitHub state is missing or unreadable, or checks are not green.

#### Scenario: Sibling single finishes the pack item

- **WHEN** pack ledger item `#1290` has `state` `blocked`
- **AND** the run stop is `recovery_exhausted`
- **AND** a sibling item in the same two-item pack is already ledger-ready
- **AND** live GitHub labels for `#1290` include `pipeline:ready-to-deploy`
- **AND** the bound PR checks for `#1290` are all green
- **AND** `factory-gate --from-run` or prepare scores the bound pack
- **THEN** `clean-item-throughput` SHALL count `#1290` as clean-ready
- **AND** observed clean-ready count for that two-item pack SHALL NOT be `1` against `K=2` solely because the ledger is stale

#### Scenario: Throughput overlay matches collect overlay class

- **WHEN** live GitHub for a pack item includes `pipeline:ready-to-deploy` and green checks on the bound PR
- **AND** the durable ledger still records that item as `blocked`
- **THEN** from-run throughput scoring SHALL count the item as clean-ready
- **AND** collect SHALL still treat the same GitHub identity as finished clean at ready-to-deploy

#### Scenario: Ledger blocked without GitHub ready is not clean-ready

- **WHEN** the durable ledger item is `blocked`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready

#### Scenario: Failed or pending checks are not clean-ready

- **WHEN** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** the bound PR checks include a failed or pending check
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready solely from the ready-to-deploy label

#### Scenario: Absent or unbound PR is not clean-ready

- **WHEN** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** there is no bound pack PR for that item, or the only green checks belong to a different PR
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready

#### Scenario: Missing or unreadable GitHub is not clean-ready

- **WHEN** the durable ledger item is `blocked`
- **AND** issue, PR, or check observations are missing or unreadable
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready
- **AND** the projector SHALL keep the ledger state for that item

#### Scenario: Missing or unbound GitHub does not count a ledger-ready item as clean-ready

- **WHEN** the durable ledger item is `ready`
- **AND** issue, PR, or check observations are missing or unreadable, or there is no bound pack PR
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready
- **AND** the overlay SHALL clear `ready_clean` and project an ineligible state

#### Scenario: Missing or invalid GitHub does not count a ledger-merged or ledger-released item as clean-ready

- **WHEN** the durable ledger item is `merged` or `released`
- **AND** issue, PR, or check observations are missing or unreadable, or there is no bound pack PR, or labels do not include `pipeline:ready-to-deploy`, or bound-PR checks are not green
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready
- **AND** the overlay SHALL clear `ready_clean` and project an ineligible state

#### Scenario: Proven GitHub class preserves ledger merged and released

- **WHEN** the durable ledger item is `merged` or `released`
- **AND** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** the bound PR checks are all green
- **THEN** `clean-item-throughput` SHALL count that item as clean-ready
- **AND** the overlay SHALL preserve the ledger terminal state

#### Scenario: needs-human is not clean-ready

- **WHEN** live GitHub labels include `pipeline:needs-human`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready

#### Scenario: itemsFromLoopLedger stays a pure projector

- **WHEN** a caller invokes `itemsFromLoopLedger` with no GitHub observations
- **THEN** the projector SHALL return `ready_clean` from ledger `state` only
- **AND** it SHALL NOT read GitHub

#### Scenario: Next identical stale-ledger R2D pack needs no new mole

- **WHEN** a later pack item is GitHub ready-to-deploy with green checks on the bound PR
- **AND** the durable ledger still records `blocked` with stop `recovery_exhausted`
- **THEN** the same overlay SHALL count that item as clean-ready
- **AND** the ship SHALL NOT require a human `ledger.json` edit or a new mole issue to score throughput

### Requirement: Bound pack-loop liveness SHALL require acknowledged process identity and a fresh heartbeat

After a valid `loop_run_handoff` for bound loop `L`, ship-path Factory Reliability Gate (FRG) pack composers SHALL treat `L` as live only when the exact PID, process-start identity, and boot identity in `supervisor.json` still match that acknowledgement and the supervisor heartbeat for `L` is fresh under the engine stale threshold. A non-terminal ledger, the absence of `ledger.stop`, and the absence of terminal events SHALL NOT prove live. A dead-or-missing lock pid SHALL NOT classify as live. False live SHALL NOT disable the wait cap. Unreadable identity evidence SHALL consume the normal bounded observation window and then fail closed with a typed observer or identity error. Unreadable identity SHALL NOT authorize resume and SHALL NOT count as live after that window. The next identical dead-pack stall SHALL not require a new mole issue.

#### Scenario: Dead pid plus open ledger is not live

- **WHEN** lock pid for bound loop `L` is dead or missing
- **AND** a ledger for `L` is present without `stop`
- **AND** events for `L` are not terminal
- **THEN** liveness SHALL NOT be `live`
- **AND** the wait cap SHALL remain applicable

#### Scenario: Never-dispatched non-terminal ledger is not live

- **WHEN** bound loop `L` has never produced a valid `loop_run_handoff`
- **AND** a non-terminal ledger for `L` exists
- **THEN** liveness SHALL NOT be `live`

#### Scenario: Stale heartbeat is not live

- **WHEN** `supervisor.json` for bound loop `L` names a pid
- **AND** that pid is alive
- **AND** the heartbeat is older than the engine stale threshold
- **THEN** liveness SHALL NOT be `live`

#### Scenario: PID reuse is not live

- **WHEN** a later process reuses the numeric pid recorded for bound loop `L`
- **AND** process-start identity or boot identity does not match the acknowledged `supervisor.json` record
- **THEN** liveness SHALL NOT be `live`

#### Scenario: Unreadable identity fails closed after the observation window

- **WHEN** lock or `supervisor.json` identity evidence for bound loop `L` is unreadable or malformed
- **AND** the bounded observation window has expired
- **THEN** liveness SHALL NOT remain unknown-as-live
- **AND** the composer SHALL fail closed with a typed observer or identity error
- **AND** it SHALL NOT authorize resume from that unreadable evidence

### Requirement: Pack-loop spawn SHALL surface bounded child stderr in ship last_error

Pack-loop spawn SHALL NOT ignore the child's stderr. Spawn SHALL drain stdout and stderr pipes so the child cannot block. A child exit (`0` or non-zero) before handoff, and a non-zero exit after, SHALL capture bounded (16 KiB head + 16 KiB tail), redacted stderr in pipeline-owned evidence before persist. Redaction SHALL use the existing artifact sanitize path. If evidence write fails, the tick SHALL still fail closed and `last_error` SHALL name the exit or spawn error and the write failure. Ship `last_error` SHALL include the exit status or error code, a safe excerpt, and the evidence location. Catalogue validation text (or equivalent stderr) SHALL be visible in that diagnostic.

#### Scenario: Crash is visible and not false-live

- **WHEN** the pack child exits 1 before `ledger.stop`
- **AND** ship classifies liveness
- **THEN** the result SHALL NOT be `live`
- **AND** `last_error` SHALL contain the catalogue message or equivalent stderr
- **AND** `last_error` SHALL name the evidence location

#### Scenario: Stderr is not ignored

- **WHEN** pack-loop spawn launches the child
- **THEN** the child's stderr SHALL NOT be `stdio: "ignore"`
- **AND** a later non-zero exit SHALL still have a bounded redacted excerpt in pipeline-owned evidence

#### Scenario: Evidence write failure still reports the exit

- **WHEN** the pack child exits non-zero
- **AND** the stderr evidence file cannot be written
- **THEN** that tick SHALL fail closed
- **AND** `last_error` SHALL still name the exit status
- **AND** `last_error` SHALL name the evidence-write failure

### Requirement: Pack-loop dispatch tests SHALL bite mixed-binary spawn and false-live

The test suite SHALL fail if candidate prepare writes `publish_unpublished_stage_commit` into the contract and the spawned loop binary is the pin catalogue that rejects that recipe. The mixed-binary test SHALL assert the actual spawned executable path, not only argv and not a mocked candidate catalogue in place of that path. The suite SHALL fail if dead pid plus no `ledger.stop` plus no terminal events classifies as `live`. Coverage SHALL include candidate-versus-pin execution, OS spawn error/throw, zero and nonzero pre-handoff exits, crash after OS accept, handoff SHA mismatch, valid handoff followed by immediate death, concurrent prepare reconciliation, PID reuse, fresh/stale/malformed/future heartbeat, unreadable evidence inside and outside the durable window, one-resume-then-terminal behavior, diagnostic propagation, and false-live rejection. Tests SHALL inject fake Spawn/ChildProcess, store, PID probe, clock, and timers. Tests SHALL perform no real network, git, or subprocess calls.

#### Scenario: Mixed-binary spawn regression bites

- **WHEN** a unit test supplies candidate SHA `C` whose catalogue includes `publish_unpublished_stage_commit`
- **AND** PATH `pipeline` is pin `P` whose catalogue rejects that recipe
- **AND** `PIPELINE_BIN` is unset
- **THEN** the test SHALL fail if the captured spawn executable is pin `P` or PATH `pipeline`
- **AND** it SHALL pass when the captured spawn executable is the candidate launcher for `C`

#### Scenario: False-live regression bites

- **WHEN** a unit test supplies a dead-or-missing lock pid
- **AND** a present ledger with no `stop`
- **AND** non-terminal events
- **THEN** the test SHALL fail if liveness is `live`

### Requirement: environment-auth durable themes SHALL score as product-class, not engine-class

The FRG blocker taxonomy SHALL treat durable theme `environment-auth` as `product-class`. A scored pack item whose blocker theme is `environment-auth` SHALL increment product-class counts and SHALL NOT increment `engine_class_count`. The taxonomy SHALL NOT treat that theme as `workflow-engine-defect` or `engine-class`. This scenario is a classification honesty check. The live FRG pack SHALL NOT require a revoked third-party credential as a pack item.

#### Scenario: classifyFrgBlocker maps environment-auth to product-class

- **WHEN** FRG blocker taxonomy is applied to theme `environment-auth`
- **THEN** the result SHALL be `product-class`
- **AND** SHALL NOT be `engine-class` or `human-authority`

#### Scenario: Pack item themed environment-auth does not inflate engine-class rate

- **WHEN** a scored pack has one processed item blocked with theme `environment-auth` and no engine-class items
- **THEN** `engine_class_count` SHALL be 0
- **AND** the product-class count SHALL include that item
- **AND** `engine_class_rate` SHALL be 0

#### Scenario: Mis-themed credential failure is the regression the scenario bites

- **WHEN** the same item is instead themed `workflow-engine-defect`
- **THEN** that item SHALL count as engine-class
- **AND** a unit test SHALL fail if classifier fixtures that represent harness 401 / `refresh_token_invalidated` would produce that engine-class theme
