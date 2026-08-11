## Why

`advancePolling` re-invokes `advance()` once per `ci_poll_interval`. Each tick re-runs the full pre-CI entry-gate stack (PR resolution, review-SHA gate, OpenSpec archive, active-change guard, early-conflict check) even when the PR head SHA is unchanged and only CI status matters. That multiplies GitHub API and git subprocess load, multiplies transient-failure surfaces that hard-block to `needs-human`, and does not improve CI wait wall-clock (the loop is sleep-bounded). Head-anchoring the entry gates inside the existing `PreMergePollingContext` runs the stack once per head, not once per tick, without removing or weakening any gate.

## What Changes

- Hoist PR detail resolution in `advance()` so `prNumber` / `prDetail` (including `head_sha` and mergeability fields) are available before the entry-gate stack, and reuse that detail for the early-conflict check (predicate stays byte-identical).
- Extend `PreMergePollingContext` with:
  - `entryGatesPassedForSha?: string` — head SHA for which the full entry-gate stack already returned a clean proceed
  - cached `prNumber` (session-scoped) so ticks need not re-scan for the PR when still valid
- When `pollingCtx.entryGatesPassedForSha === prDetail.head_sha`, skip the entry-gate stack and go directly to Step 1 (CI checks / local CI mode).
- When the marker is absent or the head differs, run the full stack (review-SHA gate → pre-archive capture → OpenSpec archive → active-change guard → early conflict) and set `entryGatesPassedForSha` **only** on a clean proceed into Step 1.
- Any non-null gate outcome (block, wait, re-route, conflict recovery return, etc.) MUST NOT set the memo; such outcomes already terminate or re-enter the poll loop with a non-proceed result.
- Any head movement (developer push, auto-fix commit, archive commit, rebase, etc.) invalidates the memo by SHA mismatch and re-runs every entry gate in full.
- Add unit/regression coverage with injectable deps: head-invalidation fails if invalidation is removed; multi-tick pending-CI wait proves post-first-tick entry-gate deps drop sharply (target: 1–2 `gh` calls per tick after the first for a 10-tick pending wait).
- No gate removed, weakened, or made conditional on anything other than “this head already passed the entry stack in this polling session.”

## Acceptance criteria

- [ ] On a steady pending-CI wait with unchanged head, after the first tick that reaches Step 1, subsequent `advance()` ticks inside the same `advancePolling` session do **not** re-invoke entry-gate deps (`enforceReviewShaGate` / SHA-gate path, `maybeArchiveOpenspec`, `enforceOpenspecActiveChangeGuard`) for that head.
- [ ] A regression test with stubbed `getPrChecks` returning pending for 10 ticks fails if entry gates re-run every tick; after the fix, per-tick `gh` (or equivalent deps) invocations after tick 1 drop to roughly 1–2 load-bearing reads (PR detail / checks), not the full ~9+ entry stack.
- [ ] `entryGatesPassedForSha` is set only when the entry stack returns a clean proceed into Step 1; any non-null gate result leaves the marker unset (or unchanged from a prior head) so a later tick cannot skip gates after a block/wait/conflict return.
- [ ] Changing `prDetail.head_sha` between ticks clears the skip path: every entry gate runs again in full; a dedicated regression fails if invalidation is removed.
- [ ] Early-conflict predicate remains byte-identical to today after the PR-detail hoist (`mergeable === false` OR uppercased `mergeable_state === "DIRTY"`); non-conflict UNKNOWN/BEHIND/BLOCKED still fall through to CI.
- [ ] No review step, SHA-gate policy, OpenSpec archive fail-closed path, active-change guard, or CI recovery ladder is removed or demoted; skip is keyed only to head SHA equality with a prior proceed.
- [ ] Unit tests use injectable deps only (no real network, git, or subprocess); `npm run ci` is green; `plugin/` regenerated if any `core/` source that participates in the mirror changes.

## Capabilities

### New Capabilities

- `pre-merge-entry-gate-head-anchor`: Session-scoped memo of a successful pre-CI entry-gate proceed, keyed by PR head SHA on `PreMergePollingContext`, so `advancePolling` re-ticks skip the entry stack when the head is unchanged and still re-run the full stack on any head movement.

### Modified Capabilities

- None at the living product-policy level. Existing capabilities (`review-sha-gating`, `pre-merge-ci-gate`, `pre-merge-conflict-detection`, OpenSpec archive / active-change guard, `pre-merge-fix-round`) remain authoritative for gate outcomes. This change adds polling-session amortization only; it does not amend those gate policies.

## Impact

- **Core:** `core/scripts/stages/pre-merge-routing.ts` (`PreMergePollingContext`, `advance`, `advancePolling`); possibly shared types if `prNumber` cache is typed next to the context. No change to SHA-gate / archive / conflict *policy* modules beyond being invoked fewer times per session.
- **Tests:** New or extended `core/test/pre-merge-*.test.ts` covering memo set conditions, head invalidation, multi-tick deps counts, and early-conflict predicate stability.
- **Living specs:** New capability only under `openspec/changes/pre-merge-entry-gate-head-anchor/specs/`.
- **Out of scope:** Parallelizing independent gate I/O; broader `gh` response caching (#838 and siblings may compose later); removing/weakening review or CI gates; auto-merge; durable cross-process memo beyond the existing polling context / recovery-marker patterns.
- **Not changing:** Advance never merges; review rigor; single-host lock scope; pipeline-internal commit classification rules for the SHA gate.
