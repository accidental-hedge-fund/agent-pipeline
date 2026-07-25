# Tasks

## Acceptance criteria

- [ ] A dispatched item observed on live truth carrying `pipeline:blocked` — including when
      co-present with a `pipeline:*` stage label, and including a stale/reason-less blocker —
      that makes 0 stage transitions and neither crashes nor rejects is recorded as a
      per-item needs-human hold: NEVER `workflow-engine-defect`, NEVER a `run_fatal` (or
      `human_authority`) run stop.
- [ ] Detection uses the label's presence in the item's live label set, not whether
      `pipelineStageFromLabels` returns `blocked` as the single stage-winner.
- [ ] A per-item hold does NOT by itself terminate the run: while any other item can make
      progress, the run continues dispatching the remaining schedulable items, and the held
      item is re-evaluated (held vs. cleared) each cycle.
- [ ] The run reaches its terminal outstanding-hold condition only when no non-done item can
      make progress; that terminal report enumerates every held item id in the durable record
      and the `pipeline loop` CLI output.
- [ ] A genuine engine defect (rejected/crashed dispatch, or unrecognized terminal outcome
      with the item at no `pipeline:blocked` state) is still `workflow-engine-defect` /
      `run_fatal`.
- [ ] Regression test: one already-`pipeline:blocked` item + N clean items → the N clean
      items dispatch and the blocked one holds; no `run_fatal`. The test bites on the pre-fix
      classification and on the pre-fix whole-run pause after the first hold.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke,
      `openspec validate --all`).

## Implementation

1. [ ] Add a presence predicate for the `pipeline:blocked` disposition in
       `core/scripts/loop/precondition.ts` — e.g. `isBlockedInLabels(labels)` returning
       `labels.includes(\`${LABEL_PREFIX}blocked\`)` — distinct from the single-winner
       `pipelineStageFromLabels`. Do not change `pipelineStageFromLabels`.
2. [ ] In supervisor Pass 2 (`core/scripts/loop/supervisor.ts`), replace the needs-human
       safety net's `observedStage === "blocked"` guard with the presence predicate over the
       observed live labels, retaining the existing zero-transition and no-crash/reject
       guards. Keep the ordering: crash/reject → defect; precondition no-op → exclusion;
       `pipeline:blocked` present → needs-human hold; otherwise → `workflow-engine-defect`.
3. [ ] Change the cycle-start `held` short-circuit in `runSupervisorCycle` so a held
       (`paused`/`waiting`) item is excluded from the executable frontier — mirroring the
       precondition exclusion — instead of halting the whole run. The run continues selecting
       and dispatching the remaining schedulable items each cycle.
4. [ ] Record the terminal outstanding-hold condition (pause, `hold_outstanding=true`) only
       when no non-done item can make progress — every remaining item held or blocked and no
       schedulable item remains — and enumerate every held item id on that terminal report.
5. [ ] Surface the held item ids in the `pipeline loop` result JSON emitted by
       `core/scripts/pipeline.ts` (and the supervisor's action-evidence / `--audit` output)
       so the disclosure is both machine-readable and visible to an operator.
6. [ ] Tests (co-located `*.test.ts`, dependency-seam fakes, no real network/git/subprocess):
       - [ ] Regression: one item carrying `pipeline:blocked` co-present with a stage label
             (0 transitions) + N clean items — the blocked item holds, the N clean items
             dispatch to their outcomes, and no `run_fatal` / `workflow-engine-defect` stop is
             recorded.
       - [ ] Presence detection: a `pipeline:blocked` label co-present with a `pipeline:*`
             stage label routes to the needs-human hold (fails under the pre-fix
             stage-winner guard).
       - [ ] Continuation: a held item alongside a schedulable sibling does not pause the
             run; the sibling is dispatched (fails under the pre-fix `held` short-circuit).
       - [ ] Terminal hold: when every remaining item is held/blocked, the run reaches its
             terminal outstanding-hold condition enumerating every held item id, and the CLI
             output names them.
       - [ ] A genuine defect (rejected/crashed dispatch; unrecognized outcome at no
             `pipeline:blocked` state) still maps to `workflow-engine-defect` / `run_fatal`.
7. [ ] Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the
       same change.
8. [ ] Run `npm run ci` from repo root; treat red as not-done.
