## Why

Pre-merge can block on a **superseded PR head** after CI has already gone green on a newer commit. Observed on issue #927 / PR #1009: `tester_evidence.candidate_sha` and `stage_accounting` test-gate rows still named fail SHA `d8f2da7a…` while live head `d14ac0ac…` was green on GitHub Actions; delta-review then escalated on a docs-stale narrative that did not reproduce at the true head, and autofix-exhausted + stale finding key required an operator `pipeline override` with **no code change**. Gates must pin to the live PR head and refuse to re-litigate stale fail evidence.

## What Changes

- At every pre-merge gate start (tester evidence consumption, local/github CI classification, delta-review block authority), resolve and pin inputs to the **current open PR head** (`headRefOid` / equivalent live head SHA).
- When the live head advances past a recorded fail candidate SHA, **invalidate** tester-evidence currency, test-gate exhaustion authority, CI failure classification, and delta blocking markers keyed only to the old SHA.
- When GitHub checks (or the authoritative SHA-matched suite result for the live head) are **green on the current head**, pre-merge SHALL NOT set `blocked` / `needs-human` from tester fail rows, `test-gate-exhausted`, or docs-stale narratives that only apply to a superseded head.
- Blocking delta-review findings and `pipeline-blocking-keys` markers SHALL be **SHA-scoped**: a finding recorded against head A MUST NOT automatically block head B without re-evaluation at B (or an explicit carry-forward / override policy already defined elsewhere).
- When bounded autofix reports a valid **does-not-reproduce** at the current head, produces no commit because regenerate is a no-op, **and** CI is green on that head, prefer re-running or clearing delta evaluation at the current head over escalating solely on `pre-merge-autofix` exhausted + a finding key from a prior head. If residual true block remains, the block reason MUST name both the stale candidate SHA and the live head SHA and state whether `pipeline override` is required.

## Acceptance criteria

- [ ] A regression fixture (injectable deps only) where the PR head moves from failing SHA H_fail to green SHA H_green causes pre-merge tester, CI classification, and delta paths to evaluate **only** H_green — never treat H_fail tester fail / test-gate-exhausted rows as authoritative for H_green.
- [ ] When GitHub checks are success on H_green and the only fail evidence is SHA-mismatched (H_fail), pre-merge does **not** return `blocked` / `needs-human` with a CI or docs-stale narrative keyed only to H_fail.
- [ ] Unit coverage proves head-advance invalidation: after H_fail → H_green, cached/persisted fail candidate SHA, stale delta blocking keys for H_fail, and local test-gate failure for H_fail lose blocking authority until re-evaluated at H_green.
- [ ] When autofix is noop-clean / does-not-reproduce at H_green, worktree clean, and checks are green on H_green, pre-merge does not escalate solely because autofix is exhausted and a prior finding key was recorded at H_fail; either delta re-verify at H_green clears the block or the block reason explicitly names both SHAs and the override requirement.
- [ ] True residual blocking findings that re-verify as still blocking **at the current head** still reach `needs-human` / override as today — rigor is not weakened.
- [ ] Green checks on the current head remain mandatory for the github CI path; this change does not skip or demote CI.
- [ ] Tests use dependency seams only (no real network/git/subprocess); `npm run ci` green after implementation; `plugin/` regenerated in the same change if `core/` is edited.

## Capabilities

### New Capabilities

- `pre-merge-live-head-gate-pinning`: Cross-cutting pre-merge contract that pins tester, CI, and delta gate inputs to the live PR head, invalidates superseded-SHA fail authority on head advance, SHA-scopes blocking delta findings, and defines the green-head / does-not-reproduce offramp so stale fail evidence cannot strand a green tip.

### Modified Capabilities

- `tester-evidence`: Pre-merge consumers MUST apply the same SHA currency rules as review acquisition; mismatched-SHA fail evidence is stale and MUST NOT supply fail authority for the live head.
- `pre-merge-ci-gate`: Local and github-path classification MUST NOT escalate on test-gate / CI fail evidence whose recorded head SHA differs from the live PR head when the live head is green (or lacks a current-head fail); SHA mismatch invalidates prior-head fail exhaustion.
- `pre-merge-delta-recheck`: Blocking markers and finding keys are SHA-scoped at gate start (not only mid-review supersession); stale keys from a prior head do not auto-block the new head without re-evaluation.
- `pre-merge-fix-round`: Clean does-not-reproduce / noop-clean autofix at the current green head prefers re-verify/clear over autofix-exhausted escalation driven only by prior-head finding keys.

## Impact

- **Core stages:** `core/scripts/stages/pre-merge-routing.ts`, `pre-merge-sha-gate.ts`, `pre-merge-ci-gate.ts`, and pre-merge fix-round / delta paths that consume tester evidence, stage_accounting test-gate rows, and blocking-key markers.
- **Evidence:** `core/scripts/tester-evidence.ts` acquisition/load paths used by pre-merge; any durable markers that currently lack a head-SHA scope.
- **Tests:** New/extended `core/test/pre-merge-*.test.ts` (and related) replaying the #927 / #1010 fail→green head history via injected deps.
- **Living specs:** New capability + deltas under `openspec/changes/pin-pre-merge-gates-to-live-head/specs/`.
- **Out of scope:** Removing human override for true residual findings at the current head; weakening CI; auto-merge; durable cross-host locks; changing review-2 ceilings or entry-gate head-anchor amortization (#entry-gate memo remains separate).
- **Not changing:** Advance never merges; review rigor for findings that re-verify at the live head; pipeline-internal commit classification for the SHA gate.
