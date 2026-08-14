## Context

See `proposal.md` for motivation. Today `recoverFromMergeConflict` claims a
one-shot `conflict_rebase` ledger attempt, calls `tryRebaseAndPush`, and on any
non-zero `git rebase` aborts the rebase and parks with `BlockerKind`
`merge-conflict` plus “manual rebase needed.” That park is a **false human**:
the same class of additive conflicts (#1061 help-string unions) is routinely
finished by an implementer in minutes. Ship-path constitution requires
**class-over-site** recovery: the shared conflict-rebase domain (#628) must not
leave a human-park hole after one clean rebase miss.

Constraints that shape the design:

- Host-local issue-run lock and managed worktree remain the recovery substrate.
- Stage-attempt ledger already bounds `conflict_rebase` / `ci_rebase` per head.
- Candidate-integrity wraps head-moving rebase mutations when `runDir` is known.
- Push must stay `--force-with-lease` via configured git push auth.
- Advance/loop never merge; this is pre-merge recovery only.
- Surgical-fix discipline still applies to conflict resolution diffs.

## Goals / Non-Goals

**Goals:**

- Close the park hole: first auto-rebase conflict is an engine recovery step, not
  a human terminal.
- Shared recovery in the conflict-rebase module (both early-conflict and
  post-CI CONFLICTING/DIRTY paths).
- Bounded implementer/resolver work, then product-failure terminal with evidence.
- Regression that forbids the #1061-class terminal text for this path.
- Same class of fault next time does not need a new mole issue.

**Non-Goals:**

- Implementing #1063 (serial merge / do not skip unmerged previous item) beyond
  “this false park must not free train to abandon the item.”
- Changing merge-queue hold/repair surfaces or inventing `auto_merge`.
- Making every BEHIND/BLOCKED GitHub mergeability state a human-free path in
  this change (true CONFLICTING/DIRTY code conflict is in scope; BEHIND
  auto-update may share helpers but is not the acceptance fixture).
- Cross-host rebase locks or a second durable scheduler.
- LLM as first recoverer when a cheap deterministic resolve exists (prefer
  deterministic-first when safe; implementer is the bounded escalate).

## Decisions

### D1 — Escalate inside `recoverFromMergeConflict`, not a new stage

**Choice:** Extend the existing recovery function (and `tryRebaseAndPush` /
helpers) so a failed clean rebase transitions to **in-worktree conflict
resolution** rather than `setBlocked(merge-conflict)`.

**Why:** Both Step 0.5 early-conflict and Step 2 post-CI conflict already call
`recoverFromMergeConflict`. Fixing the shared function is class-over-site; a
path-local only fix would leave the other call site open.

**Alternatives:** New stage label / separate “conflict-resolve” stage — rejected
as state-machine churn for a recovery step that belongs inside pre-merge.
Rely only on autonomous-recovery-controller after park — rejected: the park is
the bug; do not park then unpark.

### D2 — Keep conflict state in the managed worktree (no terminal abort-as-success)

**Choice:** On clean-rebase conflict, do **not** treat `rebase --abort` + false
as the end of recovery. Keep the worktree owned by this issue; either leave the
rebase in progress for the resolver/implementer, or re-enter rebase under an
explicit resolve session with conflict paths visible. After resolution, complete
rebase, push `--force-with-lease`, re-enter pre-merge as waiting for CI.

**Why:** Operator expectation is “finish the rebase,” not “drop the conflict and
ask a human.” Abort remains available for failed/exhausted cleanup so the tree
is not left wedged forever.

**Alternatives:** Always abort then open a fresh branch merge — rejected; loses
rebase continuity and differs from the human recipe operators already use.

### D3 — Deterministic-first optional, implementer required as escalate

**Choice:** Allow a **deterministic resolver** for known trivial classes when
safe (e.g. pure additive dual-side unions with no semantic choice), but the
normative recovery path MUST be able to dispatch the **configured implementer**
with conflict files + base/ours/theirs context under surgical-fix scope. Budget
is bounded (ledger / attempt counter / existing repair-style budget — pick one
existing mechanism rather than inventing a second).

**Why:** Issue text allows “implementer or deterministic resolver.” Live #1061
class is additive help-string union — often model-easy, sometimes deterministic.
Constitution: LLM is not first recoverer when deterministic works; both are in
the class fix.

**Alternatives:** Implementer-only always — acceptable but slower/costlier for
trivial unions. Deterministic-only — insufficient for real semantic conflicts.

### D4 — Budget exhaustion → product/engine-owned failure, never “manual rebase needed”

**Choice:** When resolution budget is exhausted and the tree is still
conflicting, fail closed with a **non-`merge-conflict`** product/engine-owned
terminal (e.g. `needs-human` / review-findings-class product failure, or an
existing product BlockerKind that maps to engine-owned recovery — **not**
`merge-conflict` with the manual-rebase recipe). Body MUST list conflict paths
and residual evidence.

**Why:** Matches operator law and acceptance criteria. Keeps `merge-conflict`
kind available for other surfaces (e.g. merge-queue hold reporting) without
legitimizing the false pre-merge human park.

**Alternatives:** Keep `merge-conflict` kind but change recipe text — rejected;
kind still classifies as human rebase work and maps offramp/taxonomy wrongly.

### D5 — Ledger bounds charge resolve attempts, not instant human park

**Choice:** Preserve one-shot / bounded claims so poll loops cannot thrash. A
ledger-recorded clean rebase attempt that left conflicts MUST escalate to
resolver/implementer within budget rather than immediately
`block_manual_rebase`. Only after resolve budget exhaustion does the path
terminal-block (per D4).

**Why:** Existing #759 ledger work correctly prevents infinite loops; the bug is
the action on bound hit (`block_manual_rebase` / park), not the existence of a
bound.

**Alternatives:** Unlimited implementer retries — rejected (non-convergence).
Remove ledger entirely — rejected (reintroduces poll thrash).

### D6 — Train / multi-item: no “park and skip” for this class

**Choice:** First-conflict recovery returns `waiting` (or in-progress recovery
outcome) while resolve/push runs, or holds the item in engine recovery without
`pipeline:blocked` merge-conflict park. Multi-item advance MUST NOT treat that
false park as a completed human disposition that alone starts the next issue.

**Why:** Acceptance criterion; pairs with #1063 without implementing full serial
merge law here.

### D7 — Class fix, not only the help-string fixture

**Choice:** Fixture for #1061 help-string union proves the common case; law is
general for CONFLICTING/DIRTY pre-merge recovery. Next identical fault uses the
same recovery without a new issue.

## Risks / Trade-offs

- **[Risk] Implementer expands scope while resolving conflicts** → Mitigation:
  surgical-fix prompt + conflict-file-only instruction; pre-commit self-check
  already in fix discipline; unit tests assert no `merge-conflict` park on first
  fail regardless of implementer success path fakes.
- **[Risk] Worktree left mid-rebase across process death** → Mitigation: on
  re-entry, detect in-progress rebase / conflict state and resume resolve rather
  than double-claim clean rebase; abort only on budget exhaust or unrecoverable
  wedge after recording evidence.
- **[Risk] Ledger already claimed; tests expect park** → Mitigation: update
  convergence tests that assert instant `merge-conflict` after `tryRebaseAndPush
  === false`; add regressions that fail on #1061 terminal text.
- **[Risk] Offramp/taxonomy consumers still count `merge-conflict`** → Mitigation:
  update mapper expectations so first-conflict no longer emits that offramp as
  terminal; document residual uses of the kind on other surfaces.
- **[Risk] Cost of implementer rounds on frequent conflicts** → Mitigation:
  deterministic-first when safe; tight budget; waiting outcome so train can
  poll without human.

## Migration Plan

1. Land OpenSpec change (this proposal); implement under #1065.
2. Ship on **v1.39.1** — do not fold into in-flight v1.39.0.
3. After deploy, re-run any issues parked with the old #1061-class comment via
   normal advance (no special data migration); recovery path is on re-entry.
4. Rollback: revert the change; old park behavior returns (worse operator UX but
   known).

## Open Questions

- Exact BlockerKind string for budget-exhausted residual conflict (reuse
  `needs-human` vs a narrower existing kind) — choose at implement time from
  current enum without inventing a new human “manual rebase” kind; specs only
  forbid `merge-conflict` + manual-rebase terminal for this path.
- Whether BEHIND auto-update failure shares the same implementer escalate in
  this PR or a follow-up — default: share helpers if cheap, do not block #1065
  acceptance on BEHIND-only cases.
