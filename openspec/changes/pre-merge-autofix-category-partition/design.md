## Context

Pre-merge delta review (`enforceReviewShaGate` / `pre-merge-delta-recheck`) returns blocking
findings under the active `review_policy`. The bounded pre-merge auto-fix path (#359, #680)
then decides whether to call `attemptPreMergeAutoFix` once before `needs-human`.

**Today (all-or-nothing):**

```text
if (attemptAutoFixFn && allBlockingAutoFixable(partition.blocking)) {
  // one attempt, scoped to all blocking findings
} else {
  // setBlocked / needs-human — no harness
}
```

`allBlockingAutoFixable` is true only when the blocking array is non-empty **and every**
element passes `isAutoFixableFinding` against `PRE_MERGE_AUTOFIX_CATEGORIES`
(`correctness`, `missing-dep`, `concurrency`). Any `spec-divergence`, `security`, `scope`,
`product-judgment-required`, `data-loss`, `observability`, or empty/unknown category fails the
whole set.

**Dogfood (#729):** delta raised HIGH `concurrency` (TOCTOU, allowlisted) + HIGH
`spec-divergence` (partial-list wiring). Shared override-key; `allBlockingAutoFixable` false;
no `pre-merge-autofix` gate events; straight to blocked. Contrast pure-allowlisted items (e.g.
#718) that attempt then exhaust.

Living requirements currently encode the veto: *“only when every blocking finding is
allowlisted… If any … outside the allowlist … skip the auto-fix.”* That must change.

Constraints to preserve:

| Capability / rule | Keep |
|-------------------|------|
| Allowlist membership | No expansion for security / product-judgment / data-loss / etc. |
| One-attempt bound | Prior `PRE_MERGE_AUTOFIX_PREFIX` commit or durable attempt/noop marker exhausts |
| Surgical-fix prompt | `buildFixPrompt`, destructive-op guard, pre-commit self-check |
| Post-fix re-delta | Local post-fix head (#371); no review-2 budget burn |
| Noop re-verify (#698) | Clean no-commit still re-verifies once |
| Fail-closed unknown category | Absent/empty/unrecognized never auto-fixable |
| No auto-merge | Pipeline still stops at ready-to-deploy |

## Goals / Non-Goals

**Goals:**

1. Mixed batches **partition** into allowlisted (auto-fix-eligible) and residual
   (human-required) subsets.
2. Non-empty allowlisted subset still gets **one** bounded auto-fix attempt (when harness
   configured and no prior attempt marker).
3. Residual non-allowlisted findings never go into the auto-fix prompt and still escalate
   when still blocking after the attempt (or immediately when the allowlisted subset is empty).
4. Block / operator-facing reason names which keys required human disposition vs which were
   auto-fix attempted.
5. Pure-allowlisted and pure-non-allowlisted behaviors stay as today.

**Non-Goals:**

- Remapping reviewer categories (e.g. teaching “unwired AC field” as `correctness` instead of
  `spec-divergence`) as the primary fix — optional future guidance, not this change.
- Expanding `PRE_MERGE_AUTOFIX_CATEGORIES`.
- Unlimited auto-fix loops, auto-merge, or review-1/review-2 fix policy changes.
- Re-driving #729 in this change (separate after deploy).

## Decisions

### Decision 1: Partition eligibility (not category remapping)

**Choice:** Replace all-or-nothing eligibility with:

1. Partition blocking findings: `autoFixable = blocking.filter(isAutoFixableFinding)`,
   `residual = blocking.filter(!isAutoFixableFinding)`.
2. Attempt auto-fix when `autoFixable.length > 0` (and harness + no prior attempt), **even if
   residual is non-empty**.
3. Scope the fix comment/prompt findings to `autoFixable` only.
4. If `autoFixable.length === 0`, skip harness and escalate (unchanged pure non-allowlisted).

**Why:** Matches AC and the #729 failure mode. Remapping categories in the reviewer prompt does
not fix mis-categorizations already posted on the current verdict, and does not help when a true
`spec-divergence` coexists with a real concurrency fix.

**Alternatives rejected:**

| Alternative | Why not |
|-------------|---------|
| Category remapping only | Leaves current mixed verdicts stranded; reviewer still may emit both categories |
| Expand allowlist to include `spec-divergence` | Out of scope; open-ended product/spec judgment |
| Auto-fix only when residual is “soft” (spec-divergence) but not security | Extra policy surface; AC asks for partition for non-allowlisted generally |
| Keep all-or-nothing | Leaves the dogfood failure |

### Decision 2: Keep residual human-required after partial auto-fix

**Choice:** After the single auto-fix attempt (commit → re-delta, or noop → re-verify), any
still-blocking findings under `review_policy` escalate to `needs-human` as today. Residual
non-allowlisted findings are **expected** to remain unless the re-delta demotes/clears them.
The one-attempt bound still applies: residual does not unlock a second harness call.

**Why:** Residual categories stay outside surgical auto-fix by design. Partial success on
allowlisted work still reduces operator load (code fix landed) while human disposition stays
required for judgment/spec/security residuals.

**Clarification:** A mixed batch does **not** auto-clear residual keys without re-delta
approval. Partition is “attempt mechanical fixes first,” not “ignore non-allowlisted.”

### Decision 3: Re-delta immediately via existing post-auto-fix path

**Choice:** After a successful auto-fix commit (or noop-clean), reuse the **existing** single
post-auto-fix delta re-review / clean-noop re-verify machinery. Do not invent a separate
“partition re-entry” or skip re-delta to jump straight to needs-human for residual.

**Why:** Open question in the issue: *re-delta immediately vs re-enter full pre-merge SHA gate
only?* The post-auto-fix re-delta already re-enters the gate’s fix/block decision with local
post-fix head correctness (#371). Residual human findings still block after that single
re-verify. Full SHA-gate re-entry without re-delta would either skip evidence update or
re-trigger the same delta path with more churn.

### Decision 4: Pure helpers and naming

**Choice:**

- Keep `isAutoFixableFinding` and `PRE_MERGE_AUTOFIX_CATEGORIES` as the allowlist source of truth.
- Keep `allBlockingAutoFixable` for pure-all checks / tests if useful, but **stop using it as
  the sole attempt gate**.
- Prefer a small pure partition helper (e.g. `partitionBlockingForAutofix(blocking) →
  { autoFixable, residual }`) used by the delta-fail branch and unit tests — or an equivalent
  inline filter if a named helper is overkill; either way, eligibility is “non-empty
  autoFixable,” not “every finding allowlisted.”

**Why:** Tests and living matrix stay aligned; the #729 regression is a one-liner eligibility
change plus prompt scoping plus block-reason text.

### Decision 5: Block-reason / evidence contract

**Choice:** When escalating after a mixed or residual-present path, the operator-facing block
reason (and/or durable gate detail) SHALL distinguish at least:

- **Human-required:** residual non-allowlisted findings (category + override key when present).
- **Auto-fix attempted:** allowlisted findings that were in the attempt scope (and whether
  re-delta still blocks them).
- **Skipped harness:** pure residual batch (no allowlisted subset) — no attempt, not exhausted.

Do not require a new comment kind unless existing block text cannot carry the partition; prefer
extending the existing needs-human / delta block reason string used by `setBlocked`.

### Decision 6: Security residual still allows mechanical auto-fix of allowlisted subset

**Choice:** Partition applies uniformly: a co-batched `security` finding does **not** veto
auto-fix of allowlisted correctness/concurrency findings. The fix prompt still excludes the
security finding; post-attempt re-delta / residual still forces human disposition for security.

**Why:** Matches the stated AC (“not solely because one finding is non-allowlisted”). Risk is
accepted under Risks below: mechanical fix is scoped; security residual remains blocking.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Auto-fix lands a commit while a `security` residual remains | Prompt excludes residual; residual still blocks after re-delta; human must disposition security |
| Auto-fix “touches” code near residual findings and makes them worse | Surgical-fix + pre-commit self-check already bound the attempt; re-delta can still block |
| Operators think partition “handles” `spec-divergence` | Block reason must name residual human-required keys; docs/spec say residual is not auto-fixed |
| Existing tests expect mixed allowlisted+excluded to skip harness | Update those tests deliberately; add #729-shaped regression that **fails** under old all-or-nothing |
| Confusion between `allBlockingAutoFixable` name and new gate | Rename usage sites / comments; optional deprecate pure helper if unused |

## Migration Plan

1. Spec + unit tests first (this change’s implementation phase): eligibility, prompt scope,
   block text, #729 fixture.
2. Deploy via normal pipeline → `ready-to-deploy` → human merge.
3. Re-drive #729 (or similar) after the factory fix is live — out of this change’s scope.
4. Rollback: revert to all-or-nothing eligibility (prior behavior is stricter, not data-lossy).

## Open Questions

Resolved for this design:

1. **Partition vs remapping** → **Partition** (Decision 1).
2. **Post partial auto-fix path** → **Existing single re-delta / noop re-verify** (Decision 3).

Deferred (not blocking this change):

- Optional reviewer-prompt guidance to prefer `correctness` over `spec-divergence` for pure
  wiring defects — product/docs follow-up, not required for the gate fix.
- Whether block reason needs a machine-readable sentinel for loop UIs beyond free-text — only
  if existing progress events cannot surface partition detail.
