# harness-step-verification Specification

## Purpose
TBD - created by archiving change harden-harness-instruction-steps-verify. Update Purpose after archive.
## Requirements
### Requirement: Capture-then-verify pattern for all harness-instruction steps

Every pipeline step that invokes a harness and prescribes a machine-checkable output property SHALL capture the current HEAD SHA immediately before harness invocation, then after the harness returns, verify the prescribed properties on the commit range `headBefore..HEAD`. Steps that prescribe no commit-producing behavior are exempt from commit-range checks.

#### Scenario: HEAD captured before harness invocation

- **WHEN** any harness-instruction step is about to invoke the harness
- **THEN** the step SHALL record the output of `git rev-parse HEAD` in a `headBefore` variable before spawning the harness process

#### Scenario: Verification runs on the produced commit range

- **WHEN** the harness exits with code 0
- **THEN** the step SHALL verify its prescribed invariants against commits in `headBefore..HEAD`
- **AND** the step SHALL block (return `blocked` with a descriptive reason) if any invariant is violated
- **AND** the step SHALL NOT advance to the next stage on a violation

---

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

### Requirement: Docs-update step verifies docs-only file constraint

After the docs-update harness completes and before pushing, the pipeline SHALL verify that no application code or test files appear in the set of changed files in `headBefore..HEAD` (or in the uncommitted dirty tree). The constraint is an allow-list: every modified file path must match a documentation-file pattern (`*.md`, `*.txt`, `*.rst`, `*.adoc`, paths under `docs/` or `doc/`, and extensionless named docs files such as `README`, `CHANGELOG`, `LICENSE`). Any path that does not match — application code, config such as `package.json`, or CI workflows — is denied.

#### Scenario: Docs-update only touches documentation files

- **WHEN** the docs-update harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** every modified file path matches documentation-file patterns only
- **THEN** the step SHALL push the docs commit and return `waiting` to trigger CI

#### Scenario: Docs-update modifies application code — step blocks

- **WHEN** the docs-update harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** one or more modified file paths do not match any documentation-file pattern
- **THEN** the step SHALL block with reason: `"Docs-update commit modified non-documentation files: <list>"`
- **AND** SHALL NOT push the commits

#### Scenario: Docs-update produces no commits — step proceeds without blocking

- **WHEN** the docs-update harness exits 0 and no new commits exist on `headBefore..HEAD`
- **THEN** the step SHALL proceed normally (no docs needed — not a violation)

---

### Requirement: Plan-revision output includes machine-checkable feedback acknowledgement

The plan-revision harness output SHALL contain a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` bullet item per feedback point from the plan review. The pipeline SHALL verify the presence of this section before posting the revised plan as an issue comment.

#### Scenario: Plan revision includes acknowledgement section

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line
- **THEN** the step SHALL post the revised plan as an issue comment and proceed

#### Scenario: Plan revision lacks acknowledgement section — step blocks

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout does NOT contain a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line
- **THEN** the step SHALL block with reason: `"Plan revision output is missing required ## Feedback Incorporated section"`
- **AND** SHALL NOT post the revised plan

---

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

