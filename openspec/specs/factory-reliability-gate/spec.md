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

