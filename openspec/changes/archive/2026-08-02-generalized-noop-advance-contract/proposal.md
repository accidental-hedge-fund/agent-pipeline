## Why

The contract “a harness round produced no new commit, but HEAD already satisfies the stage’s goal → advance with evidence, don’t block” has been re-implemented as separate bounded special cases at least five times: pre-merge auto-fix noop re-verify (#698), OpenSpec archive skip/no-candidates coherence (#714), delta category-partition after a false full-batch veto (#747), fix-stage no-commit recipes (override empty set / does-not-reproduce / external commit), and the planning/implement empty-commit false-block for deliverables already present in the planning commit (#588). Each instance ships its own guard, marker, and tests; the class keeps escaping through the next stage that lacks the case. This is the highest-recurrence false-block class from the 2026-07-31 reliability audit. Rigor is unchanged — this only stops false blocks where HEAD is already correct.

## What Changes

- Introduce **one stage-agnostic noop-advance contract**: when a harness (or equivalent commit-producing) round ends with no new commit after salvage, the engine **SHALL** evaluate whether current HEAD already satisfies the **declared stage goal**; if yes, advance with an **attested evidence note**; if no, escalate with a **typed reason** (not a generic silent “no commits” dead-end without classification).
- **Refactor** existing per-stage special cases onto the shared mechanism, **behavior-preserving**:
  - pre-merge clean auto-fix → re-verify (#698 / `noop-clean`)
  - pre-merge OpenSpec archive “already satisfied / no residual active” coherence (#714)
  - pre-merge partition + post-noop residual disposition (#747 surface of the same class)
  - fix-stage override-empty skip, does-not-reproduce advance, external-commit advance
  - planning/implement: declared deliverable already present (spec-only / planning-commit path, #588)
- Wire the same verifier into **normal stage execution** and **#787 recovery re-entry** for `no-commits` → `implementation-ci`: first deterministic recipe is goal-satisfaction check + attested advance (no model-repair budget when HEAD already satisfies), without a new per-stage marker or bypass of normal gates.
- Add regression tests that replay #698, #714, #747, and #588 scenarios through the shared path (injected deps; no real network/git/subprocess).
- Regenerate `plugin/` after any `core/` change; `npm run ci` green.

## Acceptance criteria

Observable, falsifiable outcomes that make this issue done:

- [ ] A single shared evaluation path (one module/API surface) decides “no new commit → goal already satisfied?” for at least: fix-round, planning implement, and pre-merge auto-fix / archive-adjacent no-new-work outcomes — stages do not each keep an independent full copy of the decision skeleton.
- [ ] When evaluation returns **satisfied**, the stage advances (or continues pre-merge) **without** inventing an empty commit and **without** `setBlocked(..., "no-commits")` solely because no new commit was produced; an attested evidence note is recorded (comment, event, or equivalent durable audit) naming stage, HEAD SHA, and satisfaction rationale class.
- [ ] When evaluation returns **not satisfied**, the stage escalates with a typed reason / existing blocker kind path — fail closed; no silent success.
- [ ] Pre-#698 regression: pre-merge auto-fix ends clean no-commit and re-verify (or equivalent HEAD goal check) is clean → pre-merge proceeds; still-broken → one needs-human (or equivalent typed) escalation with no-op recipe — via the shared path.
- [ ] Pre-#714 regression: legitimate empty active OpenSpec set / archive goal already met does not dual-signal skip-then-block for the same head evaluation; residual active ids still fail closed coherently — via the shared satisfaction/coherence evaluation, not a second private special case.
- [ ] Pre-#747 regression: mixed allowlisted + residual batch still partitions; clean no-commit on the allowlisted subset re-verifies through the shared path rather than hard-blocking solely for “no commit.”
- [ ] #588 regression: a spec-only (or planning-commit) issue whose accepted OpenSpec deliverable already landed in the planning commit advances through implementing **without** requiring an empty implementer commit; shared mechanism verifies clean HEAD, declared artifact presence, and relevant gates; regression exercises a **fresh process/re-entry** path (not only an in-memory helper).
- [ ] Existing fix-stage override-empty, does-not-reproduce, and external-commit advance behaviors remain green through the shared path (prior regression tests retained and passing).
- [ ] #787 recovery re-entry for `no-commits` / `implementation-ci` uses the same verifier as the first deterministic recipe; when HEAD already satisfies the stage goal, recovery advances with attested evidence **without** charging model-repair budget; when not, later recipes / fail-closed paths still apply. No new per-stage bypass of gates.
- [ ] Unit tests inject deps only (no real network, git, or subprocess); tests fail if the shared evaluation is removed or stages reintroduce private hard-block-on-clean-no-commit without goal check.
- [ ] `openspec validate generalized-noop-advance-contract` passes; after implementation, `npm run ci` green and `plugin/` mirror regenerated when `core/` changes.

## Capabilities

### New Capabilities

- `noop-advance-contract`: Stage-agnostic contract and evaluation surface for no-new-commit rounds: stage-declared goal satisfaction at HEAD, attested evidence on advance, typed escalation when unsatisfied, shared use from stage execution and recovery re-entry.

### Modified Capabilities

- `fix-round-noop-advance`: Override-empty skip and does-not-reproduce advance remain required outcomes but are expressed as instances of the shared contract (behavior-preserving).
- `fix-external-commit-advance`: External-commit advance (HEAD past reviewed SHA) remains required but routes through the shared no-new-commit decision path.
- `pre-merge-fix-round`: Clean noop re-verify / one-attempt / partition residual policy remains; clean no-commit terminal disposition is an instance of the shared contract rather than a pre-merge-only private skeleton.
- `pre-merge-delta-recheck`: Post-auto-fix no-op path continues to re-enter verification; wording aligns with shared goal-satisfaction evaluation (no hard block solely for no commit when HEAD satisfies).
- `shared-harness-round`: Clean no-new-commit path may invoke the shared goal-satisfaction evaluation callback/contract rather than only stage-private block/noop forks.
- `harness-uncommitted-salvage`: Pre-merge clean-noop disclosure still precedes re-verify; terminal disposition remains re-verify/goal-check then proceed or escalate — not immediate needs-human solely for clean no-commit.
- `blocked-recovery-recipes` / `autonomous-recovery-controller` (as applicable): `no-commits` projecting to `implementation-ci` gets a deterministic first recipe: shared HEAD goal-satisfaction check + attested advance when satisfied, without a new marker or gate bypass.
- `implementing-resume` / planning implement path requirements (as applicable via `unified-planning-phase-runner` consumers): #588 — deliverable already present in planning commit advances without empty implementer commit when goal check passes.

## Impact

- **Code (implementation phase, not this step):** likely a small shared module under `core/scripts/` (e.g. goal-satisfaction / noop-advance helper) consumed by `stages/fix.ts`, planning implement, `pre-merge-autofix.ts` / pre-merge SHA gate, archive guard coherence call sites, and recovery recipe entry for `no-commits`; unit tests co-located under `core/test/`.
- **Specs:** new living capability after archive; deltas to listed capabilities.
- **Operators / rigor:** fewer false `no-commits` / `needs-human` parks when work is already correct at HEAD; review rigor, allowlists, one-attempt bounds, and CI gates unchanged.
- **Out of scope:** new auto-fix categories; review-policy severity changes; inventing empty commits; autonomous merge; expanding recovery into product judgment.
- **Sequencing note:** issue text allows sequencing with or after the #628 pre_merge split; design MUST not require undoing that modularization.
- **Subsumes:** once acceptance text for #588 is tracked here and implemented, close #588 as subsumed.

## Non-goals

- New auto-fix categories or review-policy changes (rigor unchanged).
- Auto-merge or unattended merge.
- Weakening fail-closed behavior when HEAD does **not** satisfy the stage goal.
- Replacing salvage, dirty fail-closed, or genuine commit-producing fix flows.
