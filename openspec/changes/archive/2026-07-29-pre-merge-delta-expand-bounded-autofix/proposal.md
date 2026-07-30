## Why

Pre-merge already has a bounded auto-fix for delta-review blocking findings (#359 /
`pre-merge-fix-round`), but eligibility is fail-closed to `{ correctness, missing-dep }` only.
High-confidence, implementer-fixable findings outside that set — especially `concurrency` defects
like lock ownership / PID identity / platform probe bugs from dogfood #668 / PR #672 — escalate
straight to `needs-human` on the first hop. Items that already survived review-1/review-2 therefore
die at pre-merge and burn a full human re-drive, even when a single surgical auto-fix + re-review
would have resolved them (or failed closed with clear "exhausted" evidence).

Separately, review-2 can advance under severity policy with medium/advisory findings that later
reappear as HIGH at delta on the same fingerprint without new head-state evidence. Those cases
should prefer disposition/context over full re-litigation, without weakening real new defects.

## What Changes

- **Expand and document the auto-fix category allowlist** for pre-merge delta blocking findings:
  - Keep fail-closed: every blocking finding must be allowlisted; any non-allowlisted, empty, or
    unrecognized category skips auto-fix and escalates.
  - Add carefully scoped categories where a surgical implementer fix is safe without product
    judgment — at minimum `concurrency` (#668-class race/lock/probe defects).
  - Publish an explicit **category matrix** (in/out + rationale) in the living
    `pre-merge-fix-round` spec so future expansions are audited, not ad hoc.
- **Preserve routing invariants:** when all blocking findings are allowlisted and no prior auto-fix
  commit exists → always attempt exactly one auto-fix + one re-review. When auto-fix is exhausted
  or re-review still blocks → `needs-human` with clear evidence (never silent first-hop skip for
  allowlisted categories).
- **Carry-forward for prior-round advisories:** when a delta finding re-raises a prior-round
  advisory finding on the same fingerprint/surface without new head-state evidence, prefer
  disposition/context (demote or require verification) over hard re-litigation — coordinated with
  existing resolved-finding evidence work in `pre-merge-delta-recheck`. Verified regressions still
  block and then follow the allowlist path.
- **Non-goals (unchanged):** never auto-fix `security`, `scope`, or `product-judgment-required`;
  never remove `needs-human` when auto-fix is exhausted or re-review still blocks; no second
  auto-fix attempt; no auto-merge.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `pre-merge-fix-round`: expand the auto-fix category allowlist with an audited category matrix;
  keep one-attempt bound, surgical-fix prompt, developer-commit classification, and fail-closed
  eligibility. Add regression coverage for newly allowlisted categories and continued hard
  escalation for security/product-judgment/scope.
- `pre-merge-delta-recheck`: when blocking findings remain after partition, route through the
  expanded allowlist without silent first-hop `needs-human` for allowlisted categories; coordinate
  prior-round advisory carry-forward with existing resolved-finding verification so same-fingerprint
  severity escalations without new evidence are not fully re-litigated.

## Impact

- `core/scripts/stages/pre_merge.ts` — `isAutoFixableFinding` / `allBlockingAutoFixable` allowlist;
  any pure helpers or comments documenting the matrix; no change to the one-attempt bound,
  commit prefix, or re-review plumbing unless a skip bug is found.
- `core/scripts/stages/pre_merge.ts` / review-history or partition helpers — advisory carry-forward
  demotion or verification-context integration (reuse settled-finding paths where possible).
- `core/test/pre-merge-autofix.test.ts` (and related partition/delta tests) — new unit coverage for
  expanded categories, security still escalates, second attempt exhausted, carry-forward demotion.
- `openspec/specs/pre-merge-fix-round/spec.md` and `pre-merge-delta-recheck/spec.md` — living
  requirement updates via this change's deltas.
- `plugin/` mirror — regenerated only if `core/` implementation changes land (implementation phase).

## Acceptance Criteria

- [ ] Living `pre-merge-fix-round` spec documents an explicit category matrix: each known category
  is either **allowlisted** (with rationale that a surgical implementer fix needs no product
  judgment) or **excluded** (with rationale); the matrix includes at least
  `correctness`, `missing-dep`, `concurrency` (in), and `security`, `scope`,
  `product-judgment-required` (out).
- [ ] When every blocking delta finding has an allowlisted category (including the newly allowlisted
  `concurrency`) and no prior auto-fix commit exists, pre-merge attempts exactly one auto-fix and
  one re-review — it does **not** first-hop to `needs-human`.
- [ ] When any blocking finding is `security`, `scope`, `product-judgment-required`, unrecognized,
  or absent, pre-merge still skips auto-fix and escalates to `needs-human` immediately.
- [ ] After one auto-fix commit, a still-blocking re-review escalates to `needs-human` with clear
  exhausted-attempt evidence and does **not** attempt a second auto-fix (bound survives restart).
- [ ] Unit tests cover: newly allowlisted category → eligible auto-fix path; `security` still
  escalates; second attempt exhausted. At least one new or updated test would fail without the
  allowlist expansion.
- [ ] Prior-round advisory findings that reappear as blocking at delta on the same fingerprint
  without new head-state evidence are dispositioned via carry-forward (demoted or verification-
  gated), not fully re-litigated as fresh first-hop `needs-human` when no new defect evidence is
  cited; verified regressions still block.
- [ ] Dogfood narrative for #668-class concurrency/correctness findings: either one auto-fix +
  re-review succeeds, or the run fails with clear exhausted/non-allowlisted evidence — not silent
  first-hop `needs-human` for allowlisted categories.
- [ ] `npm run ci` green after implementation; no auto-merge path introduced.
