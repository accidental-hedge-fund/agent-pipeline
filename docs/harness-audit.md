# Harness-Instruction Step Audit

_Generated as part of #68 — Harden harness-instruction steps: verify compliance, don't just prompt._

This document enumerates every pipeline step that invokes a harness (Claude Code or Codex)
with instructions, classifies each property the prompt prescribes as either **machine-checkable**
(enforced by the pipeline after the harness exits) or **judgmental** (left to review rounds), and
records the enforcement status.

---

## Summary

| Step | Prompt Template | Machine-Checkable Invariants | Enforcement Added |
|------|----------------|------------------------------|-------------------|
| Planning (freeform) | `planning.md` | — | — |
| Planning (OpenSpec) | `planning_openspec.md` | Exactly one OpenSpec change created; structural validity; authoring commits touch only `openspec/` | Pre-existing (`openspec validate`) + **Added (#68)** (singularity block + `openspec/`-only path constraint) |
| Plan review | `plan_review.md` | Verdict structure | Pre-existing (structured output parse) |
| Plan revision | `plan_revision.md` | `## Feedback Incorporated` section with `[ADDRESSED]`/`[DEFERRED]` items | **Added (#68)** |
| Implementation | `implementing.md` | At least one commit references `#<issue_number>` | **Added (#68)** |
| Fix round 1 | `fix.md` (round=1) | At least one commit matches `fix: address review 1 findings (#<N>)` | **Added (#68)** |
| Fix round 2 | `fix.md` (round=2) | At least one commit matches `fix: address review 2 findings (#<N>)` | **Added (#68)** |
| Test-fix loop | `test_fix.md` | At least one commit matches `fix: resolve test/build failures (#<N>)` | **Added (#68)** |
| Docs update | `docs_update.md` | No application code files in committed/dirty changes; harness-produced commit message matches `docs: update documentation for #<N>` | **Added (#68)** (file check + commit message check) |
| Review SHA gate | — | HEAD matches the reviewed commit SHA | Pre-existing (#16 / PR #63) |

---

## Per-Step Detail

### 1. Planning (freeform) — `planning.md`

**What the prompt asks for:** Generate a coherent, surgical implementation plan.

**Machine-checkable invariants:** None in the plan output itself — the plan is free-form text.

**Judgmental properties (out of scope):**
- Plan correctness, completeness, and design quality
- Appropriate scope and minimal blast radius
- Whether the plan addresses the issue adequately

**Enforcement:** No mechanical enforcement; plan quality is assessed by the cross-harness plan-review step.

---

### 2. Planning (OpenSpec) — `planning_openspec.md`

**What the prompt asks for:**
- Author exactly one OpenSpec change under `openspec/changes/<id>/`
- Intent-only (no application code); commit the change artifacts

**Machine-checkable invariants:**
- Exactly one new change directory was created (`before`/`after` scan). Multiple new changes are a hard block (`enforceOpenspecChangeSingular`) rather than silently selecting the first (**#68, finding 3**)
- The authoring harness committed (and left dirty) only files under `openspec/` — application code at the intent stage is blocked via a `pathConstraint` (**#68**)
- `openspec validate` passes on the new change (pre-existing)

**Judgmental properties (out of scope):**
- Quality of the proposal intent, design choices, scope

**Enforcement:** Pre-existing structural validation via `openspec.validateItem`, hardened by #68 with the singularity block (`enforceOpenspecChangeSingular`) and the `openspec/`-only path constraint (`verifyHarnessCommits` with `pathConstraint`).

---

### 3. Plan Review — `plan_review.md`

**What the prompt asks for:** Structured verdict (APPROVE / NEEDS_REVISION) with findings.

**Machine-checkable invariants (pre-existing enforcement):**
- Verdict JSON / structured output is parseable (`parseStructuredVerdict`)
- Verdict content is non-empty

**Judgmental properties (out of scope):**
- Correctness of the review findings
- Whether the reviewer correctly identified gaps

**Enforcement:** Pre-existing structured output parsing; verdict quality is judgmental.

---

### 4. Plan Revision — `plan_revision.md`

**What the prompt asks for:**
- Incorporate or explicitly defer each reviewer feedback item
- Output a `## Feedback Incorporated` section with `[ADDRESSED]` or `[DEFERRED]` tags

**Machine-checkable invariants:**
- Stdout contains `## Feedback Incorporated` (case-insensitive)
- At least one `[ADDRESSED]` or `[DEFERRED]` line is present

**Enforcement added by #68:** `verifyPlanRevisionOutput` blocks if section or items are missing.

**Judgmental properties (out of scope):**
- Whether feedback was correctly incorporated (not just acknowledged)
- Quality of the revised plan

---

### 5. Implementation — `implementing.md`

**What the prompt asks for:**
- Implement the plan with clean, tested code
- Commit all changes referencing `#<issue_number>`

**Machine-checkable invariants:**
- At least one commit in `headBefore..HEAD` contains `#<issue_number>` in subject or body

**Enforcement added by #68:** `enforceImplCommitRef` blocks on missing issue reference.

**Judgmental properties (out of scope):**
- Code correctness and quality
- Test adequacy
- Minimal scope compliance

---

### 6. Fix Round 1 — `fix.md` (round=1)

**What the prompt asks for:**
- Address each review finding
- Commit with message: `fix: address review 1 findings (#<issue_number>)`

**Machine-checkable invariants:**
- At least one commit in `headBefore..HEAD` matches `fix: address review 1 findings (#<N>)` (case-insensitive)

**Enforcement added by #68:** `enforceFixCommitGate(1, ...)` blocks on format mismatch.

**Judgmental properties (out of scope):**
- Whether each finding was correctly addressed
- Code quality of the fixes

---

### 7. Fix Round 2 — `fix.md` (round=2)

Same structure as Fix Round 1, with pattern `fix: address review 2 findings (#<N>)`.

**Enforcement added by #68:** `enforceFixCommitGate(2, ...)` blocks on format mismatch.

---

### 8. Test-Fix Loop — `test_fix.md`

**What the prompt asks for:**
- Fix the root cause of test/build failures
- Commit all changes with message: `fix: resolve test/build failures (#<issue_number>)`

**Machine-checkable invariants:**
- At least one commit in `fixHeadBefore..HEAD` matches `fix: resolve test/build failures (#<N>)` (case-insensitive)

**Enforcement added by #68:** `enforceTestFixCommitFormat` blocks on format mismatch; wired via `TestGateDeps.verifyTestFix`.

**Note:** Trailers (`Issue:`, `Pipeline-Run:`) are not enforced here — the prompt does not prescribe them. The `verifyHarnessCommits` helper supports `requireTrailers` but this step does not use it (#68 review-2 finding 1).

**Judgmental properties (out of scope):**
- Whether the root cause was correctly identified
- Fix quality and minimal scope

---

### 9. Docs Update — `docs_update.md`

**What the prompt asks for:**
- Update stale documentation only — no application code
- If docs changed: commit with message `docs: update documentation for #<issue_number>`

**Machine-checkable invariants:**
- Every changed file in `headBefore..HEAD` **and** in the uncommitted dirty tree matches the documentation **allow-list**: `*.md`, `*.txt`, `*.rst`, `*.adoc`, paths under `docs/` or `doc/`, and extensionless named docs files (`README`, `CHANGELOG`, `LICENSE`, `CONTRIBUTING`, `AUTHORS`, `NOTICE`, `CODEOWNERS`, `SECURITY`). Any path that does not match is denied — application code, config (`package.json`, `tsconfig.json`), and CI workflows (`*.yml`) all block (#68 review-2 finding 4)
- Every harness-produced commit (non-empty `headBefore..HEAD`) carries the message prefix `docs: update documentation for #<N>`

**Enforcement added by #68:** `enforceDocsOnlyGate` blocks on any file outside the documentation allow-list in committed or uncommitted changes; `enforceDocsCommitMessageGate` blocks when harness-produced commits carry a wrong message prefix (#68 review-2 finding 3).

**Judgmental properties (out of scope):**
- Accuracy and completeness of the documentation updates
- Whether all relevant docs were found and updated

---

## Explicitly Deferred / Out-of-Scope Properties

The following properties appeared in one or more prompts but are **not mechanically enforced**
because they require reviewer judgment:

- **Code correctness** (implementing, fix rounds): correctness can only be assessed by reading and
  understanding the code — this is what review-1 (standard) and review-2 (adversarial) are for.
- **Plan quality and soundness** (planning, plan revision): whether a plan is good is a design judgment
  left to the plan-review step.
- **Documentation accuracy** (docs update): whether the docs reflect the code truthfully requires
  understanding both; checked by reviewers.
- **Test adequacy** (implementing): whether tests provide sufficient coverage is a reviewer judgment.
- **Finding correctness in review** (plan review): whether the reviewer's findings are correct is
  assessed by the implementer and ultimately the merge decision.

---

## Shared Verification Infrastructure

All mechanical checks are implemented through `core/scripts/verify-harness-commits.ts`:

- `verifyHarnessCommits(wtPath, headBefore, config, deps)` — shared git-log-based checker (config supports `issueNumber`, `messagePattern`, `requireTrailers`, `docsOnly`, `pathConstraint`, and `allowEmpty`)
- `verifyPlanRevisionOutput(stdout, feedback?)` — pure regex checker for the stdout acknowledgement section
- `isDocumentationFile(path)` — allow-list predicate for the docs-only constraint (any non-matching file is denied)
- `parseDirtyFiles(statusOutput)` — git porcelain parser

Per-step gate functions delegate to the shared helper and are exported for direct unit testing:
- `enforceImplCommitRef` (planning.ts) — implementation commit references the issue (used by both the freeform and OpenSpec paths)
- `enforceOpenspecChangeSingular` (planning.ts) — exactly one new OpenSpec change directory
- `enforceFixCommitGate` (fix.ts)
- `enforceTestFixCommitFormat` (testgate.ts)
- `enforceDocsOnlyGate` (pre_merge.ts)
- `enforceDocsCommitMessageGate` (pre_merge.ts)

## Prior Pointwise Fixes Consistency

| Prior fix | Invariant | Status in this PR |
|-----------|-----------|-------------------|
| #16 / PR #63 (review SHA gate) | HEAD matches reviewed commit | Unchanged; `enforceReviewShaGate` is a separate gate with its own DI, consistent with the general pattern |
| #20 / PR #66 (test-fix trailers) | `Issue:` and `Pipeline-Run:` trailers | Deferred: `test_fix.md` does not prescribe trailers; `requireTrailers` removed from `enforceTestFixCommitFormat` to avoid blocking compliant output (#68 review-2 finding 1) |
| #26 / PR #67 (plan-revision ack) | `## Feedback Incorporated` section | Implemented here via `verifyPlanRevisionOutput`; consistent with the general pattern |
