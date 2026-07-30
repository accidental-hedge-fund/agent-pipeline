## ADDED Requirements

### Requirement: A named ordered-pair treatment SHALL declare primary and reviewer role coordinates

The evaluation system SHALL support a named-pair treatment form in which each treatment is
an ordered pair with a stable unique `id`, a `primary` role coordinate set, and a
`reviewer` role coordinate set. Each role coordinate set SHALL declare a `harness` and MAY
declare role-local `model` and `effort` (and other allowlisted role-local fields). The pair
identity and the exact per-role coordinates SHALL be preserved through plan expansion and
on every cell and grade record derived from that treatment.

#### Scenario: A complete named pair is accepted

- **WHEN** a manifest declares a named pair with unique `id`, `primary.harness`, and
  `reviewer.harness`
- **THEN** validation SHALL accept the pair
- **AND** the expanded plan cell for that pair SHALL carry the same `id` and the same
  primary and reviewer coordinates

#### Scenario: Pair identity is stable across expansion

- **WHEN** the same named-pair manifest is expanded twice
- **THEN** each pair's `treatment_id` SHALL equal its declared `id` on every corresponding
  cell in both plans

---

### Requirement: The implementing-paired mode SHALL run primary implement, reviewer review, conditional primary fix, and re-review

In `implementing-paired` mode the runner SHALL, within a single cell worktree: invoke the
primary role to implement; collect the actual git diff; invoke the reviewer role on that
diff; when production review-policy partitioning classifies any finding as blocking, invoke
the primary role to fix and then invoke the reviewer role again on the post-fix diff; when
no finding is blocking, skip fix and the second review. The runner SHALL NOT fabricate an
additional review beyond that re-review.

#### Scenario: No blocking findings skips fix

- **WHEN** the first review yields zero blocking findings under production review policy
- **THEN** the primary fix stage SHALL NOT run
- **AND** the cell record SHALL indicate that fix was not invoked

#### Scenario: Blocking findings trigger fix and re-review

- **WHEN** the first review yields one or more blocking findings
- **THEN** the primary fix stage SHALL run against those findings
- **AND** the reviewer SHALL be invoked a second time on the actual post-fix git diff

#### Scenario: Reviewer receives the actual primary diff

- **WHEN** the primary implementation produces a non-empty worktree diff
- **THEN** the reviewer invocation's input SHALL include that actual diff
- **AND** SHALL NOT substitute the fixture's frozen review stage-entry artifact as the sole
  review body in place of that diff

---

### Requirement: The pipeline-paired mode SHALL execute the deployable multi-stage graph with live handoffs

In `pipeline-paired` mode the runner SHALL execute, within a single cell worktree, the
ordered graph: primary planning → independent reviewer plan-review → primary plan revision
(when plan-review feedback requires it) → primary implementation → reviewer standard
review → primary fix-1 when blocking → reviewer adversarial review → primary fix-2 when
blocking. Each stage SHALL receive live handoff artifacts produced earlier in the same
cell: plan, plan-review feedback, revised plan, current diff, formatted review-1 context,
and blocking findings as applicable. After fix-2 the runner SHALL NOT fabricate a third
review; review-2 / pre-fix-2 findings SHALL be labeled separately from the final post-fix-2
worktree state.

#### Scenario: Deployable graph order is observed

- **WHEN** a `pipeline-paired` cell executes successfully through implementation
- **THEN** planning SHALL complete before plan-review
- **AND** plan-review SHALL complete before plan revision or implementation
- **AND** implementation SHALL complete before standard review

#### Scenario: Live handoffs carry predecessor outputs

- **WHEN** the reviewer plan-review stage runs
- **THEN** its input SHALL include the plan text produced by the primary planning stage of
  the same cell

#### Scenario: No third review after fix-2

- **WHEN** adversarial review yields blocking findings and primary fix-2 completes
- **THEN** the cell SHALL end without an additional review invocation
- **AND** the cell record SHALL distinguish review-2 findings from the final post-fix-2
  worktree state

#### Scenario: Plan revision is skipped when plan-review has no blocking feedback

- **WHEN** plan-review produces no blocking feedback under production policy
- **THEN** primary plan revision SHALL NOT run
- **AND** implementation SHALL use the original plan
- **AND** the cell record SHALL indicate that plan revision was not invoked

---

### Requirement: Paired stages SHALL reuse production prompt builders and output gates

Every planning, plan-review, review, and fix invocation in a paired mode SHALL build its
prompt through the production prompt builders/templates used by the live pipeline for the
corresponding stage, and SHALL apply the production output/verdict gates and parsers.
Implementation and fix invocations MAY append only an evaluation-specific no-commit /
no-push execution override; they SHALL NOT replace the production content contract with an
eval-local substitute schema.

#### Scenario: Review uses the production verdict contract

- **WHEN** a paired-mode reviewer stage is invoked
- **THEN** its prompt SHALL carry the production structured verdict contract
- **AND** its stdout SHALL be parsed by the production review verdict parsers

#### Scenario: Implementation override is limited to execution constraints

- **WHEN** a paired-mode primary implementation or fix stage is invoked
- **THEN** the prompt MAY include an eval no-commit/no-push override
- **AND** SHALL still be built from the production implementation or fix prompt path rather
  than a one-line eval-only instruction alone

---

### Requirement: Malformed review output SHALL never be treated as approval

The runner SHALL never treat unparseable paired-mode review output as approval. When a
paired-mode review invocation's output cannot be parsed into a production verdict, the
runner SHALL record an explicit unparseable (or equivalent non-approval) provenance for that
review step, SHALL NOT treat the result as an empty-findings approval, and SHALL NOT clear
blocking disposition. Strict, tolerant, and unparseable parse outcomes SHALL be reported
separately for each review invocation in the cell record.

#### Scenario: Unparseable review is not approval

- **WHEN** a reviewer returns prose that is not a parseable verdict
- **THEN** the cell record SHALL mark that review step's parse provenance as unparseable
- **AND** the runner SHALL NOT proceed as if the review approved the change

#### Scenario: Strict and tolerant provenance are distinct

- **WHEN** one review step parses strictly and another parses only under the tolerant path
- **THEN** the cell record SHALL report distinct provenance values for those two steps

---

### Requirement: Production review-policy partitioning SHALL decide blocking findings in paired modes

Paired-mode review steps SHALL classify findings into blocking vs non-blocking using the
same review-policy partitioning the production pipeline uses (severity threshold and
minimum confidence). Only blocking findings SHALL trigger a primary fix round for that
review step.

#### Scenario: Advisory findings do not trigger fix

- **WHEN** a review yields findings that production policy classifies as non-blocking
- **THEN** the corresponding primary fix stage SHALL NOT run solely because of those
  findings

#### Scenario: Blocking findings trigger fix

- **WHEN** a review yields findings that production policy classifies as blocking
- **THEN** the corresponding primary fix stage SHALL run

---

### Requirement: Role failures SHALL be attributed to primary or reviewer

The runner SHALL attribute harness preflight and authentication failures to the role that
failed. When a harness preflight or authentication failure prevents a role invocation, the
cell SHALL record which role failed (`primary` or `reviewer`), SHALL classify the cell with
the appropriate non-quality result class (`auth_error` or `infra_error`), and SHALL NOT
count the cell as a successful treatment quality outcome.

#### Scenario: Primary auth failure is attributed to primary

- **WHEN** the primary harness fails authentication before implementation
- **THEN** the cell SHALL record `failed_role` of `primary`
- **AND** SHALL use result class `auth_error`
- **AND** SHALL NOT invoke the reviewer for that cell

#### Scenario: Reviewer auth failure is attributed to reviewer

- **WHEN** primary implementation succeeds and the reviewer harness fails authentication
- **THEN** the cell SHALL record `failed_role` of `reviewer`
- **AND** SHALL use result class `auth_error`

---

### Requirement: Per-cell timeout SHALL span the entire pair loop

The manifest's per-cell `timeout` SHALL be a single wall-clock budget covering every
primary and reviewer invocation in that cell's pair loop. When the budget is exceeded, the
runner SHALL terminate the cell and record `result_class` `timeout` rather than a completed
treatment outcome.

#### Scenario: Timeout during re-review is a cell timeout

- **WHEN** primary implement, first review, and fix complete but the re-review exceeds the
  remaining per-cell timeout
- **THEN** the cell SHALL be recorded as `timeout`
- **AND** SHALL NOT be recorded as `completed`

---

### Requirement: Paired cell evidence SHALL record pair-loop diagnostics

Every completed or failed paired cell record SHALL include evidence sufficient to
reconstruct the pair loop: pair identity, primary and reviewer coordinates as executed,
whether each fix round was invoked, blocking finding counts before and after each
applicable fix, per-review parse provenance, duration, and any failed role. Summary output
derived from paired experiments SHALL surface pair identity, fix invocation, blocking
findings before/after, malformed review counts, quality, duration, and reliability.

#### Scenario: Completed pair cell carries loop evidence

- **WHEN** an `implementing-paired` cell completes after a fix-and-re-review path
- **THEN** its record SHALL include pair identity, `fix_invoked` true, blocking counts
  before and after fix, and parse provenance for each review step

#### Scenario: Summary includes pair diagnostics

- **WHEN** a summary is produced for an experiment containing named-pair treatments
- **THEN** the summary SHALL name each pair treatment
- **AND** SHALL report fix-invocation and malformed-review metrics for those treatments
  alongside quality, duration, and reliability

---

### Requirement: Pipeline-paired mode SHALL preserve slot coupling and reviewer overrides

`pipeline-paired` execution SHALL honor repository pipeline.yml implementer/reviewer slot
coupling and structured reviewer override settings (model, effort, prompt-delivery) except
where the cell's named pair coordinates explicitly override a role field as the
experimental variable. Conflicting production reviewer declarations SHALL fail closed as
they do in production rather than silently picking one.

#### Scenario: Pair coordinates override slot defaults

- **WHEN** pipeline.yml declares implementer `claude` and a pair declares
  `primary.harness: codex`
- **THEN** the primary invocations for that cell SHALL use `codex`

#### Scenario: Structured reviewer settings apply when the pair leaves a field unset

- **WHEN** a pair declares `reviewer.harness` but omits `effort`, and pipeline.yml's
  structured reviewer settings declare an effort
- **THEN** the reviewer invocation SHALL use that configured effort

---

### Requirement: Paired execution SHALL perform no production GitHub writes

Every stage of a paired cell SHALL run under the evaluation no-write guarantees: no label
mutation, no comment create/edit, no pull-request create/edit/merge, and no push to a
production branch. Refusals and process-boundary denials SHALL be recorded on the cell.

#### Scenario: Full pair loop writes nothing to production GitHub

- **WHEN** an `implementing-paired` or `pipeline-paired` cell executes its full graph
- **THEN** no mutating production GitHub operation SHALL succeed
- **AND** any attempted mutation SHALL be refused or denied and recorded
