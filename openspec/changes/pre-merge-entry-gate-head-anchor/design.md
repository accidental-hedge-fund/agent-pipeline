## Context

See `proposal.md` for motivation. Current structure (post module split):

- `advancePolling` owns one `PreMergePollingContext` per session and loops: `advance(...)` → sleep `ci_poll_interval` → repeat until advanced, non-waiting, or deadline.
- `advance()` always runs, in order: resolve PR → review-SHA gate → optional `preArchiveSha` capture → OpenSpec archive → active-change guard → early-conflict via `getPrDetail` → Step 1 CI.
- `PreMergePollingContext` already carries per-session state (`preArchiveSha`, CI recovery SHA sets, waiting spam flags) but has no “entry gates already passed for this head” marker.
- Steady-state pending CI only needs head currency + check aggregation; the rest of the entry stack is pure re-validation of an unchanged head.

Constraints:

- Rigor over latency: skip must not remove, demote, or policy-condition any gate.
- Unit tests inject deps only (no real network/git/subprocess).
- Edit orchestration in `pre-merge-routing.ts` (facade still re-exports); do not re-collapse domain modules.
- Compose cleanly with sibling cache work (#838 and matrix children): this memo is **session + head SHA only**, not a durable gh response cache.

## Goals / Non-Goals

**Goals:**

- One full entry-gate pass per distinct PR head SHA per polling session.
- Re-ticks on the same head pay only for load-bearing CI-path reads (PR head/detail as needed + `getPrChecks` / local-mode equivalents).
- Head movement always re-runs the full entry stack.
- Memo records only a proceed verdict into Step 1.
- Early-conflict predicate remains byte-identical after hoisting `getPrDetail`.

**Non-Goals:**

- Shortening CI wall-clock beyond restoring poll interval tightness (sleep still dominates).
- Cross-process / durable memo of entry-gate pass (ledger is for CI recovery markers, not this).
- Caching review verdicts, archive outcomes, or gh GraphQL responses as a general layer (#838).
- Parallelizing independent gate I/O inside a single full pass.
- Changing SHA-gate policy, archive fail-closed rules, active-change guard, CI recovery ladder, or merge authority.
- Skipping Step 1 CI itself when head is unchanged (CI status still polled every tick).

## Decisions

### 1. Memo key = PR head SHA on the existing polling context

**Decision:** Add `entryGatesPassedForSha?: string` to `PreMergePollingContext`. On each `advance()` tick that has `pollingCtx`, after resolving current `prDetail.head_sha`, if `pollingCtx.entryGatesPassedForSha === prDetail.head_sha`, skip entry gates and enter Step 1 with the already-resolved PR identity.

**Rationale:** Head SHA is the natural invalidation key for every entry gate (SHA gate currency, archive side-effects, conflict state relative to head). The context already lives for the session and is the right place for ephemeral memo (same family as `preArchiveSha` / `ciWaitingGateRecorded`).

**Alternatives considered:**

- *Module-level static memo.* Unsafe across issues and concurrent runs; rejected.
- *Durable stage-attempt ledger entry.* Overkill for per-session amortization; survives process restart in ways that could skip gates after operator/worktree changes; rejected for this issue.
- *Diff-hash or merge-base key.* Stronger than needed; head movement is the required invalidator and is simpler to test.

### 2. Set the marker only on clean proceed into Step 1

**Decision:** After the full entry stack completes without returning (SHA gate null, archive null, openspec guard null, not early-conflict), and immediately before Step 1, set `pollingCtx.entryGatesPassedForSha = prDetail.head_sha` when `pollingCtx` is present. Any early `return` from a gate MUST leave the marker unset for that head (do not set; do not invent a “failed at sha” cache).

**Rationale:** Acceptance requires the memo to cache only a proceed verdict. Non-proceed results already stop or restructure the poll loop; caching them would either skip re-evaluation incorrectly or add complexity with no benefit.

**Alternatives considered:**

- *Set marker at start of first tick.* Would skip re-running gates after a transient false conflict or partial failure on the same head; rejected.
- *Cache structured gate outcomes.* Out of scope; more like #838-class response caching.

### 3. Hoist `getPrDetail` (and optional cached `prNumber`) before the stack

**Decision:**

1. Resolve `prNumber` first (existing). Optionally store on `pollingCtx.prNumber` when present so later ticks can reuse without `getPrForIssue` when the cached number still matches the issue’s PR (implementation may still call a cheap verify path if needed; prefer reusing the cached number within the session as specified).
2. Fetch `prDetail` once near the top of the non-dry-run path (after PR existence is known) so `head_sha` is available for the memo check **and** for the early-conflict predicate later.
3. On memo hit: reuse that `prDetail` / `prNumber` for Step 1.
4. On memo miss: run the full stack; use the **same** early-conflict predicate on the resolved detail (byte-identical comparison expression). If archive or another gate can move HEAD, re-fetch `prDetail` after the stack before setting the marker and before early-conflict / Step 1 as needed so the memo SHA matches the head that actually entered Step 1.

**Rationale:** The issue requires hoisting detail for the conflict check and head-keyed memo. Archive can push commits that change head; setting the marker from a pre-archive SHA would falsely skip gates after archive. Post-stack head (or a single post-archive detail) must own the memo value.

**Alternatives considered:**

- *Memo hit without any `getPrDetail`.* Cannot know head movement without a head read; at least one head-bearing read per tick remains load-bearing.
- *Always use pre-stack detail for the marker after archive.* Incorrect after archive moves HEAD; rejected.

### 4. Skip scope is the entry stack only

**Decision:** Memo skip covers only: review-SHA gate, pre-archive capture (when already set or when skip applies), `maybeArchiveOpenspec`, `enforceOpenspecActiveChangeGuard`, and early-conflict *re-derivation that would re-run the gate bodies*. Step 1 CI (pending poll, recovery ladder, local mode) always runs. Fresh mergeability checks that already exist after green CI remain as today.

**Rationale:** The waste is entry-stack re-validation; CI status is the question each tick asks.

### 5. No pollingCtx → no memo (first-shot / non-polling advance unchanged)

**Decision:** When `opts.pollingCtx` is absent, behavior matches today’s full stack every call (single `advance` without polling session). Marker fields are only meaningful under `advancePolling` (or a caller that supplies a shared context).

**Rationale:** Avoid surprising cross-call skips for one-shot advance; keep the optimization scoped to the documented poll session.

### 6. Regression tests as the enforcement mechanism

**Decision:**

1. **Multi-tick pending CI:** shared `pollingCtx`, stub checks always pending for N ticks; assert entry-gate deps (SHA gate / archive / openspec guard — or their underlying gh/git seams) are invoked only on the first tick (or when head changes), and per-tick gh-like call count after tick 1 is 1–2.
2. **Head invalidation:** after a proceed memo, change `getPrDetail` head SHA; assert full stack runs again. Mutate the implementation (or a test double flag) to prove the test fails if invalidation is removed.
3. **Non-proceed does not set marker:** force SHA gate (or archive) to return a non-null outcome; assert marker unset and a later tick with same head still runs the stack.
4. **Early-conflict predicate:** shared helper or source-level assertion that the conflict boolean expression is unchanged.

**Rationale:** Acceptance criteria are falsifiable only with deps counters and explicit invalidation tests.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Stale skip after archive moves HEAD in the same tick | Set memo only after stack completion using post-stack head SHA; re-fetch detail if archive can change head |
| Skip hides a new conflict that appeared without a head change (rare GitHub merge-base update) | Accept as out of scope for head-key design; conflict re-check still runs after green CI; document trade-off. Do not weaken early-conflict on first pass |
| Memo hit skips `preArchiveSha` capture | Capture runs only when unset before archive on full path; first tick still sets it; memo hit implies first tick already passed archive path for that head or head was already post-entry. If first proceed set marker without capture, ensure capture still happens on first full pass before marker set |
| Call-count flakiness if deps graph is fuzzy | Count explicit injected seams (`getPrForIssue`, `getIssueDetail`, archive-related git/gh, vs `getPrDetail`/`getPrChecks`) rather than global process counters |
| Compose with #838 double-caching | Keep this memo semantic (gate proceed per head) separate from response caches; no shared global map |

## Migration Plan

1. Land OpenSpec change (this planning step).
2. Implement context fields + advance control flow + tests in one PR targeting `main`.
3. No config flag required (behavior-preserving for gate outcomes; pure amortization).
4. Rollback: remove memo check / fields; full stack every tick returns (safe fallback).

## Open Questions

None that block specs or tasks. Optional implementer choice: exact field name for cached PR number (`prNumber` vs `cachedPrNumber`) as long as it is session-scoped on `PreMergePollingContext` and documented in code comments.
