## Why

Several pipeline stages instruct a harness via prompt to satisfy machine-checkable invariants (commit message format, issue reference, docs-only file constraint), then only verify coarse signals — harness exit success and whether any commits were produced. Two independent pointwise fixes revealed this is systemic: #20 (PR #66) added trailer validation on the test-fix path, and #26 (PR #67) added acknowledgement-section validation on plan revision. A third independent instance would be caught by review, not by the pipeline itself. This change audits every harness-instruction step and installs verification for every invariant the prompt prescribes that can be checked mechanically.

## What Changes

- **Audit coverage**: enumerate every pipeline step that hands instructions to a harness, classify each asked-for property as machine-checkable or judgmental, and document the result in the PR.
- **New invariant: implementation commit reference** — implementation step verifies at least one commit on `headBefore..HEAD` contains `#{{issue_number}}` in its message.
- **New invariant: fix-round commit message format** — fix rounds 1 and 2 verify the commit message matches `fix: address review N findings (#{{issue_number}})`.
- **New invariant: test-fix commit message format** — test-fix loop verifies the commit message matches `fix: resolve test/build failures (#{{issue_number}})`.
- **New invariant: docs-only file constraint** — docs-update step verifies no application code or test files appear in the diff produced by the harness.
- **New invariant: plan-revision feedback acknowledgement** — plan-revision output must include a machine-checkable acknowledgement section listing which reviewer feedback items it incorporated or explicitly deferred (generalising #26's fix as the shared pattern).
- **Existing verifications** (#16 SHA sentinel, #20 trailers, #26 acknowledgement) are expressed through or consistent with the general pattern — no regression, no duplication.
- **Regression tests** for each newly-enforced invariant: harness produces non-compliant output → step blocks/retries.
- **Plugin mirror** regenerated.

## Capabilities

### New Capabilities
- `harness-step-verification`: requirements for post-harness compliance checking across all harness-instruction steps — the general capture-then-verify pattern, per-step invariants, and block/retry semantics.

### Modified Capabilities
*(None — all behavior changes are additive guards on existing steps; no existing spec-level requirements change.)*

## Impact

- `core/scripts/stages/planning.ts` — implementation step (commit reference) and plan-revision (acknowledgement)
- `core/scripts/stages/fix.ts` — fix rounds 1 and 2 (commit message format)
- `core/scripts/testgate.ts` — test-fix loop (commit message format)
- `core/scripts/stages/pre_merge.ts` — docs-update (docs-only file constraint)
- `plugin/` — mirror must be regenerated after changes to core scripts
- Test suite — new regression tests for each invariant
