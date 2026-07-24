# Tasks

## Acceptance criteria

- [ ] A milestone/work-list selector run over items that include a `pipeline:backlog` item
      does not durably stop: the backlog item is excluded from the executable frontier with
      a durable, non-fatal `precondition` rationale naming the required stage
      (`pipeline:ready`) and its observed stage, and every `pipeline:ready` item is advanced.
- [ ] A 0-transition advance on a pre-pipeline item (still `pipeline:backlog` / no
      `pipeline:*` label) is never mapped to `failed` and never classified
      `workflow-engine-defect` / `run_fatal`; it is recorded as the same non-fatal
      `precondition` exclusion.
- [ ] A genuine engine defect (rejected/crashed dispatch, or an unrecognized terminal
      outcome at no recognizable stage) is still classified `workflow-engine-defect` with
      its `run_fatal` policy intact.
- [ ] The pre-pipeline gate is evaluated against live truth each reconciliation pass: an
      item triaged `backlog → ready` mid-run is admitted on a later cycle with no recompile
      or restart.
- [ ] `pipeline loop --new-run` starts a fresh, deterministic, re-resumable run for the same
      selector when the canonical run is terminally stopped, recording `supersedes` /
      `superseded_by` pointers and leaving the retired run directory intact — no operator
      hand-move of durable state.
- [ ] `pipeline loop --new-run` is refused (non-zero, no durable write) when the canonical
      run is not terminally stopped.
- [ ] Regression test: a milestone selector over one `pipeline:backlog` item + one
      `pipeline:ready` item advances the ready item, records the backlog exclusion, and the
      run does not stop. The test bites (fails on the pre-fix classification of the backlog
      no-op as `workflow-engine-defect` / `run_fatal`).
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke,
      `openspec validate --all`).

## Implementation

1. [ ] Add a live pipeline-stage observation to the reconciliation pass (or reuse an
       existing observed field) so frontier selection can read each eligible item's current
       `pipeline:*` stage. Inject via the existing observe/reconcile seam — no real gh in
       unit tests.
2. [ ] In frontier selection (`core/scripts/loop/schedule.ts` / `supervisor.ts`), exclude
       any eligible item at a pre-pipeline stage (`pipeline:backlog` or no `pipeline:*`
       label) from the dispatched set, and record a non-fatal `precondition` exclusion
       rationale (item id, required stage, observed stage) durably. Ensure it consumes no
       recovery budget and records no run stop.
3. [ ] Add the `precondition` frontier-exclusion rationale record to `loop/types.ts` /
       `loop/store.ts` and surface it in action-evidence / audit output.
4. [ ] Harden `realDispatchItem` (`core/scripts/pipeline.ts`): when the advance loop leaves
       an item at a pre-pipeline stage with zero transitions, record it as the non-fatal
       `precondition` exclusion instead of `failed`; keep the `failed` →
       `workflow-engine-defect` path only for rejected/crashed dispatch and unrecognized
       terminal outcomes.
5. [ ] Add the `--new-run` option to the `loop` command surface in `pipeline.ts`; wire
       `defaultRunLoopEngine` to mint a deterministic superseding run id, refuse unless the
       canonical run is terminally stopped, initialize the fresh run, and record the
       `supersedes` / `superseded_by` pointers.
6. [ ] Add `supersedes` / `superseded_by` fields to the run/ledger record in `loop/types.ts`
       and persist/read them through `loop/store.ts`; surface the chain in `--audit`.
7. [ ] Tests (co-located `*.test.ts`, dependency-seam fakes, no real network/git/subprocess):
       - [ ] Regression: milestone selector over one backlog + one ready item — ready
             advances, backlog excluded with `precondition` rationale, run does not stop.
       - [ ] `realDispatchItem` maps a zero-transition backlog outcome to `precondition`, not
             `failed` / `workflow-engine-defect`.
       - [ ] A genuine defect still maps to `workflow-engine-defect` / `run_fatal`.
       - [ ] Mid-run `backlog → ready` triage admits the item on the next cycle.
       - [ ] `--new-run` on a terminally-stopped run creates a fresh linked run; `--new-run`
             on a non-stopped run is refused with no durable write.
8. [ ] Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the
       same change.
9. [ ] Run `npm run ci` from repo root; treat red as not-done.
