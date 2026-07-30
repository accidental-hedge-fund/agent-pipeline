## ADDED Requirements

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

- **WHEN** an FRG evidence artifact exists with `version: 1.29.1`, `pass: true`, and a non-empty
  `run_id`
- **THEN** the FRG precondition for version `1.29.1` SHALL be satisfied
- **AND** the FRG precondition for a different version `1.30.0` SHALL remain unsatisfied until a
  separate pass artifact for `1.30.0` exists

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
  any scenario is `fail` or `not_observed`
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
by existing release and golden-rule constraints. FRG observes factory outcomes and records pass/fail
only.

#### Scenario: Passing FRG does not merge

- **WHEN** a live FRG run reaches `pass: true`
- **THEN** the driver SHALL NOT merge any pull request
- **AND** SHALL NOT create a git tag for the version as a side effect of the FRG run itself
