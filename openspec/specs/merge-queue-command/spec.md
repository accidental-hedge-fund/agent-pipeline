# merge-queue-command Specification

## Purpose
TBD - created by archiving change merge-queue-human-gated-dry-run. Update Purpose after archive.
## Requirements
### Requirement: The pipeline CLI SHALL accept a human-invoked `merge-queue` sub-command
The pipeline CLI SHALL accept `merge-queue` as a positional sub-command keyword
that plans a sequential merge queue for ready-to-deploy PRs under an explicit
operator invocation. It SHALL be dispatched when the first positional argument
is the string `merge-queue` (case-sensitive). The command SHALL NOT be invoked by
the autonomous `advance` loop or by any stage handler reachable from
`pipeline advance`.

#### Scenario: Invoked by a human with a milestone selector
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.28.2"`
- **THEN** the command dispatches the merge-queue handler in dry-run mode
- **AND** does not advance any pipeline stage label

#### Scenario: Missing selector exits with a usage error
- **WHEN** the user runs `pipeline merge-queue` without `--milestone` (and without
  any other supported selector if added later)
- **THEN** the command SHALL exit non-zero with a usage error stating that a
  selector such as `--milestone` is required
- **AND** SHALL NOT call any merge or label-mutation path

#### Scenario: Unknown keyword is not merge-queue
- **WHEN** the user runs `pipeline merge 42`
- **THEN** the command SHALL dispatch the existing merge handler, not merge-queue

---

### Requirement: Merge-queue dry-run SHALL be the default and SHALL perform zero mutations
The merge-queue command SHALL default to dry-run mode. In dry-run mode the
handler SHALL inspect GitHub state and print a plan only. It SHALL NOT invoke
`gh pr merge`, push, force-push, delete a branch, add/remove labels, close
issues, create comments, or otherwise mutate repository or issue state. An
explicit `--dry-run` flag SHALL be accepted as affirming the default. Until a
documented apply/drive mode is implemented (follow-up), any explicit apply/drive
flag SHALL fail closed with a non-zero exit and an actionable message rather
than partially mutating.

#### Scenario: Default invocation is dry-run with no merges
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.28.2"`
- **THEN** the handler SHALL run in dry-run mode
- **AND** SHALL NOT call any merge primitive or mutating GitHub write

#### Scenario: Explicit --dry-run is accepted
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.28.2" --dry-run`
- **THEN** the handler SHALL produce the same class of plan output as the default
- **AND** SHALL NOT mutate GitHub state

#### Scenario: Premature apply/drive fails closed
- **WHEN** the user passes an apply/drive option that requests real merges before
  that mode is implemented
- **THEN** the command SHALL exit non-zero explaining that drive is not available
- **AND** SHALL NOT merge any PR

#### Scenario: Dry-run is idempotent
- **WHEN** the user runs the same dry-run invocation twice against unchanged
  GitHub state
- **THEN** both runs SHALL report the same ordered merge-candidate set and the
  same skip set (same issue/PR identities and order)
- **AND** neither run SHALL mutate GitHub state

---

### Requirement: Merge-queue selection SHALL include only selector-matched ready-to-deploy issues with mergeable open PRs
Given a required `--milestone <title>` selector, the handler SHALL discover open
issues in the configured repository that belong to that milestone, retain only
issues that carry the label `pipeline:ready-to-deploy`, resolve each remaining
issue to an open PR via the authoritative issue→PR resolver (`getPrForIssue`
semantics: branch-prefix or closing references, not body-text mention), and
build the **merge-candidate** list from PRs that are mergeable and clean.

Milestone-issue discovery and open-PR resolution SHALL be **exhaustive** (paginate
to completion; no hard first-page / first-500 truncation). `missing-pr` SHALL be
emitted only after a completed successful search finds no open linked PR.
Command, API, authentication, and parse failures during discovery or resolution
SHALL fail the dry-run (non-zero / thrown error) rather than masquerading as
`missing-pr` or an empty successful plan.

A PR SHALL be excluded from the merge-candidate list when any of the following
hold:

- the issue lacks `pipeline:ready-to-deploy`
- no open linked PR is found
- the PR's `baseRefName` does not match the configured integration base branch
  (`base_branch` / `--base`)
- `mergeable` is not `MERGEABLE` or `mergeStateStatus` is not `CLEAN`
- the required-check gate equivalent to `pipeline merge` does not pass (any
  required check not in a non-blocking bucket; when the repository has no
  required checks, mirror the existing merge sub-command fallback policy rather
  than inventing a looser rule). Non-zero `gh pr checks` exits that still emit
  check JSON on stdout (e.g. pending exit code 8) SHALL be treated as check
  status data and classified under this gate, not as a fatal command failure.

Excluded items SHALL still be reportable in the dry-run output as skipped with a
stable reason code (at least: `not-ready-to-deploy` is not listed as a candidate
because filtered earlier; `missing-pr`; `wrong-base`; `non-mergeable`;
`checks-not-green`).

#### Scenario: Only R2D issues become candidates
- **WHEN** a milestone contains issue A with `pipeline:ready-to-deploy` and an
  open mergeable PR, and issue B in the same milestone at `pipeline:pre-merge`
- **THEN** only issue A SHALL appear in the merge-candidate list
- **AND** issue B SHALL NOT appear as a merge candidate

#### Scenario: Missing open PR is excluded
- **WHEN** an issue carries `pipeline:ready-to-deploy` and matches the milestone
- **AND** the authoritative resolver returns no open PR after a completed
  exhaustive search
- **THEN** that issue SHALL NOT appear in the merge-candidate list
- **AND** dry-run SHALL report it as skipped with reason `missing-pr`

#### Scenario: Milestone issues beyond a first-page/500 cap are still discovered
- **WHEN** a milestone has more than 500 open issues including an R2D issue past
  the first 500
- **THEN** discovery SHALL still include that issue in the selector-matched set
- **AND** SHALL NOT truncate the list with a hard `--limit 500` (or equivalent)

#### Scenario: Open PR beyond the first 100 open PRs is still resolved
- **WHEN** an R2D issue's linked open PR falls outside the first 100 open PRs in
  repository list order
- **THEN** the authoritative paginated resolver SHALL still resolve that PR
- **AND** the issue SHALL NOT be reported as `missing-pr` solely due to list truncation

#### Scenario: Resolver or discovery failure fails closed
- **WHEN** milestone listing or issue→PR resolution fails due to authentication,
  rate limit, timeout, GraphQL/API error, or unparseable output
- **THEN** the dry-run SHALL abort with a non-zero failure (propagated error)
- **AND** SHALL NOT report the affected issues as `missing-pr`
- **AND** SHALL NOT exit 0 with a trusted-looking incomplete plan

#### Scenario: Non-mergeable PR is excluded
- **WHEN** the linked open PR has `mergeable: "CONFLICTING"` or
  `mergeStateStatus: "DIRTY"`
- **THEN** that PR SHALL NOT appear in the merge-candidate list
- **AND** dry-run SHALL report it as skipped with reason `non-mergeable`

#### Scenario: Unknown mergeability is excluded
- **WHEN** the linked open PR has `mergeable: "UNKNOWN"`
- **THEN** that PR SHALL NOT appear in the merge-candidate list
- **AND** dry-run SHALL report it as skipped with reason `non-mergeable` (or an
  equivalent documented unknown-mergeability reason)

#### Scenario: Checks not green are excluded
- **WHEN** a required check has bucket `fail`, `pending`, or `cancel`
- **THEN** that PR SHALL NOT appear in the merge-candidate list
- **AND** dry-run SHALL report it as skipped with reason `checks-not-green`

#### Scenario: Pending gh pr checks non-zero exit is checks-not-green not fatal
- **WHEN** `gh pr checks --required` exits non-zero because a required check is
  pending (or fail/cancel) but still writes a JSON check array to stdout
- **THEN** the dry-run SHALL NOT abort the entire plan as a command failure
- **AND** that PR SHALL be reported as skipped with reason `checks-not-green`

#### Scenario: Wrong base branch is excluded
- **WHEN** an issue is in the milestone, carries `pipeline:ready-to-deploy`, and
  has an open linked PR that is otherwise mergeable and check-green
- **AND** the PR's `baseRefName` differs from the configured base branch
- **THEN** that PR SHALL NOT appear in the merge-candidate list
- **AND** dry-run SHALL report it as skipped with reason `wrong-base`

#### Scenario: Clean mergeable R2D PR is a candidate
- **WHEN** an issue is in the milestone, carries `pipeline:ready-to-deploy`, has
  an open linked PR with `mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"`,
  base matching the configured base branch, and required checks pass under the
  merge check policy
- **THEN** that PR SHALL appear in the merge-candidate list

---

### Requirement: Merge-queue dry-run SHALL print an ordered plan with candidate and skip details
The dry-run output SHALL present merge candidates in deterministic order:
**ascending linked issue number**. For each merge candidate the output SHALL
include at least: PR number, issue number, head commit SHA (`headRefOid`),
mergeability summary, required-check summary, and planned next action
(`would-merge` for this dry-run-only change). The output SHALL also list skipped
items with reason codes. The output SHALL include a clear statement that no
merges were performed. An empty candidate list with zero skips or only skips
SHALL exit 0 (successful plan of “nothing to merge”), not treat emptiness as a
hard failure of the command itself.

#### Scenario: Ordered candidates by issue number
- **WHEN** dry-run finds merge candidates for issues 100, 42, and 75
- **THEN** the printed candidate order SHALL be issue 42, then 75, then 100

#### Scenario: Candidate row fields are present
- **WHEN** dry-run includes PR 200 for issue 42 with head SHA `abc1234`
- **THEN** the output for that candidate SHALL include PR 200, issue 42, head
  SHA `abc1234`, a mergeability summary, a check summary, and planned action
  `would-merge`

#### Scenario: Footer asserts no merges
- **WHEN** dry-run completes successfully
- **THEN** the output SHALL state that no merges were performed

#### Scenario: Empty plan is success
- **WHEN** the milestone has no R2D merge candidates
- **THEN** the command SHALL exit 0
- **AND** SHALL report zero candidates without mutating GitHub state

---

### Requirement: Merge-queue logic SHALL use a dependency-injection seam for all I/O
Merge-queue planning SHALL inject all I/O (listing milestone issues, reading labels,
resolving PRs, viewing PR mergeability/head, listing checks) via a deps interface
parameter. Production deps call `gh`; unit-test deps return fixtures. Unit tests
SHALL NOT make any real network, git, or subprocess call. Unit tests SHALL cover
at least: R2D-only filtering, missing-PR exclusion, and non-mergeable exclusion,
and SHALL assert that dry-run never invokes a merge function.

#### Scenario: Unit test uses fake deps
- **WHEN** a unit test constructs merge-queue deps with stubbed list/resolve/view/check
  implementations
- **THEN** running the plan function exercises selection without real `gh`

#### Scenario: Dry-run path never calls merge
- **WHEN** a unit test runs the dry-run plan against fixtures that include
  mergeable candidates
- **THEN** no merge/write dep SHALL have been called

#### Scenario: Selection filter regressions are covered
- **WHEN** the merge-queue unit test suite runs
- **THEN** it SHALL include cases proving non-R2D issues, missing PRs, and
  non-mergeable PRs are excluded from the merge-candidate list

---

### Requirement: The advance loop SHALL never invoke merge-queue and no auto_merge config key SHALL exist
The merge-queue handler SHALL NOT be called from any stage handler, the advance loop, or any path reachable from `pipeline advance`. The pipeline configuration schema and documented config keys SHALL NOT introduce an `auto_merge` key that enables autonomous merging. Human-owned merge authority remains: only explicit operator invocation of `pipeline merge` or of `pipeline merge-queue` with `--apply` (dry-run is the default) MAY merge. Merge-queue dry-run planning SHALL NOT merge. An unattended or config-driven auto-merge path SHALL NOT be added under this capability.

#### Scenario: No stage transition calls merge-queue
- **WHEN** the advance loop dispatches any stage (planning through deploy-ready)
- **THEN** no call to the merge-queue plan/drive handler occurs

#### Scenario: Isolation test asserts advance does not import merge-queue
- **WHEN** the loop-isolation unit test for merge-queue runs
- **THEN** it SHALL assert that advance stage handlers and the advance loop do not import or reference merge-queue module symbols used for planning or drive

#### Scenario: No auto_merge config key is added
- **WHEN** pipeline configuration documentation and schema for this change are inspected
- **THEN** they SHALL NOT define an `auto_merge` config key that enables autonomous merging of ready-to-deploy PRs

#### Scenario: Explicit operator --apply is the batch merge authority
- **WHEN** an operator runs `pipeline merge-queue` with a required selector and without `--apply`
- **THEN** the command SHALL run in dry-run mode and SHALL NOT merge any PR
- **WHEN** an operator runs `pipeline merge-queue` with a required selector and with `--apply`
- **THEN** the command MAY merge eligible candidates through the existing merge surface under operator session authority
- **AND** that path SHALL still be unreachable from `pipeline advance`

