## Why

`advancePolling` re-invokes `advance()` once per `ci_poll_interval`. Each tick re-runs the full pre-CI entry-gate stack (PR resolution, review-SHA gate, OpenSpec archive, active-change guard, early-conflict check) even when the PR head SHA is unchanged and only CI status matters. That multiplies GitHub API and git subprocess load, multiplies transient-failure surfaces that hard-block to `needs-human`, and does not improve CI wait wall-clock (the loop is sleep-bounded). Head-anchoring the **head-bound** entry gates inside the existing `PreMergePollingContext` runs those gates once per head, not once per tick, without removing or weakening any gate.

## What Changes

- Hoist PR detail resolution in `advance()` so `prNumber` / `prDetail` (including `head_sha` and mergeability fields) are available before the entry-gate stack.
- Extend `PreMergePollingContext` with:
  - `entryGatesPassedForSha?: string` — head SHA for which the **head-bound** entry-gate stack already returned a clean proceed into CI
  - cached `prNumber` (session-scoped) with an explicit validity rule (see design)
- When `pollingCtx.entryGatesPassedForSha === prDetail.head_sha`, skip **only** the head-bound entry gates (review-SHA gate, OpenSpec archive, active-change guard) and still:
  - evaluate the **early-conflict predicate every tick** from the fresh per-tick `prDetail`
  - run Step 1 CI every tick
- When the marker is absent or the head differs, run the full stack in existing order and set `entryGatesPassedForSha` **only** on a clean proceed into Step 1 when the post-stack re-fetch still reports the **stack-entry** head the gates validated (do not memoize unproven external post-stack head movement).
- Any non-null gate outcome MUST NOT set the memo.
- Any head movement invalidates the memo by SHA mismatch and re-runs every head-bound entry gate in full.
- Cached `prNumber` is reused only while `getPrDetail` confirms the PR is still open; closed/missing/replaced PR clears the cache and re-resolves identity.
- Unit/regression coverage for multi-tick deps drop, head invalidation, non-proceed never memoizes, base-only DIRTY still conflicts, archive post-head memo, and closed/replaced PR identity.

## Acceptance criteria

- [ ] On a steady pending-CI wait with unchanged head, after the first tick that reaches Step 1, subsequent `advance()` ticks inside the same `advancePolling` session do **not** re-invoke head-bound entry-gate deps (`enforceReviewShaGate`, `maybeArchiveOpenspec`, `enforceOpenspecActiveChangeGuard`) for that head.
- [ ] Every tick (including memo hits) still fetches PR detail and evaluates the early-conflict predicate; a test with unchanged head and base-driven `DIRTY`/`mergeable === false` still takes conflict recovery.
- [ ] A regression test with stubbed `getPrChecks` returning pending for 10 ticks fails if entry gates re-run every tick; after the fix, per-tick load-bearing gh/detail/check calls after tick 1 drop to roughly the CI path (PR detail + checks), not the full ~9+ entry stack.
- [ ] `entryGatesPassedForSha` is set only on clean proceed into Step 1; any non-null gate result leaves the marker unset (or unchanged from a prior head).
- [ ] Changing `prDetail.head_sha` between ticks clears the skip path; a dedicated regression fails if invalidation is removed.
- [ ] After an unproven post-stack head change (external push during the stack), the memo is **not** set to the new SHA; the next tick re-runs the full head-bound stack for that head.
- [ ] Cached `prNumber` is not reused for a closed/missing PR; identity is re-resolved and entry memo cleared when PR identity is no longer valid.
- [ ] Early-conflict predicate remains byte-identical: `mergeable === false || (mergeable_state ?? "").toUpperCase() === "DIRTY"`.
- [ ] No review step, SHA-gate policy, OpenSpec archive fail-closed path, active-change guard, or CI recovery ladder is removed or demoted.
- [ ] Unit tests use injectable deps only; `npm run ci` is green; `plugin/` regenerated if mirrored `core/` sources change.

## Capabilities

### New Capabilities

- `pre-merge-entry-gate-head-anchor`: Session-scoped memo of a successful head-bound pre-CI entry-gate proceed, keyed by PR head SHA on `PreMergePollingContext`, so `advancePolling` re-ticks skip head-bound gates when the head is unchanged, always re-check early conflict + CI, and re-run the full stack on any head movement.

### Modified Capabilities

- None at the living product-policy level. Existing capabilities remain authoritative for gate outcomes. This change adds polling-session amortization only.

## Impact

- **Core:** `core/scripts/stages/pre-merge-routing.ts` (`PreMergePollingContext`, `advance`, `advancePolling`).
- **Tests:** New or extended `core/test/pre-merge-*.test.ts`.
- **Living specs:** New capability under `openspec/changes/pre-merge-entry-gate-head-anchor/specs/`.
- **Out of scope:** Parallelizing independent gate I/O; broader `gh` response caching (#838); removing/weakening review or CI gates; auto-merge; durable cross-process entry-gate memo.
- **Not changing:** Advance never merges; review rigor; single-host lock scope; pipeline-internal commit classification for the SHA gate.
