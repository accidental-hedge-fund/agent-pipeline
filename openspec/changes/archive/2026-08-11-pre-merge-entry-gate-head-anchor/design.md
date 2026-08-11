## Context

See `proposal.md` for motivation. Current structure (post module split):

- `advancePolling` owns one `PreMergePollingContext` per session and loops: `advance(...)` → sleep `ci_poll_interval` → repeat until advanced, non-waiting, or deadline (`pre-merge-routing.ts` ~1051–1072).
- `advance()` always runs, in order: resolve PR → review-SHA gate → optional `preArchiveSha` capture → OpenSpec archive → active-change guard → early-conflict via `getPrDetail` → Step 1 CI (`pre-merge-routing.ts` ~356–505).
- `PreMergePollingContext` already carries per-session state (`preArchiveSha`, CI recovery SHA sets, waiting spam flags) but has no “entry gates already passed for this head” marker.
- Steady-state pending CI only needs head currency + mergeability (base can move) + check aggregation; the head-bound entry stack is pure re-validation of an unchanged head.

Constraints:

- Rigor over latency: skip must not remove, demote, or policy-condition any gate.
- Unit tests inject deps only (no real network/git/subprocess).
- Edit orchestration in `pre-merge-routing.ts` (facade still re-exports); do not re-collapse domain modules.
- Compose cleanly with sibling cache work (#838): this memo is **session + head SHA only**, not a durable gh response cache.

## Goals / Non-Goals

**Goals:**

- One full **head-bound** entry-gate pass per distinct PR head SHA per polling session.
- Re-ticks on the same head pay only for load-bearing per-tick reads (PR detail for head + mergeability + `getPrChecks` / local-mode equivalents).
- Head movement always re-runs the full head-bound entry stack.
- Early-conflict is **not** memo-skipped: base movement with unchanged head must still conflict.
- Memo records only a proceed verdict into Step 1, using post-stack head SHA.
- Cached PR identity has an explicit validity rule.

**Non-Goals:**

- Shortening CI wall-clock beyond restoring poll interval tightness.
- Cross-process / durable memo of entry-gate pass.
- Caching review verdicts, archive outcomes, or gh GraphQL responses as a general layer (#838).
- Parallelizing independent gate I/O inside a single full pass.
- Changing SHA-gate policy, archive fail-closed rules, active-change guard, CI recovery ladder, or merge authority.
- Skipping Step 1 CI when head is unchanged.

## Decisions

### 1. Memo key = PR head SHA on the existing polling context

**Decision:** Add `entryGatesPassedForSha?: string` to `PreMergePollingContext`. On each `advance()` tick that has `pollingCtx`, after resolving current open-PR `prDetail.head_sha`, if `pollingCtx.entryGatesPassedForSha === prDetail.head_sha`, skip the **head-bound** entry gates and continue to early-conflict + Step 1 with the already-resolved PR identity.

**Rationale:** Head SHA is the natural invalidation key for the SHA gate, archive, and active-change guard. The context already lives for the session (same family as `preArchiveSha` / `ciWaitingGateRecorded`).

**Alternatives considered:**

- *Module-level static memo.* Unsafe across issues; rejected.
- *Durable stage-attempt ledger entry.* Overkill; could skip gates after operator/worktree changes across process restart; rejected for this issue.
- *Diff-hash or merge-base key.* Stronger than needed for head-bound gates; early-conflict is re-checked every tick instead.

### 2. Skip scope = head-bound gates only; early-conflict always re-runs

**Decision:** On memo hit, skip only:

1. `enforceReviewShaGate`
2. `preArchiveSha` capture body when already set (capture still happens on first full pass before memo set)
3. `maybeArchiveOpenspec`
4. `enforceOpenspecActiveChangeGuard`

On **every** tick (memo hit or miss), after resolving `prDetail`:

- Evaluate early-conflict with the **byte-identical** predicate:

  ```ts
  prDetail.mergeable === false ||
  (prDetail.mergeable_state ?? "").toUpperCase() === "DIRTY"
  ```

- On conflict → `recoverFromMergeConflict` (and **do not** set / refresh a proceed memo for that return).
- On non-conflict → Step 1 CI as today.

**Gate audit (inputs that can change without PR-head change):**

| Gate | Non-head inputs | Disposition |
| --- | --- | --- |
| Review-SHA gate | Issue comments, actor, overrides | Primary question is head vs reviewed SHA + residual for this head. Same head that already clean-proceeded remains covered; operator override re-enters via labels / non-waiting path, not pure CI poll. **Skip on memo hit.** |
| OpenSpec archive | Worktree / PR tip change dirs | Archive is idempotent; new unarchived change requires tree/head change. **Skip on memo hit.** |
| Active-change guard | Worktree tip dirs, or PR-head tree | PR product path is head-bound. Local-only worktree dirt without push is outside the PR advance product path for CI poll. **Skip on memo hit.** |
| Early conflict | Base branch movement → `DIRTY` / `mergeable === false` without head change | **NOT head-bound. Always re-evaluate from fresh per-tick `prDetail`.** |
| CI checks | Check run status | Always polled (Step 1). |

**Rationale:** The original plan skipped early-conflict on memo hit. Review correctly noted mergeability can turn DIRTY when the base moves while head is fixed. Re-checking conflict costs one field already on the per-tick detail read.

### 3. Set the marker only on clean proceed into Step 1 for a stack-validated head

**Decision:**

- Capture the open PR head SHA **before** entering the head-bound stack (`stackEntryHeadSha`).
- After a full (memo-miss) entry stack completes without non-proceed return, **re-fetch `getPrDetail`** (mergeability + head observation) before early-conflict.
- After early-conflict is false, set `pollingCtx.entryGatesPassedForSha` only when the post-stack head still equals `stackEntryHeadSha` (the head the gates validated).
- If the post-stack re-fetch reports a different head without a stack-proven transition for that new SHA (external push/force-push race during the stack), **leave the memo unset**. The next tick re-runs the full head-bound stack for the new head before it can become a memo hit.
- Any early `return` from a gate MUST leave the marker unset for that proceed (do not set; do not invent a “failed at sha” cache).
- Memo hit path re-affirms the existing matching memo; it does not invent a new head.

**Rationale:** Proceed-only memo must not treat an externally introduced head as already gated. Successful OpenSpec archive currently returns `waiting` after push (no same-pass CI proceed/memo). Blindly memoizing whatever post-stack `getPrDetail` returns would permanently skip head-bound gates for an ungated developer push that lands between stack completion and the re-fetch.

### 4. Hoist `getPrDetail` + session-scoped `prNumber` with validity rule

**Decision:**

1. Resolve `prNumber`:
   - If `pollingCtx.prNumber` is a positive number, use it as candidate.
   - Else call `getPrForIssue` (existing), store on `pollingCtx.prNumber` when present.
2. Fetch `prDetail` via `getPrDetail(prNumber)` early (after dry-run skip).
3. **PR identity validity (every tick):**
   - If `getPrDetail` throws / not found, or `prDetail.state` is not `"open"` (closed/merged): clear `pollingCtx.prNumber` and `pollingCtx.entryGatesPassedForSha`, re-run `getPrForIssue`. If no open PR → existing “no PR” block path. If a new open PR number → continue with that identity (full entry stack; memo already cleared).
   - If detail is open → keep cached `prNumber` for the session; do **not** re-scan repo-wide open PRs every tick.
4. Use that open `prDetail` for memo compare, early-conflict, and Step 1.

**Rationale:** Issue asked to cache `prNumber` to avoid the paginated open-PR scan. Review correctly required that a closed/replaced PR not keep being polled. `getPrDetail` already returns `state` (`open` | `closed` | `merged`) and is load-bearing every tick for head + mergeability; using it as the validity probe is surgical.

### 5. No pollingCtx → no memo

**Decision:** When `opts.pollingCtx` is absent, full stack every call (one-shot advance). Marker fields only meaningful under `advancePolling` (or a shared context supplier).

### 6. Regression tests as the enforcement mechanism

**Decision:** Injectable-deps tests:

1. **Multi-tick pending CI** — shared `pollingCtx`, checks pending ≥10 ticks, unchanged open head: head-bound gates only on first proceed; later ticks ≈ detail + checks (no SHA gate / archive / active-change deps).
2. **Head invalidation** — memo H1, then head H2 → full head-bound stack runs; fails if skip ignores head equality.
3. **Non-proceed does not set memo** — forced non-null SHA-gate / archive / guard / early-conflict recovery → marker unset; next same-head tick re-runs stack.
4. **Base-only DIRTY** — memo set for H1; next tick same `head_sha`, `mergeable_state: "DIRTY"` (or `mergeable: false`) → conflict recovery; SHA gate / archive / guard may still be skipped but conflict path runs.
5. **Post-stack external head race** — after all three head-bound gates complete against H1, post-stack detail reports H2 → memo stays unset; next tick re-runs full stack for H2 (must fail if H2 is memoized without re-running).
6. **Closed / replaced PR** — cached `prNumber` closed → re-resolve; do not keep polling closed PR; entry memo cleared.
7. **Early-conflict predicate** — expression remains byte-identical (shared helper or source assertion).

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| External post-stack head memoized as gated | Compare post-stack head to stack-entry head; leave memo unset on unproven mismatch |
| Base moves → DIRTY without head change | Early-conflict always re-evaluated on fresh detail |
| Closed/replaced PR with cached number | Validity check on every `getPrDetail`; clear cache + memo and re-resolve |
| Skip hides mid-poll comment/override edge cases | Accepted for head-bound skip; override/operator paths re-enter outside pure waiting poll; head movement still re-runs stack |
| Call-count flakiness | Count explicit injected seams, not global process counters |
| Compose with #838 | Keep gate-proceed memo separate from response caches |

## Migration Plan

1. Land OpenSpec change (planning).
2. Implement context fields + advance control flow + tests in one PR targeting `main`.
3. No config flag (amortization only).
4. Rollback: remove memo check / fields → full stack every tick.

## Open Questions

None blocking. Field name for cached PR number: `prNumber` on `PreMergePollingContext` (session-scoped; documented validity rule in code comment).
