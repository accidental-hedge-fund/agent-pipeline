## Context

See `proposal.md` for motivation and dogfood evidence (#691 / PR #1022, train ship-v1.38.0).

**Already landed (epic #1028 / living `stale-blocked-rereview`):**

- Module `core/scripts/stages/stale-blocked-rereview.ts` with `tryResumeStaleBlocked` and stage eligibility (`pre-merge`, `fix-*`, `review-*`).
- Advance early-exit in `pipeline-run.ts`: when `isBlocked` and stage is eligible, call resume; on `cleared`, `continue` the iteration loop so detail is re-fetched and stage work runs without the leftover label.
- Unit tests in `core/test/stale-blocked-rereview.test.ts` for clear / keep-same-HEAD / internal-only / no-sha no-op.
- Currency classification reuses `resolveReviewedShaCurrency` from `pre-merge-sha-gate.ts` (`current` | `superseded` | `unknown`).

**Still the #1025 contract (this change):**

- Full enter-path contract including **rebase / `reviewed-sha` absent from PR history**: issue requires resume when **S** is gone and **H** ≠ **S**, not permanent keep.
- First-cut maps `unknown` → `keep` (fail closed). That avoids clearing when classification is ambiguous, but also parks forever on rebase/squash where the SHA gate already prefers conservative re-review. Lock the intended split: **H** unreadable or PR unresolved → keep; **H** ≠ **S** and currency cannot prove pipeline-internal-only (including **S** missing) → clear and re-enter review.
- Prove advance wiring: after clear, the same advance continues into delta / conservative re-review before any train STOP or loop terminal hold that would fire solely on the pre-resume label.
- Keep security denylist and no invented `--override`.

## Goals / Non-Goals

**Goals:**

- One enter-path resume before terminal STOP on leftover `blocked` when HEAD has non-internal work past the blocking reviewed-sha (or history no longer contains that sha while HEAD moved).
- Same supersession semantics as the pre-merge SHA gate / residual-scope rules for “non-internal past S”.
- True same-HEAD residuals and unfixed security stay parked after one resume attempt.
- Regression fixtures that would have failed on the #691 dogfood path.

**Non-Goals:**

- Auto-fixing `security` residuals or expanding the auto-fix allowlist.
- Overriding findings because a commit message claims they are fixed.
- Changing #1020 scratch classification or #1021 live sibling.
- Threshold → general LLM recover for arbitrary blocks.
- Auto-merge or merge-authority changes.
- Replacing residual SHA-scope (#1010) for approval reuse of pipeline-internal-only tips.

## Decisions

### D1: Resume lives on advance enter, not only mid-write self-heal

**Decision:** Keep resume on the advance loop’s already-blocked branch (before surface-blocker / break). Mid-write self-heal in `enforceReviewShaGate` stays for races during `setBlocked`. They are complementary, not alternatives.

**Rationale:** Dogfood failed on the *next* advance after the block was already persisted. Mid-write only covers the race during write.

**Alternatives:** Only teach train to ignore `blocked` (rejected: wrong semantics; other entrypoints still STOP). Only operator `unblock` (rejected: issue goal).

### D2: Currency classification — supersede / internal-only / unknown split

**Decision:**

| Condition | Resume action |
|-----------|----------------|
| No `reviewed-sha` extractable | no-op (leave block; other recovery paths) |
| **H** == **S** | keep |
| Currency `current` (internal-only since S, or still head) | keep (verdict reuse / #98; residual SHA-scope still applies when gate re-enters) |
| Currency `superseded` (non-internal in S..H) | `clearBlocked` → re-enter stage path |
| **H** ≠ **S** and currency `unknown` (S missing, reorder, stale commit list) | `clearBlocked` → re-enter stage path (conservative re-review at H) |
| PR missing / head unreadable | keep (fail closed; cannot prove progress) |

**Rationale:** Issue text: “H is a descendant of S **or S is absent from history because of rebase**” plus non-internal progress (or inability to prove internal-only while HEAD moved) → resume. Permanent keep on rebase contradicts dogfood-class recovery. Head unreadable must not clear blindly.

**Alternatives:** Keep first-cut `unknown` → keep always (rejected for rebase). Clear on any SHA mismatch including internal-only (rejected: #98 cascade).

### D3: Clear label, do not invent overrides

**Decision:** Resume only removes `pipeline:blocked` (and continues advance). It does not write `--override` dispositions, does not drop `pipeline-blocking-keys` markers by hand, and does not change the security auto-fix denylist. Re-review at H decides approve vs re-block.

**Rationale:** Issue non-goals forbid override-from-movement and security auto-fix. Re-review is the truth source for the new HEAD.

### D4: Train / loop terminality is after one resume attempt

**Decision:** Production train and loop MUST reach the advance enter-path resume for an already-blocked eligible stage before treating leftover `blocked` as terminal STOP / hold-only for that item this advance. After `keep` or after re-block on the new HEAD, STOP / hold is correct.

**Rationale:** Issue acceptance: no train STOP before the resume attempt; STOP allowed after keep or re-block.

**Alternatives:** Train-only special case (rejected: `single` and loop must share the same enter path).

### D5: Spec surface

**Decision:** Strengthen living `stale-blocked-rereview` (MODIFIED + ADDED where new concerns appear). Add a thin `review-sha-gating` ADDED requirement that enter-path resume MUST use the same non-internal supersession classification the SHA gate uses, so the two surfaces cannot drift.

## Risks / Trade-offs

- **[Risk] Clearing on `unknown` re-reviews more often after force-push / incomplete commit lists** → Mitigation: still only when **H** ≠ **S**; same HEAD keeps block; unreadable head keeps block. Matches SHA-gate conservative re-review bias.
- **[Risk] Double work: clear then re-block on same residuals if HEAD did not change meaningfully** → Mitigation: only clear when currency proves supersession or unknown-with-moved-head; same HEAD keep path stays.
- **[Risk] Clearing blocked without clearing needs-human if co-present** → Mitigation: if `needs-human` is co-present from residual security, design keeps re-review authority; do not invent label surgery beyond `clearBlocked` for the stale block cause. If co-labels prevent re-entry, tasks must verify and fix only if production path is blocked by that interaction.
- **[Risk] Epic first cut already shipped; implement PR may be verify-only** → Mitigation: tasks start with inventory of landed code vs gaps (especially `unknown` → keep vs clear); only edit where gaps remain.

## Migration Plan

- No config or label schema migration.
- After implement: regenerate `plugin/` if `core/` changes; `openspec validate`; `npm run ci`.
- Rollback: revert the enter-path branch (or the `unknown` classification tweak) without affecting mid-write self-heal.

## Open Questions

None that block specs or tasks. Residual `needs-human` co-label interaction is a verify item in tasks, not an open product decision.
