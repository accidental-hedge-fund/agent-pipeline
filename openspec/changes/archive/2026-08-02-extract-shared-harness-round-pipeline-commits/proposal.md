## Why

Planning implement, fix, visual-fix, eval-fix, and pre-merge auto-fix each reimplement the same implementer-round skeleton: reattach → capture `headBefore` → invoke → salvage → commit-gate → format/test → push. That duplication has already produced salvage/reattach drift bugs (#486, #547, #553, #521). Separately, `isPipelineInternalCommit` and its subject prefixes live in `pre_merge` while `shipcheck` imports them — an FSM-backward coupling — and visual produces publish subjects that pre_merge must classify. Architectural review (2026-07-27, stages) called out both smells; #787 then added another implementer round in loop recovery that must not re-fork the same skeleton.

## What Changes

- Extract a **shared harness-round** helper that owns the common implementer-round lifecycle (reattach / head capture / invoke / salvage / commit-range verification hooks / optional format-test / push coordination), parameterized by stage-specific gates and labels.
- Migrate **fix, planning implement, visual-fix, eval-fix, and pre-merge auto-fix** call sites onto that helper without changing salvage semantics, commit-format rules, or push/review outcomes.
- Move **pipeline-internal commit classification** (`isPipelineInternalCommit` plus the OpenSpec archive prefix, visual publish exact-match pattern, and related subject constants the classifier needs) into a **neutral module** (e.g. `pipeline-commits.ts`) owned by neither pre-merge nor shipcheck nor visual.
- Stop `shipcheck` → `pre_merge` import for classification; pre-merge, shipcheck, review-SHA gate, and tests all consume the neutral classifier.
- Disposition **#787 `repair-pipeline-item`**: either make it a shared-round consumer (directly or via pre-merge auto-fix), or document and regression-test a narrow exemption that still preserves attempt breadcrumb, ownership proof, idempotent post-push reconciliation, and refusal to adopt unrelated human commits.
- Keep existing reattach + salvage regression nets biting; regenerate `plugin/`; no salvage-semantics rewrite and no full pre_merge file split.

## Acceptance criteria

- [ ] A shared harness-round helper exists under `core/scripts/` (name may vary) and is the single implementation of the reattach → headBefore → invoke → salvage → commit-gate → (optional format/test) → push skeleton used by the stage consumers below.
- [ ] Fix-round, planning implement, visual-fix, eval-fix, and pre-merge bounded auto-fix each invoke that shared helper rather than maintaining a private full copy of the skeleton.
- [ ] Salvage behavior (when salvage runs, subject/trailers, node_modules and marker exclusions, failure-reason disclosure, scoped OpenSpec authoring salvage) is unchanged relative to the pre-change living `harness-uncommitted-salvage` contract.
- [ ] `isPipelineInternalCommit` and the subject prefixes/patterns it depends on live in a neutral module (e.g. `pipeline-commits.ts`); that module does not import stage modules (`pre_merge`, `shipcheck`, `visual`, …).
- [ ] Runtime classification matches today’s tested truth: OpenSpec archive prefix and exact visual-publish subject are internal; docs-update, auto-format, pre-merge auto-fix, and ordinary developer/fix subjects are not.
- [ ] `core/scripts/stages/shipcheck.ts` does **not** import from `./pre_merge.ts` (or any `pre_merge` path) for classification or related commit-subject constants.
- [ ] Pre-merge SHA-gate currency, shipcheck post-verdict revalidation, and visual publish classification all resolve `isPipelineInternalCommit` from the neutral module (directly or via a thin re-export that does not reintroduce the stage cycle).
- [ ] #787 `repair-pipeline-item` is either a shared-round consumer or a documented, tested exemption; attempt breadcrumb, ownership proof, idempotent post-push reconciliation, and refusal to adopt unmarked human commits remain enforced.
- [ ] Existing reattach and salvage regression tests still fail without their protections and pass with them; new regression tests cover the module-boundary break (no shipcheck→pre_merge classification import) and the #787 consumer/exemption disposition.
- [ ] `node scripts/build.mjs --check` reports the mirror in sync and `npm run ci` is green.
- [ ] No salvage-semantics redesign, no full pre_merge file split, and no auto-merge path is introduced.

## Capabilities

### New Capabilities

- `shared-harness-round`: Single shared implementer-round orchestration used by fix, planning implement, visual-fix, eval-fix, and pre-merge auto-fix; parameterized stage-specific gates; #787 recovery path consumer-or-exemption contract.
- `pipeline-commits`: Neutral ownership of pipeline-internal commit classification and the subject prefixes/patterns the classifier and related stages need, without stage-to-stage FSM coupling.

### Modified Capabilities

- `shipcheck-gate`: Post-verdict revalidation continues to honor pipeline-internal commits, but classification is obtained from the neutral module — not via a `pre_merge` import.
- `review-sha-gating`: Pipeline-internal classification requirement is updated to the single-sourced classifier (archive + exact visual publish; not docs/auto-format/auto-fix), owned outside pre_merge.
- `harness-format-lint-gate`: Align the living “auto-format is pipeline-internal” requirement with the tested #228 disposition (auto-format is **not** pipeline-internal) once classification is single-sourced.
- `visual-gate`: Artifact-publish subject remains pipeline-internal via the neutral classifier; prefix ownership moves out of the pre_merge coupling path.
- `pre-merge-fix-round`: Auto-fix subject remains developer-classified via the neutral classifier; auto-fix path becomes a shared-round consumer without changing one-attempt bound, re-review, or noop-clean semantics.
- `harness-step-verification`: Capture-then-verify / salvage-before-gate pattern remains required, but stage steps satisfy it through the shared harness-round helper rather than private copies of the skeleton.
- `harness-uncommitted-salvage`: Call sites for implement/fix/visual/eval/pre-merge salvage remain required; they are reached via the shared round (semantics unchanged).
- `autonomous-recovery-controller` (or the recovery remediation path covering `repair-pipeline-item`): Document consumer-or-exemption for the shared round while preserving #787 breadcrumb, ownership, and reconciliation invariants.

## Impact

- **Core modules:** new/neutral modules under `core/scripts/` (harness-round helper + `pipeline-commits`); consumers in `stages/{fix,planning,visual,eval,pre_merge,shipcheck}.ts`, `testgate.ts` as applicable, and `loop/repair-pipeline-item.ts`.
- **Tests:** existing salvage/reattach/SHA-gate/visual-publish/auto-format classification tests keep biting; new boundary tests for shipcheck import graph and shared-round wiring / #787 disposition.
- **Living specs:** two new capabilities plus the modified capabilities listed above.
- **Generated mirror:** `plugin/` regenerated with `node scripts/build.mjs`.
- **Out of scope:** changing salvage engine semantics; full pre_merge file split (sibling issue); auto-merge; review-policy weakening; inventing new internal commit classes beyond the current tested set.
