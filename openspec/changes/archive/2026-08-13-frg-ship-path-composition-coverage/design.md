## Context

See `proposal.md` for motivation. Product behavior for frontier train∘loop (#1023), scratch-only recover (#1020), and stale-block re-review (#1025) is already specified under `integrated-train-mode`, `engine-scratch-recover`, and `stale-blocked-rereview`. FRG already has Layer A hermetic scenarios and a fixed Layer B pack inventory; ship-path composition is **not** yet a first-class non-silent-gap composition class set.

Current tests already cover many unit islands (`train.test.ts` frontier/wave shape and independent R2D merge; recovery unlink-before-repair; dirt classifier; stale-block resume). #1029 exists until **composition evidence** is inventory-guarded and the three hard acceptance bites remain mandatory under CI — including when island tests drift or are deleted.

## Goals / Non-Goals

**Goals:**

- Define a small, stable set of **ship-path composition class ids** with hermetic tests (and optional FRG Layer A mapping) that fail on the named regressions.
- Prefer reusing existing injected seams (`train` deps, recovery executor, dirt classifier) over new production code paths.
- Keep Layer B pack ids frozen unless implementation explicitly maps composition classes as Layer A-only sources (no live network ship in CI).
- Allow implementation to satisfy a class by an existing unit test **if** that test already fails on the defective composition; still require inventory so the class cannot vanish silently.

**Non-Goals:**

- Full live Tugboat / network ship in CI.
- Continuous `ship_model` (#1024).
- Expanding Layer B fixed scenario pack for this issue (defer live pack restore to #1035).
- Re-implementing train frontier, scratch unlink, or stale-block product logic (those are #1020/#1023/#1025).
- Weakening security denylist or true human-authority classes.
- Production N×`single` train or STOP-on-first-blocked as an allowed path.

## Decisions

### Decision 1: New capability owns composition contract; product specs gain ADDED proof requirements

- **Choice:** Introduce `ship-path-composition-coverage` as the SSOT for composition class ids, inventory, and bite scenarios. Add ADDED requirements on `factory-reliability-gate`, `integrated-train-mode`, `engine-scratch-recover`, and soft `stale-blocked-rereview` that point composition proof at that suite (no MODIFIED rewrite of existing product requirements).
- **Why:** Product specs already state behavior; rewriting them risks archive churn. Composition coverage is cross-cutting and belongs in one inventory.
- **Alternatives:** Only extend FRG Layer A scenario list — rejected because Layer B pack freeze and Layer A ids today track the ten FRG scenarios, not train/scratch ship path. Only document in runbook — rejected because acceptance requires automated fail-on-regression.

### Decision 2: Hermetic unit composition first; FRG Layer A optional mapping

- **Choice:** Satisfy hard acceptance with injected unit composition tests under `core/test/` (existing files or a dedicated `ship-path-composition*.test.ts`). Optionally map class ids into FRG Layer A ownership / composition dimension `source: layer_a` for scoreboard honesty; do **not** require live Layer B for pass of this issue.
- **Why:** Issue explicitly allows “FRG fault-pack and/or injected unit”; CI already runs unit suite via `npm run ci`. Live ship is a non-goal.
- **Alternatives:** Require Layer B live composition in CI — rejected (live network ship out of scope). FRG-only without unit — rejected (release FRG is not every PR’s gate).

### Decision 3: Stable composition class ids (freeze list)

Minimum hard classes (names illustrative; implementation may use these exact ids):

| Class id | Regression that MUST fail the suite |
| --- | --- |
| `train-frontier-one-wave` | Train issues N×`single` / multiple advance-wave calls for one multi-item base-eligible frontier, or production wiring defaults to `advanceWaveFromSingle` |
| `train-code-dep-merge-barrier` | Code-dependent B enters advance wave before A’s merge-result is contained in fetched base |
| `train-independent-r2d-merge-partial-failure` | Proven-independent already-R2D sibling is not merged (or whole train aborts before that merge) solely because a peer is parked/blocked |
| `scratch-only-no-needs-human` | Scratch-only porcelain parks as `needs-human` / `pipeline:needs-human` or sets blocked solely for that porcelain at a dirt gate |
| `scratch-only-unlink-not-repair` | Scratch-only recovery invokes `repair_pipeline_item` before/instead of successful `unlink_engine_scratch` |

Soft class:

| Class id | Regression |
| --- | --- |
| `stale-blocked-rereview-before-train-stop` | Stale `blocked` + newer non-internal HEAD terminal-STOPs train/loop without one resume re-review attempt |

### Decision 4: Inventory + drift guard, not duplicate product logic

- **Choice:** Maintain a machine-readable inventory (constant, table, or co-located test map) of composition class id → covering test name(s) or module. A drift-guard test fails when a hard class lacks a covering test registration, or when a registered test file/export disappears. Prefer asserting on observable outcomes (wave call count, merge call list, block kind, repair invocation count) via injected deps — same pattern as `train.test.ts` and `pipeline-recovery-executor.test.ts`.
- **Why:** Island tests already exist; the failure mode for #1029 is **silent deletion or non-composition**. Inventory makes absence fail CI.
- **Alternatives:** Only prose checklist in the issue — rejected. Force one mega end-to-end test for all classes — optional as a bonus, not required; smaller hermetic tests that each bite one composition are easier to maintain.

### Decision 5: STOP-on-first-blocked is the anti-goal shape for train

- **Choice:** The `train-frontier-one-wave` and `train-independent-r2d-merge-partial-failure` classes together prove the anti-goal “N×`single` STOP-on-first-blocked” does not return: one multi-item wave per frontier, and partial failure does not abort independent R2D merge.
- **Why:** Matches issue acceptance wording and #1023 product contract without inventing a new train algorithm.

### Decision 6: Dependencies and fold-in policy

- **Choice:** Implementation may mark a class satisfied by tests landed under #1020/#1023/#1025 PRs if those tests meet the bite criteria; this change’s tasks still add inventory + any missing bites. Keep issue #1029 open until the inventory and hard classes are green in this change (or equivalent evidence on main).
- **Depends on:** #1020, #1023 product behavior. Soft: #1025. Complementary after v1.38.1: #1035 Layer B pack restore.

## Risks / Trade-offs

- **[Risk] Duplicate tests vs inventory-only** → Prefer inventory mapping to existing tests; add new tests only for missing bites.
- **[Risk] Over-coupling composition tests to private symbols** → Assert on injected dep call shape and labels/blocker kinds, not private helper names.
- **[Risk] Expanding FRG Layer B accidentally** → Explicit non-goal; Layer A / unit only for this issue.
- **[Risk] Soft #1025 class skipped forever** → Soft class may be waived with open tracking issue in inventory; hard classes cannot.

## Migration Plan

1. Land OpenSpec change (this step).
2. Implement inventory + missing tests; run `npm run ci`.
3. If `core/` changes, regenerate `plugin/` in the same commit.
4. Archive OpenSpec change at pre-merge with other issue work.
5. No runtime migration; pure test/contract surface.

## Open Questions

None that block specs. Implementation may choose dedicated test file vs co-location; both satisfy the inventory requirement.
