## Context

Multiple implementer-facing stages independently copy the same post-worktree lifecycle:

1. reattach detached worktree to the pipeline branch (where applicable)
2. capture `headBefore`
3. invoke harness
4. on no-new-commit + dirty tree (and often crash/timeout), salvage
5. verify commit-range / subject / path constraints
6. optional format / test gates
7. push (or hand off to stage-owned push)

Proven drift: salvage was missing or incorrect on implement crash (#486), pre-merge auto-fix (#547), clean-tree disclosure (#553), and failure-reason reporting (#521). Each fix landed in one call site while siblings lagged.

Separately, internal-commit classification is inverted in the module graph:

- `isPipelineInternalCommit` + OpenSpec archive prefix + visual-publish exact pattern live in `stages/pre_merge.ts`
- `stages/visual.ts` owns `VISUAL_PUBLISH_COMMIT_PREFIX` (publish producer)
- `stages/shipcheck.ts` **imports** `isPipelineInternalCommit` from `pre_merge` — shipcheck sits *after* pre-merge in the FSM, so a later stage depends on an earlier stage’s private classifier
- Living specs disagree with runtime tests on the classifier set:
  - **Runtime + tests (ground truth for this change):** archive prefix + exact visual publish → internal; docs, auto-format (#228), pre-merge auto-fix, ordinary developer/fix → not internal
  - `review-sha-gating` still says “archive only”
  - `harness-format-lint-gate` still says auto-format is internal (tests assert the opposite)

PR #787 added `core/scripts/loop/repair-pipeline-item.ts`: another implementer path with invocation, salvage (via `performPreMergeAutoFix`), commit proof, push verification, crash reconciliation, attempt breadcrumb (`refs/pipeline-recovery/<attemptId>`), and hard refusal to adopt unmarked human commits. Any shared-round extraction must not flatten those #787 invariants.

## Goals / Non-Goals

**Goals:**

- One shared harness-round orchestration for the common skeleton, with injectable seams (git / invoke / salvage / verify / format / push) matching existing test patterns.
- Stage consumers (fix, planning implement, visual-fix, eval-fix, pre-merge auto-fix) call the helper instead of private full copies.
- Neutral `pipeline-commits` (name may vary) owns classification + the subject constants/patterns the classifier needs.
- Break shipcheck → pre_merge classification import.
- Align living classification requirements with the tested runtime set when single-sourcing.
- Explicit #787 consumer-or-exemption with regression coverage.

**Non-Goals:**

- Changing *when* salvage fires, salvage message shape, node_modules/marker exclusions, or scoped OpenSpec authoring salvage.
- Full pre_merge file split (sibling issue).
- Expanding the internal-commit set beyond the current tested set (no new auto-format-as-internal revival).
- Auto-merge, review-policy weakening, or merging authority changes.
- Unifying stage-specific commit-format patterns, prompts, or one-attempt bounds into one mega-API beyond what the shared skeleton needs.

## Decisions

### 1. Two extractions modules, not one

**`pipeline-commits.ts` (neutral classification)** — pure (or near-pure) exports:

- OpenSpec archive subject prefix
- Visual publish subject prefix + exact-match pattern used by the classifier
- `isPipelineInternalCommit(messageHeadline: string): boolean`
- Re-exports or co-location of any other *classification-relevant* constants stages currently reach only through pre_merge for the SHA gate

**`harness-round.ts` (or equivalent shared helper)** — orchestration of the implementer-round skeleton with a narrow options bag:

- worktree path / issue / run id
- pre-invoke hooks (reattach on/off)
- invoke function + prompt assembly (caller-supplied or callback)
- salvage stage label + optional scope
- commit-range verification callback
- optional format/test gate callbacks
- optional post-success push callback
- deps seams for all I/O

Rationale: classification is pure policy used by pre-merge, shipcheck, tests, and visual comments; the round helper is async orchestration. Combining them would re-couple pure classification to harness I/O.

**Alternatives considered:**

- *Leave classifier in pre_merge and re-export.* Does not break the conceptual ownership smell; shipcheck would still depend on a stage module.
- *Put classifier on visual because it owns the publish prefix.* Wrong center of gravity — archive and auto-fix non-membership are not visual concerns.
- *One mega “stage-utils” bag.* Rejected — encourages dumping unrelated helpers.

### 2. Preserve current tested classification; fix living-spec drift as part of single-sourcing

Canonical rule for this change (matches `pre-merge-sha-gate.test.ts`):

| Headline shape | Internal? |
| --- | --- |
| `chore: archive OpenSpec change(s) for #…` (prefix) | yes |
| exact `chore: publish visual-gate evidence for #<digits>` | yes |
| `docs: …` | no |
| `chore: auto-format (#…)` | no (#228) |
| `fix: pre-merge auto-fix…` | no |
| ordinary feat/fix/chore | no |

Exact visual-publish match (full subject, not “starts with”) stays — a developer commit that only *begins* with the publish words must remain non-internal (#463 review finding).

Living requirements that claim “archive only” or “auto-format is internal” SHALL be updated in delta specs so archived living specs match the single source. This is not a behavior change; it is conflict resolution with tests as source of truth (per operating contract: surface conflicts, do not average them).

### 3. Shared round owns the skeleton; stages keep product policy

The helper does **not** invent new commit subjects or finding policies. Stages pass:

- salvage labels (`fixSalvageStageLabel`, `visualFixSalvageStageLabel`, pre-merge auto-fix label, …)
- verification functions already used today (`enforceFixCommitGate`, visual/eval/test-fix format enforcers, implement issue-ref gate, …)
- whether reattach runs
- whether format/test gates run and in what order
- push vs “return head for caller to push”

Pre-merge auto-fix retains amend-to-`PRE_MERGE_AUTOFIX_PREFIX`, one-attempt bound, noop-clean outcome, and delta re-review — those remain pre-merge product logic layered around or after the shared skeleton.

**Alternative:** force every stage through an identical gate sequence. Rejected — implement, fix, and gate-fix paths have deliberately different gates; unifying them would change behavior.

### 4. Migration order: classifier first, then round consumers

1. Extract `pipeline-commits` and switch all imports (pre_merge, shipcheck, tests, any visual cross-import of the pattern). Keep re-exports from pre_merge **only if** needed for test compatibility short-term; re-exports must not reintroduce shipcheck→pre_merge.
2. Introduce harness-round helper beside the greediest duplicated path (likely fix or pre-merge auto-fix) with parity tests.
3. Migrate consumers one stage at a time with existing stage tests green at each step.
4. Disposition #787 last (consumer via auto-fix, or exemption test).

### 5. #787 `repair-pipeline-item` disposition

**Preferred:** substantive implementer work continues to go through `performPreMergeAutoFix` (which becomes a shared-round consumer). The recovery shell keeps:

- durable pre-invocation breadcrumb ref keyed by attempt id
- ownership proof before amend/push of unmarked commits
- idempotent post-push reconciliation of already-pushed marked repairs
- refuse-to-adopt unmarked human commits / dirty trees / diverged local history
- label-clear retry that does not fail a verified push

That shell is a **documented narrow exemption** from “must call harness-round directly,” because it is recovery control-plane, not a stage implementer round. A regression test SHALL lock the exemption boundary (breadcrumb + refuse unmarked) and SHALL assert that the substantive path still hits the shared auto-fix / shared-round stack (e.g. via inject seam or call-graph test).

**Alternative:** force repair to call harness-round directly and drop `performPreMergeAutoFix`. Rejected for this issue — duplicates pre-merge auto-fix identity (prefix, salvage label, noop-clean) and risks #787 invariant loss.

### 6. Prove boundaries with runtime tests (no tsc)

Because types are stripped, cycle/ownership breaks need source or import-graph assertions, same spirit as other drift guards:

- shipcheck source has no `pre_merge` import
- `pipeline-commits` source has no `stages/` imports
- classifier identity: tests import from neutral module and assert archive/visual/auto-format/docs cases
- optional: harness-round consumers call the shared entry (spy/seam)

### 7. Salvage engine stays put

`salvage-harness-work.ts` remains the salvage implementation. The shared round *calls* it; it does not absorb or rewrite it. Marker constant sharing with pre-merge (`PIPELINE_INTERNAL_MARKER_FILES` / `REBASE_MARKER_FILE`) is orthogonal and already correct — do not fold markers into `pipeline-commits` unless needed to avoid new cycles (prefer leave markers with salvage).

## Risks / Trade-offs

- **[Risk] Over-abstracted helper hides stage-specific edge cases (external-commit advance, crash-retry, noop-clean).** → Mitigation: options bag + stage-owned callbacks; migrate one consumer at a time; keep stage tests as parity oracles; do not delete stage-specific branches into “generic” flags without a parity test.
- **[Risk] Re-export compatibility reintroduces shipcheck→pre_merge.** → Mitigation: explicit forbid test on shipcheck imports; prefer direct neutral imports everywhere.
- **[Risk] Spec alignment on auto-format looks like a behavior change in review.** → Mitigation: cite #228 tests; delta clearly labels it living-spec correction, not runtime change.
- **[Risk] #787 exemption silently drifts into a second full skeleton.** → Mitigation: exemption text + test that substantive path uses shared auto-fix/round; shell-only code remains reconciliation.
- **[Risk] Large multi-file PR invites surgical-fix noise.** → Mitigation: classifier extraction and round extraction can land as ordered tasks in one change but with clear task checklist; no unrelated cleanup.

## Migration Plan

1. Land OpenSpec artifacts (this change) and validate.
2. Implement classifier extraction + import rewires + boundary tests → green `npm test` subset.
3. Implement harness-round + migrate consumers + parity tests.
4. #787 disposition + tests.
5. `node scripts/build.mjs`, `openspec validate --all`, `npm run ci`.
6. Rollback: revert the PR; no data migration; behavior is intended identical.

## Open Questions

- Exact export name of the round helper (`runHarnessRound` vs stage-specific wrappers) — implementer choice if tests and call sites stay clear.
- Whether pre_merge temporarily re-exports `isPipelineInternalCommit` for external test imports — allowed only if shipcheck does not use that path.
- Whether test-fix (`testgate.ts`) is in the mandatory consumer set: issue text lists fix/planning/visual/eval/pre-merge; test-fix already uses salvage and should prefer the shared skeleton when it fits without changing test-gate semantics. Prefer include if mechanical; if not, document as follow-up without blocking #629.
