## Context

Durable-run reconciliation (#511 / capability `durable-run-reconciliation`) observes live GitHub truth into `LoopExternalIdentity` and repair-forwards only `ledger-behind` drift. For **local** ledger states (`pending`, `in_progress`, `implemented`, …), any open PR currently classifies as `ledger-behind` and repairs to `pr_opened` (or `ready` if the ready-to-deploy label is present, or `merged` if the PR is merged). That catch-up was added so a worker that crashed after opening a PR still advanced the ledger (#511 review finding).

That over-applies mid-pipeline. Live runs keep the item `in_progress` while advance walks `review-*` / `fix-*` / `pre-merge` / … with an open PR the entire time. On crash mid-flight, resume runs reconcile first; the item is demoted to `pr_opened`. The supervisor cycle then:

1. Re-dispatches only items still `in_progress` (none for that item after demotion).
2. Schedules only the `pending` frontier (siblings).
3. Computes `next_actions[item] = "advance"` for `pr_opened` + green checks — but **no consumer** of `advance` exists in `supervisor.ts` / `schedule.ts` / `recovery.ts`.

Result: permanent strand until a human runs `/pipeline N` outside the loop. Evidence: #574 on run `loop-4d2de11c6c029a2f-s1`; same class earlier for #601.

`pipeline_stage` is already on `LoopExternalIdentity` (feeds the precondition stage gate #568) but is **not** consulted by `verifiedForwardTarget` / `classifyDrift`.

## Goals / Non-Goals

**Goals:**

- Stop demoting mid-flight local-state items to stranded `pr_opened` on open-PR alone.
- Heal already-stranded `pr_opened` + mid-flight ledger rows back to dispatchable `in_progress` (idempotent, audited).
- Keep mid-pipeline items dispatchable across supervisor resume (stay or restore `in_progress`, or stay `pending` until admitted).
- Preserve true external catch-up to `ready` and `merged`, and preserve #511 crash-after-PR-open catch-up when stage is **not** mid-flight.
- Make mid-flight continuity independent of non-consuming `next_actions.advance`.
- Unit-test reconcile + supervisor paths with injected seams; prove regressions bite without the fix.

**Non-Goals:**

- Preventing host/process death or adding supervisor HA.
- Auto-merge or any path past `pipeline:ready-to-deploy`.
- Changing review policy, fix harness, or stage machine labels.
- Building a general multi-action scheduler for every `LoopNextAction` value (including a full `advance` dispatcher).
- Cross-host lock recovery (host-local locks remain as today).
- Editing living `openspec/specs/*` during implementation — only delta specs under this change.

## Decisions

### Decision 1 — Gate repair-forward (shape A) + required legacy heal; no `advance` dispatcher (shape B)

**Choice:** Primary fix is gate local-state → `pr_opened` repair using live `pipeline_stage` mid-flight detection. Leave (or restore) the item in a local dispatchable state so existing supervisor paths re-drive it.

**Legacy heal is in-scope and required (not optional):** ledger rows already stranded at `pr_opened` by pre-fix reconcile (#601 / #574 class) SHALL be restored to `in_progress` when identity still shows open PR + mid-flight stage, then re-dispatched by the normal supervisor path.

**Why not B alone:** Implementing a consumer for `next_actions.advance` on `pr_opened` would re-enter advance but would keep encoding mid-pipeline work as coarse remote-proving `pr_opened`. Happy-path supervisor transitions go `pending` → `in_progress` → (terminal) `ready` on `ready_to_deploy`, not through `pr_opened`. Shape A + heal aligns resume with the happy path.

### Decision 2 — Mid-flight predicate from authoritative `STAGES` vocabulary

**Source of truth:** `STAGES` in `core/scripts/types.ts` (the pipeline state machine). Export a pure helper (e.g. `isMidFlightPipelineStage(stage: string | null): boolean`) colocated with `loop/precondition.ts` so reconcile and tests share one definition with the precondition helpers.

**Mid-flight stages** (active advance-loop work; open PR is expected and does **not** prove terminal catch-up):

| Stage suffix | Notes |
| --- | --- |
| `planning`, `plan-review` | Planning arc |
| `implementing`, `design-gate` | Implementation / design |
| `review-1`, `fix-1`, `review-2`, `fix-2` | Review/fix rounds |
| `pre-merge`, `visual-gate`, `eval-gate`, `shipcheck-gate` | Pre-merge / gates |

**Not mid-flight:**

| Stage | Handling |
| --- | --- |
| `null` (missing / no `pipeline:*` label) | **Not** mid-flight → preserve #511 open-PR → `pr_opened` catch-up from local states |
| `backlog` | Pre-pipeline; precondition gate owns admission; not mid-flight |
| `ready` | Precondition satisfied only; not mid-flight → open PR may still #511-repair to `pr_opened` |
| `ready-to-deploy` | Loop terminal for done-definition; catch-up via `ready_label_present` → `ready`, never heal to `in_progress` |
| `needs-human` | Terminal off-ramp (`TERMINAL_STAGES`); not mid-flight; do **not** heal `pr_opened` → `in_progress` |
| Unknown non-null string **not** in `STAGES` | Treat as **mid-flight** (defensive against vocabulary growth lag) so we do not strand future stages; unit-test this disposition |

Implement the predicate as membership in the closed mid-flight set derived from `STAGES` (exclude `backlog`, `ready`, `ready-to-deploy`, `needs-human`), plus unknown non-null → mid-flight. Do **not** use vague "etc." prose at call sites.

### Decision 3 — Target precedence (merged / ready win over mid-flight gate and heal)

When computing verified forward target / reconcile mutations, apply **strict precedence**:

1. `pr_state === "merged"` → target `merged` (`ledger-behind` repair). Mid-flight stage is irrelevant.
2. Open PR + `ready_label_present` → target `ready`. Mid-flight stage is irrelevant.
3. Else open PR + mid-flight `pipeline_stage` → **no** local → `pr_opened` repair (`verifiedForwardTarget` returns `null` for open-PR-only from local states in this case; `classifyDrift` does not emit `ledger-behind` for open-PR alone).
4. Else open PR + **not** mid-flight (including `null` / `ready` / `backlog`) → target `pr_opened` (**#511 crash-after-PR-open path preserved**).

Checks conclusion (`success` / `failure` / `pending` / absent) **must not** override the mid-flight gate: green checks must not force `pr_opened` for mid-flight local work.

**Already remote-proving `pr_opened` + mid-flight:** see Decision 4 (heal), not step 3/4 above.

### Decision 4 — Required heal: stranded `pr_opened` + mid-flight → `in_progress`

**When (all must hold):**

- ledger state is `pr_opened`
- identity `pr_state === "open"` and `pr_number !== null`
- `isMidFlightPipelineStage(pipeline_stage)` is true
- not superseded by Decision 3 steps 1–2 (merged / ready label win first)

**Action:** audited ledger transition `pr_opened` → `in_progress` with an explicit history note (e.g. `"reconciliation restored mid-flight item to in_progress for re-dispatch"`) and matching event. Not a remote-proving forward catch-up; a restore to a local dispatchable state.

**Idempotence:**

- After heal, item is `in_progress`; subsequent reconcile passes with the same mid-flight open-PR identity leave state `in_progress` (no oscillation, no duplicate heal history spam beyond one restore per stranding — prefer: only heal when `state === "pr_opened"`, so second pass is a no-op for heal).
- Gate and heal must not fight: mid-flight local stays local; mid-flight `pr_opened` heals once to `in_progress` and stays.

**Out of heal:** `ready-to-deploy` / `needs-human` / non-mid-flight / merged / ready label cases.

**`computeNextAction`:** after heal, state is `in_progress` → next action is not non-consuming `advance` on `pr_opened`. Residual pure `pr_opened` + non-mid-flight + green checks may still emit `advance` (pre-existing dead advertisement for non-mid-flight; out of scope to implement a consumer unless mid-flight path still depends on it — it must not).

### Decision 5 — Supervisor stays "re-drive `in_progress`"; no frontier change for `pr_opened`

Do **not** admit `pr_opened` into the pending frontier. Keep: scheduler selects `pending`; supervisor re-dispatches existing `in_progress` (see `runSupervisorCycle` in `loop/supervisor.ts`: `activeItemIds` from `in_progress` before `selectSchedulableSet`).

Resume path: attach (including dead-holder recovery) → reconcile (gate + heal) → cycle sees `in_progress` → `dispatchItem` / `pipeline/loop-execution@1` → advance continues from **fresh observed labels** (existing per-item advance resume; must not restart the pipeline from scratch).

### Decision 6 — Pure helpers, test seams, and required tests

- Pure `isMidFlightPipelineStage` next to precondition helpers; `classifyDrift` / `verifiedForwardTarget` remain pure and consult `identity.pipeline_stage`.
- Tests inject `ReconcileObserveDeps` + `LoopStoreDeps` fakes only (pattern in `core/test/loop-reconcile.test.ts`).
- Supervisor tests inject `SupervisorDeps.dispatchItem` and assert **call trace** (pattern in `core/test/loop-supervisor.test.ts`), not only final ledger state.
- OpenSpec work stays under `openspec/changes/loop-resume-mid-pipeline-repair-gate/` delta specs; do not edit living `openspec/specs/` until pre-merge archive.

## Risks / Trade-offs

- **[Risk] #511 open-PR → `pr_opened` is narrowed for mid-flight only** → Mitigation: preserve for null/non-mid-flight; recover mid-flight via leave-local + heal; explicit compatibility tests.
- **[Risk] Incomplete mid-flight set** → Mitigation: derive closed set from `STAGES` + unknown-non-null-as-mid-flight; unit-test membership table.
- **[Risk] Heal re-dispatches a finished item** → Mitigation: require mid-flight stage; ready-to-deploy / merged / ready-label take precedence.
- **[Risk] Oscillating heal vs forward repair** → Mitigation: heal only from `pr_opened`; gate never re-promotes mid-flight local to `pr_opened`; idempotence tests on repeated reconcile.
- **[Risk] Checks edge cases bypass gate** → Mitigation: tests for success / failure / pending / absent on mid-flight local open PR.
- **[Risk] Re-dispatch restarts pipeline** → Mitigation: assert path is existing `pipeline/loop-execution@1` with live labels (same as any `in_progress` re-drive); no new "start from ready" transition.

## Migration Plan

1. Implement gate + heal + tests in `core/`; regenerate `plugin/` via `node scripts/build.mjs` in the same commit.
2. In-flight loop runs: next reconcile/resume stops demoting mid-flight locals; heals already-`pr_opened` mid-flight items to `in_progress` and continues.
3. Rollback: revert the change; prior over-repair behavior returns (no data migration).

## Open Questions

- _(Resolved)_ Shape A + required heal; no advance dispatcher.
- _(Resolved)_ Mid-flight set from `STAGES` with explicit null/unknown/terminal handling.
- _(Resolved)_ #511 preserved for non-mid-flight / absent stage.
- _(Resolved)_ OpenSpec deltas only under the active change during implementation.
