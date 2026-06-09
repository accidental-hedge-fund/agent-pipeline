## 1. Audit and Documentation

- [ ] 1.1 Read every harness-instruction prompt template (`implementing.md`, `fix.md`, `test_fix.md`, `docs_update.md`, `plan_revision.md`, `plan_review.md`, `planning.md`) and classify each asked-for property as machine-checkable or judgmental
- [ ] 1.2 Create `docs/harness-audit.md` listing each step, its machine-checkable invariants (to be enforced), and its judgmental properties (out of scope) — commit this file
- [ ] 1.3 Confirm that PR #66 (test-fix trailers) and PR #67 (plan-revision acknowledgement) are present in the branch or accounted for; note any overlap with the new general pattern

## 2. Shared Verification Helper

- [ ] 2.1 Add `verifyHarnessCommits(wtPath, headBefore, config)` helper in `core/scripts/stages/` (or a shared util file) that accepts per-step invariant config and returns `{ ok: true } | { ok: false; reason: string }`
- [ ] 2.2 Implement commit-message format check: `git log headBefore..HEAD --format=%s%n%b` piped through a regex against the provided pattern
- [ ] 2.3 Implement issue-reference check: assert at least one commit message in `headBefore..HEAD` contains `#<issue_number>`
- [ ] 2.4 Implement commit-trailers check (generalising #20): assert all commits in `headBefore..HEAD` carry required `Issue:` and `Pipeline-Run:` trailers when configured
- [ ] 2.5 Write unit tests for the helper covering: match, no-match, empty range, and multi-commit range scenarios

## 3. Per-Step Invariant Wiring

- [ ] 3.1 **Implementation step** (`planning.ts`): capture `headBefore`, call `verifyHarnessCommits` after harness exits, block on missing issue reference
- [ ] 3.2 **Fix round 1 and 2** (`fix.ts`): capture `headBefore` (already present), call `verifyHarnessCommits` to verify commit message format matches `fix: address review N findings (#<issue>)`; remove or delegate any existing inline check
- [ ] 3.3 **Test-fix loop** (`testgate.ts`): capture `headBefore` per attempt, call `verifyHarnessCommits` to verify commit message matches `fix: resolve test/build failures (#<issue>)`; consolidate with any existing #20 trailer check
- [ ] 3.4 **Docs-update step** (`pre_merge.ts`): after harness exits, diff `headBefore..HEAD` files; block if any modified path matches the application-code deny-list; implement configurable `cfg.docs_deny_patterns` with safe default
- [ ] 3.5 **Plan-revision step** (`planning.ts`): after harness exits, regex-check stdout for `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line; block if missing; update `plan_revision.md` prompt to require this section (this is explicitly in-scope per the design)

## 4. Regression Tests

- [ ] 4.1 Test: implementation step blocks when no commit in `headBefore..HEAD` references `#<issue_number>`
- [ ] 4.2 Test: implementation step proceeds when at least one commit references `#<issue_number>`
- [ ] 4.3 Test: fix round blocks when commit message does not match prescribed format
- [ ] 4.4 Test: fix round proceeds when commit message matches prescribed format
- [ ] 4.5 Test: test-fix loop blocks when commit message does not match prescribed format
- [ ] 4.6 Test: test-fix loop proceeds when commit message matches prescribed format
- [ ] 4.7 Test: docs-update blocks when a modified file path matches the application-code deny-list
- [ ] 4.8 Test: docs-update proceeds when all modified files are doc-only
- [ ] 4.9 Test: docs-update proceeds (no block) when no commits are produced
- [ ] 4.10 Test: plan-revision blocks when `## Feedback Incorporated` section is absent
- [ ] 4.11 Test: plan-revision proceeds when `## Feedback Incorporated` section is present with at least one `[ADDRESSED]` or `[DEFERRED]` line

## 5. Plugin Mirror and Final Checks

- [ ] 5.1 Regenerate the plugin mirror (`pnpm build:plugin` or equivalent) to reflect all changes to core scripts
- [ ] 5.2 Run `pnpm test` — all tests must pass including new regression tests
- [ ] 5.3 Confirm `docs/harness-audit.md` is committed and lists covered invariants and explicitly deferred/judgmental properties
- [ ] 5.4 Confirm existing pointwise verifications (#16 SHA, #20 trailers, #26 ack) are consistent with or delegating to the new helper — no duplication
