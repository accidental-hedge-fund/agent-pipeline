# harness-step-verification Specification

## Purpose
TBD - created by archiving change harden-harness-instruction-steps-verify. Update Purpose after archive.
## Requirements
### Requirement: Capture-then-verify pattern for all harness-instruction steps

Every pipeline step that invokes a harness and prescribes a machine-checkable output property SHALL capture the current HEAD SHA immediately before harness invocation, then after the harness returns, check for uncommitted changes before verifying commit-range invariants. If uncommitted changes are present and no new commit is in the range, the step SHALL invoke the salvage path (see `harness-uncommitted-salvage` spec) to create a commit before running the commit-range verification. Steps that prescribe no commit-producing behavior are exempt from commit-range checks. After commit-range verification completes, the implementing and fix-round steps SHALL additionally run the format gate (see `harness-format-lint-gate`) before opening or updating the PR.

#### Scenario: HEAD captured before harness invocation

- **WHEN** any harness-instruction step is about to invoke the harness
- **THEN** the step SHALL record the output of `git rev-parse HEAD` in a `headBefore` variable before spawning the harness process

#### Scenario: Dirty worktree triggers salvage before commit-range verification

- **WHEN** the harness exits and `headBefore === headAfter` (no new commit)
- **AND** the worktree contains uncommitted changes
- **THEN** the step SHALL invoke `salvageUncommittedWork` to create a salvage commit before running `verifyHarnessCommits` on the resulting range

#### Scenario: Verification runs on the produced commit range

- **WHEN** the harness exits with code 0 and at least one commit exists in `headBefore..HEAD` (whether harness-produced or salvaged)
- **THEN** the step SHALL verify its prescribed invariants against commits in `headBefore..HEAD`
- **AND** the step SHALL block (return `blocked` with a descriptive reason) if any invariant is violated
- **AND** the step SHALL NOT advance to the next stage on a violation

#### Scenario: Clean worktree with no commits still blocks

- **WHEN** the harness exits and no new commit was produced
- **AND** the worktree is clean (no uncommitted changes)
- **THEN** the step SHALL block with `"No commits found in the range; the harness was expected to produce at least one commit"` and SHALL NOT invoke salvage

#### Scenario: Format gate runs after commit-range verification for implementing and fix-round steps

- **WHEN** the implementing or fix-round harness exits 0 and commit-range verification passes
- **AND** `config.format_gate` is non-empty
- **THEN** the step SHALL invoke `runFormatGate` before opening or updating the PR
- **AND** if `runFormatGate` returns a `blocked` result, the step SHALL propagate the block and SHALL NOT open or update the PR

### Requirement: Implementation step verifies issue reference in new commits

After the implementation harness completes, the pipeline SHALL verify that at least one commit in `headBefore..HEAD` contains the string `#<issue_number>` in its commit message subject or body.

#### Scenario: Commit message references the issue

- **WHEN** the implementation harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** at least one of those commit messages contains `#<issue_number>`
- **THEN** the step SHALL proceed normally

#### Scenario: No commit references the issue — step blocks

- **WHEN** the implementation harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** none of those commit messages contain `#<issue_number>`
- **THEN** the step SHALL block with reason: `"Implementation commits are missing issue reference #<issue_number>"`
- **AND** the step SHALL NOT push or advance

---

### Requirement: Fix-round steps verify commit message format

After a fix-round harness (round 1 or round 2) completes, the pipeline SHALL verify that at least one commit in `headBefore..HEAD` has a message matching the pattern `fix: address review <N> findings (#<issue_number>)` (case-insensitive, where N is the fix round number).

#### Scenario: Fix commit message matches prescribed format

- **WHEN** the fix-round harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** at least one commit message matches `fix: address review <N> findings (#<issue_number>)`
- **THEN** the step SHALL proceed to the test gate

#### Scenario: Fix commit message does not match — step blocks

- **WHEN** the fix-round harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** no commit message matches the prescribed format
- **THEN** the step SHALL block with reason: `"Fix round <N> commit message does not match prescribed format"`
- **AND** the step SHALL NOT push or advance to review

---

### Requirement: Test-fix loop verifies commit message format

After each test-fix harness invocation within the test gate, the pipeline SHALL verify that at least one commit in `headBefore..HEAD` has a message matching the pattern `fix: resolve test/build failures (#<issue_number>)` (case-insensitive).

#### Scenario: Test-fix commit message matches prescribed format

- **WHEN** the test-fix harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** at least one commit message matches `fix: resolve test/build failures (#<issue_number>)`
- **THEN** the test gate SHALL proceed to re-run the test command

#### Scenario: Test-fix commit message does not match — attempt is blocked

- **WHEN** the test-fix harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** no commit message matches the prescribed format
- **THEN** the test gate SHALL treat this attempt as failed (not the same as a test failure — no retry)
- **AND** SHALL block with reason: `"Test-fix commit message does not match prescribed format"`

---

### Requirement: Plan-revision output includes machine-checkable feedback acknowledgement

The plan-revision harness output SHALL contain a `## Feedback Incorporated` section with at
least one `[ADDRESSED]` or `[DEFERRED]` bullet item per feedback point from the plan review.
The pipeline SHALL verify the presence of this section before posting the revised plan as an
issue comment.

The verification SHALL be tolerant of the Markdown wrappers models actually emit. Before
locating the section, the verifier SHALL neutralise code-fence delimiter lines (``` ``` ``` and
`~~~`) so that content inside a fence is scanned as ordinary lines. The verifier SHALL consider
**every** occurrence of the `## Feedback Incorporated` header, not only the first, taking each
occurrence's section to run until the next level-2 heading after it; the acknowledgement
requirement is satisfied when **any** such section contains at least one tagged item. Tag
matching SHALL remain anchored to the start of a line within a section, so a mention of
`[ADDRESSED]` in surrounding prose does not satisfy the gate.

The advisory feedback-coverage count SHALL be the greatest tagged-item count found in any single
section, so that a duplicated header does not double-count the same bullets.

#### Scenario: Plan revision includes acknowledgement section

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line
- **THEN** the step SHALL post the revised plan as an issue comment and proceed

#### Scenario: Fenced section with a duplicated header is accepted

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains a bare `## Feedback Incorporated` header followed by a fenced block whose first line repeats that header and whose remaining lines are `[ADDRESSED]` / `[DEFERRED]` bullets
- **THEN** the verification SHALL succeed
- **AND** the step SHALL post the revised plan as an issue comment and proceed

#### Scenario: Tagged items inside a code fence under a single header are accepted

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains one `## Feedback Incorporated` header whose tagged bullets all appear inside a code fence
- **THEN** the verification SHALL succeed

#### Scenario: Duplicated header does not inflate the coverage count

- **WHEN** the same three tagged bullets are reachable from two occurrences of the `## Feedback Incorporated` header
- **THEN** the advisory coverage comparison SHALL use a tagged-item count of three, not six

#### Scenario: Plan revision lacks acknowledgement section — step blocks

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout does NOT contain a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line
- **THEN** the step SHALL block with reason: `"Plan revision output is missing required ## Feedback Incorporated section"`
- **AND** SHALL NOT post the revised plan

#### Scenario: Header present but no tagged items anywhere — step blocks

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains one or more `## Feedback Incorporated` headers but no section under any of them contains a line-anchored `[ADDRESSED]` or `[DEFERRED]` item, fenced or unfenced
- **THEN** the step SHALL block with reason: `"Plan revision ## Feedback Incorporated section has no [ADDRESSED] or [DEFERRED] items"`
- **AND** SHALL NOT post the revised plan

### Requirement: Existing pointwise verifications are consistent with the general pattern

The SHA-sentinel verification on review verdicts (from review-sha-gating), the commit-trailer verification on test-fix commits (from #20 / PR #66), and the plan-revision acknowledgement verification (from #26 / PR #67) SHALL be implemented using or consistent with the `verifyHarnessCommits` helper introduced by this change. No step SHALL duplicate verification logic that already exists in a sibling step.

#### Scenario: New verification helper covers same invariants as prior pointwise fixes

- **WHEN** the `verifyHarnessCommits` helper is invoked on a step that previously had a pointwise fix
- **THEN** the helper SHALL enforce the same invariant as the pointwise fix
- **AND** the pointwise fix code SHALL be removed or refactored to delegate to the helper

---

### Requirement: Judgmental properties are explicitly excluded from mechanical enforcement

Properties that require a reviewer's judgment to evaluate — code correctness, design soundness, adequate test coverage, naming quality — SHALL NOT be subject to mechanical enforcement by the pipeline. These remain the responsibility of the standard and adversarial review rounds.

The pipeline SHALL document which asked-for properties from each prompt are classified as judgmental and therefore not mechanically enforced.

#### Scenario: Judgmental properties are documented at the time of audit

- **WHEN** the per-step audit is completed (as part of implementing this change)
- **THEN** a `docs/harness-audit.md` file SHALL be committed to the repo listing each harness-instruction step, its machine-checkable invariants (verified), and its judgmental properties (documented as out of scope)

---

### Requirement: Each newly-enforced invariant has a regression test

For each invariant added by this change, the test suite SHALL include at least one test where the harness produces non-compliant output and the step under test returns `blocked` (not `approved`, `waiting`, or any advancing state).

#### Scenario: Regression test exercises non-compliant harness output

- **WHEN** a harness mock returns output that violates a prescribed invariant
- **THEN** the step under test SHALL return `{ status: "blocked", reason: <descriptive string> }`
- **AND** the test SHALL assert on both the status and the reason substring

#### Scenario: Regression test exercises compliant harness output

- **WHEN** a harness mock returns output that satisfies all prescribed invariants
- **THEN** the step under test SHALL return an advancing status (`approved`, `waiting`, or stage-appropriate equivalent)

