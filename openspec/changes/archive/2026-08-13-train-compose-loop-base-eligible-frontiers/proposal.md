## Why

`pipeline train` (and Tugboat ship, which is `train --merge` plus release) must not be a second multi-item advance orchestrator. A production N×`single` / one-item advance loop and a whole-train STOP on leftover `blocked` / `needs-human` reimplements scheduling outside loop and wastes loop’s recovery, resume, and conflict-aware parallel advance. Naive “one loop over the whole milestone → all ready-to-deploy → merge everyone” is also wrong for code-stacked deps: worktrees branch from `origin/<base_branch>`, not sibling PR heads, so a child that needs parent commits must wait until the parent merge-result is on base. This change makes train a two-wave facade over base-eligible frontiers with a serial merge barrier.

## What Changes

- Train becomes a **two-wave facade** over the durable loop (or an injected advance-wave seam), repeated until the work list is done or only non-progressing holds remain:
  1. **Frontier:** items whose code prerequisites are integrated (merge-result contained in the fetched base) and that are eligible to co-advance under ownership/conflict rules (unknown overlap serializes; unknown dep kind fails closed as code dep).
  2. **Advance wave:** exactly one multi-item loop/advance-wave call for that frontier only (recovery and parallel disjoint advance stay inside loop).
  3. **Merge wave** (only when `--merge`): serial `pipeline merge` + squash-aware base containment for ready-to-deploy items in that frontier; never inside loop; never parallel merges.
  4. Recompute the frontier after base tip movement.
- Production `runTrainCommand` and ship/Tugboat train paths wire multi-item loop advance waves; they MUST NOT use production N×`single` or `advanceWaveFromSingle` as the default production path.
- Partial failure: a parked/blocked item MUST NOT abort merge of a **proven-independent** ready-to-deploy sibling; fail closed when independence cannot be proven. The blocked item itself is not merged.
- Recovery stays loop’s job inside the advance wave; train does not invent a second recoverer or call `repair_pipeline_item` itself.
- Already R2D / already-integrated paths stay idempotent. Tugboat keeps calling `train --merge` (no playbook fork).

## Acceptance criteria

- [ ] Per frontier, train invokes **one** multi-item loop/advance-wave call (not N×`single`); a unit test with injected deps asserts that call shape.
- [ ] Independent pair (no dep edge, proven-disjoint ownership) may co-advance in one frontier when concurrency / `max_concurrent_worktrees` is greater than 1.
- [ ] `Depends on: #A` where B needs code on base: merge + contain A before B’s advance wave; B is not scheduled while A’s merge-result is not on base.
- [ ] `--merge`: merges are serial; base containment is proven between merges; advance never merges.
- [ ] One blocked/parked item + independent ready-to-deploy sibling: sibling may merge; the whole train does not abort before that merge when independence is proven; the blocked item is not merged.
- [ ] `concurrency: 1` / `max_concurrent_worktrees: 1` keeps advance serial; merge waves stay serial regardless.
- [ ] Production `runTrainCommand` (and ship train path) wire multi-item loop advance; tests fail if production path falls back to N×`single` / `advanceWaveFromSingle`.
- [ ] Unit tests inject loop/train deps (no real network, git, or subprocess); `plugin/` mirror regenerated if `core/` changes; `npm run ci` green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `integrated-train-mode`: Pin train as a base-eligible frontier two-wave facade (one multi-item advance wave per frontier + optional serial merge barrier); code-dep integrate-before-child-advance; independent peer co-advance and independent R2D merge under proven independence; production CLI/ship wiring must not be N×`single`.

## Impact

- `core/scripts/stages/train.ts` — frontier selection, advance-wave orchestration, merge-wave isolation, independent-sibling continuation.
- `core/scripts/pipeline.ts` — `runTrainCommand`, `advanceWaveThroughLoop` (or equivalent), ship/Tugboat train deps wiring to multi-item loop.
- Related ship adapter if it builds train deps.
- `core/test/train.test.ts` and CLI/ship wiring regression tests.
- Generated `plugin/` mirror after any `core/` edit.
- Consumes loop `#528`–`#531` (do not reimplement recovery, ownership, or parallel schedule).
- Soft: dogfood ship benefits from `#1020` / `#1025` recoverers; they do not block this composition landing with tests first.
- Must not depend on `#1024` (continuous ship) or re-open `#647`.
- No auto-merge without `--merge` / operator authority; no `auto_merge` config; merge authority boundary unchanged; no PR stacking onto parent PR head; no Hermes/Buzz-only orchestration.
