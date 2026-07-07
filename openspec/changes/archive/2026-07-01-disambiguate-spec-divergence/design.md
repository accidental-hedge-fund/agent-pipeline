## Context

The consistency guard (`core/scripts/openspec-consistency.ts`) blocks a pre-merge/fix-round advance when `specDeltaIsStale(id, devCommits)` (implementation files changed in a commit ordered after the last `specs/**`-changing commit) AND the most recent review verdict carries the structured `category: spec-divergence` marker (`reviewCommentFlagsSpecDivergence`). It is invoked at fix-round via `enforceFixOpenspecConsistency` (`stages/fix.ts`) and at archive via `maybeArchiveOpenspec` (`stages/pre_merge.ts`), and blocks with `blockerKind: "openspec-stale-delta"` and the reason from `staleSpecDeltaBlockReason`.

`specDeltaIsStale` returns true for *any* branch that changed implementation without changing that change's `specs/**` — including the common, correct case where the delta was authored complete at planning time and only the code needed fixing. `category: spec-divergence` says "code and spec disagree" but not which is authoritative. The two together therefore fire on both the #849 shape (code behind an already-correct spec) and the genuine stale-delta shape.

## The #849 failure, precisely

1. Planning authored a delta requiring per-contract chat isolation. The delta was correct.
2. Review 2 found the implementation violated that requirement and tagged the finding `category: spec-divergence`.
3. `fix-2` correctly changed implementation only (no `specs/**` edit) to satisfy the existing requirement.
4. Guard evaluation: `specDeltaIsStale` = true (impl commit after last spec change; on this branch `specs/**` was never touched, so `lastSpecIdx = -1`), and the latest review verdict still carried the pre-fix `spec-divergence` marker → blocked as `openspec-stale-delta`, requesting human spec repair for a spec that was already right.

The two defects: (a) the guard cannot tell *code-behind-spec* from *spec-behind-code*, and (b) it decides on a pre-fix marker rather than the current post-fix state.

## Goals / Non-Goals

**Goals**
- Let normal fix rounds change implementation to satisfy an already-correct active delta without a human blocker.
- Keep genuinely stale deltas out of the living specs.
- Resolve routine cases autonomously (one bounded, verifiable, spec-only repair) before asking a human.

**Non-Goals**
- Removing, disabling, or lowering the guard (explicitly out of scope in #356).
- Letting the automatic spec-repair step edit application code.
- Any new review→planning state edge, or semantic diff between spec prose and code.
- Requiring Hermes/desktop/worker wrappers to handle this — the logic lives in the shared pipeline core.

## Decisions

**Decision: disambiguate on a structured *direction* signal, never on prose.**
The reviewer already emits a structured `category` on findings (single-sourced in `review-schema.ts`, read via `categoryMarker`/`reviewCommentFlagsSpecDivergence`). A `spec-divergence` finding gains a direction: `code-behind-spec` (implementation must change; the delta is authoritative) or `spec-behind-code` (accepted behavior moved past the delta; the delta must change). The guard reads the direction from the controlled marker only — never by keyword-matching prose. This preserves the hard-won #106 discipline (prose-matching a divergence is adversarially unwinnable). Rationale: the direction is exactly the fact the guard is missing, and the reviewer is the agent that already made the judgment.

**Decision: the default for an ambiguous/unclassified signal is conservative-open toward the fix round.**
If a `spec-divergence` finding carries no direction, or its direction is `code-behind-spec`, there is no positive evidence the *delta* is stale, so the guard SHALL NOT force spec repair and SHALL NOT block the fix round on the file-order signal alone. This directly fixes #849 and is safe: a code-behind-spec finding is a normal review finding that the fix round + the #16 SHA re-review already handle. Spec-only staleness still requires the positive `spec-behind-code` signal.

**Decision: decide on the current post-fix state.**
The guard SHALL treat a divergence as unresolved only when it reflects the post-fix head — i.e. the divergence signal comes from a review of the current head (verdict `commitSha` matches HEAD) or reproduces against it. A `spec-divergence` marker from a review that predates a later fix commit is a resolved pre-fix marker and SHALL NOT, by itself, drive the stale-delta decision. This closes defect (b).

**Decision: one bounded, code-frozen, validated automatic spec repair before blocking.**
Only on positive `spec-behind-code` evidence, the pipeline attempts exactly one automatic repair, and only when it can be verified without touching application code. The attempt:
- may modify only files under `openspec/changes/<id>/specs/**` and that change's `tasks.md`;
- if the attempt changes any file outside that allow-list (any application/test code), it is rejected and the run blocks;
- must pass `openspec validate <id>` (structural backstop, matching the existing `enforceOpenspecSpecDeltaValidation` seam);
- is committed with the run's normal `Issue:`/`Pipeline-Run:` traceability trailers;
- re-runs the stale-delta guard exactly once afterward; still-stale → block.
Bounded to one attempt so a mis-repair cannot loop; the human blocker is the backstop.

**Decision: direction-specific block reason.**
When the guard blocks, the reason states which alignment remains: *code alignment* (implementation still diverges from the active spec — resolve in code) or *spec-delta alignment* (the active delta is stale and automatic repair did not converge — resolve the delta). The `openspec-stale-delta` `BlockerKind` and its recovery recipe (in the `blocked-recovery-recipes` capability) are unchanged; the direction is carried in the reason string, so no new enum value or recipe-snapshot change is required.

**Decision: deps/fake seam pattern for the new logic.**
The direction classifier, the post-fix evaluation, and the bounded-repair orchestration take injectable deps (branch-commit reader, issue-detail reader, `openspec validate`, harness invoker, `setBlocked`) so every path is unit-tested with no real git, openspec CLI, GitHub, or harness — mirroring `SpecConsistencyDeps`, `AdvancePreMergeDeps`, and `enforceOpenspecSpecDeltaValidation`.

## Conflict surfaced (must be reconciled at implementation time)

The guard's *base* blocking behavior is **not in the living specs**. `openspec/specs/openspec-integration/spec.md`'s "Archive into living specs at finalize" requirement is still the pre-guard version (no consistency-guard clause), and no living capability describes the guard's block condition. That behavior is described only by the still-active, **un-archived** change `openspec/changes/fix-round-spec-delta-consistency/` (whose code shipped in #106/#113, commit `29a9bc3`, but whose OpenSpec change was never archived — living-spec drift).

Consequences this change deliberately accounts for:
- We cannot author a `MODIFIED` delta against a living requirement that does not exist, so this change ADDs a new capability (`openspec-divergence-disambiguation`) that fully and independently specifies the disambiguated behavior.
- At archive time the two changes must be reconciled so the surviving description of the guard is the disambiguated one. If `fix-round-spec-delta-consistency` archives first, its guard clause lands in `openspec-integration`; this capability then narrows it. If this change archives first, `fix-round-spec-delta-consistency` must not re-broaden the guard. Reconciling that drift is tracked separately (it is the same living-spec-drift class this guard was built to prevent) and is out of scope for #356's code.

## Risks / Trade-offs

- *Reviewer omits the direction on a genuinely stale delta.* Then there is no positive `spec-behind-code` signal and the guard proceeds — a stale delta could archive. Mitigation: the structural `specDeltaIsStale` file-order signal still gates the repair/block path, and the reviewer prompt is updated to emit the direction on every `spec-divergence` finding; the risk is strictly smaller than today's over-block and never corrupts the living spec silently for the shapes we test.
- *Automatic repair writes a plausible-but-wrong requirement.* Mitigation: one attempt only, `openspec validate` gate, code-frozen allow-list, and the #16 SHA re-review of the spec-updating commit; human blocker remains the backstop.
- *Direction marker drift (emit vs read).* Mitigation: single-source the direction token next to `categoryMarker`/`SPEC_DIVERGENCE_CATEGORY` and drift-guard emit/read with a test, exactly as the existing category marker is guarded.
