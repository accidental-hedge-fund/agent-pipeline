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
- Keep mid-pipeline items dispatchable across supervisor resume (typically stay `in_progress`, or stay `pending` until admitted).
- Preserve true external catch-up to `ready` and `merged`.
- Make `next_actions.advance` non-stranding for this class (no dead-end advertisement without a path).
- Unit-test the regression with injected seams; prove the test bites without the fix.

**Non-Goals:**

- Preventing host/process death or adding supervisor HA.
- Auto-merge or any path past `pipeline:ready-to-deploy`.
- Changing review policy, fix harness, or stage machine labels.
- Building a general multi-action scheduler for every `LoopNextAction` value (only what is needed so mid-flight resume works).
- Cross-host lock recovery (host-local locks remain as today).

## Decisions

### Decision 1 — Prefer gate repair-forward (shape A), not a full `advance` dispatcher (shape B)

**Choice:** Gate local-state → `pr_opened` repair using live `pipeline_stage` mid-flight detection. Leave the item in its local dispatchable state so existing supervisor paths re-drive it.

**Why not B alone:** Implementing a consumer for `next_actions.advance` on `pr_opened` would re-enter advance, but it would also keep encoding "mid-pipeline work" as the remote-proving coarse state `pr_opened`, which is a poor model: happy-path supervisor transitions go `pending` → `in_progress` → `ready` (on `ready_to_deploy`), not through `pr_opened`. Shape A aligns resume with the happy path.

**Why not both as primary:** A secondary heal for already-stranded ledger rows is optional (Decision 4); the primary bug is over-repair.

### Decision 2 — Define mid-flight pipeline stages as "active advance work, not terminal catch-up"

**Mid-flight stages** (examples; implementation may share a pure helper with or adjacent to `loop/precondition.ts`):

- Planning arc: `planning`, `plan-review` (and any plan-revision variants if labeled)
- Implementation and review/fix: `implementing`, `review-1`, `fix-1`, `review-2`, `fix-2`
- Pre-merge / gates: `pre-merge`, `eval-gate`, `shipcheck-gate`
- Any other non-terminal advance-loop stage that is neither pre-pipeline (`backlog` / null) nor terminal ready (`ready-to-deploy`)

**Not mid-flight for this gate:**

- `null` / `backlog` — pre-pipeline (precondition handles admission)
- `ready` — precondition satisfied; open PR alone may still be rare here
- `ready-to-deploy` — terminal for the loop's done definition; maps to ledger `ready` when `ready_label_present`

**Rule for local ledger states** (`pending`, `in_progress`, `implemented`, `blocked`, `abandoned`, `paused`, `waiting`, and any other non-`REMOTE_PROVING` state):

| Verified identity | Drift / repair |
| --- | --- |
| PR `merged` | `ledger-behind` → repair to `merged` (unchanged) |
| Open PR + `ready_label_present` | `ledger-behind` → repair to `ready` (unchanged) |
| Open PR + mid-flight `pipeline_stage` | **no** `ledger-behind` for open-PR alone; leave local state; no repair to `pr_opened` |
| Open PR + non-mid-flight stage (e.g. null/`ready`) | Prefer **also not** repairing to `pr_opened` if that would strand; only repair to `ready`/`merged`. This tightens #511: open PR alone is not a remote-proving catch-up target from local states because `pr_opened` has no dispatch consumer. |

**Clarification vs #511 test:** Today's test asserts `implemented` + open PR ⇒ `ledger-behind`. Under this design that becomes false when the intent is mid-pipeline continuity. Replace with: mid-flight open PR ⇒ no premature `pr_opened` repair; merged/ready still repair. Document in the regression that #511's crash-after-PR-open is recovered by **re-dispatching the local state**, not by parking at `pr_opened`.

### Decision 3 — `computeNextAction` for residual `pr_opened`

**Primary path:** After Decision 2, mid-flight items should not enter `pr_opened` via reconcile.

**Residual / historical ledgers:** If an item is already `pr_opened` and identity shows mid-flight `pipeline_stage` and the PR is still open:

- Prefer a **heal** (Decision 4) back to a dispatchable state, **or**
- If heal is deferred, do **not** advertise non-consuming `advance` as if work will continue — prefer `noop` only if a heal is impossible; better to heal.

Do not expand the closed `LoopNextAction` set unless a new action is strictly required; prefer reusing dispatch via local state.

### Decision 4 — Optional heal: `pr_opened` + mid-flight → `in_progress` (audited)

**Choice:** Implement a narrow, audited ledger transition (or reconcile-side repair that is **not** the forward remote-proving catch-up) when:

- ledger state is `pr_opened`
- identity has open PR
- `pipeline_stage` is mid-flight
- checks are not a contradiction class that already routes to human

**Target state:** `in_progress` (supervisor already re-dispatches all `in_progress` items at the start of a cycle before selecting new pending work).

**Rationale:** Heals runs that already applied the buggy repair (e.g. #574 ledger already at `pr_opened`) without requiring a human `/pipeline N`. History note must make the heal explicit (e.g. "reconciliation restored mid-flight item to in_progress for re-dispatch").

**Alternative rejected:** full `advance` next-action consumer — larger surface, duplicates `in_progress` dispatch.

If implementation cost of heal is high, AC still pass with Decision 2 alone for **future** crashes; document residual heal as a follow-up only if tests prove Decision 2 alone meets resume AC for the in_progress crash path. Prefer including the heal in the same change when small.

### Decision 5 — Supervisor behavior stays "re-drive `in_progress`", no schedule-frontier change for `pr_opened`

Do **not** admit `pr_opened` into the pending frontier. Keep the invariant: scheduler selects `pending`; supervisor re-dispatches existing `in_progress`. The fix makes mid-flight items stay (or return to) that model.

After resume: reconcile (gate + optional heal) → cycle sees `in_progress` → re-dispatch via `pipeline/loop-execution@1` → advance continues from live labels (existing per-item resume behavior).

### Decision 6 — Pure helpers and test seams

- Extract pure `isMidFlightPipelineStage(stage: string | null): boolean` (or equivalent) next to precondition helpers so classification stays unit-testable without I/O.
- Keep `classifyDrift` / `verifiedForwardTarget` pure; pass full identity including `pipeline_stage`.
- Tests inject `ReconcileObserveDeps` + `LoopStoreDeps` fakes only (existing pattern in `loop-reconcile.test.ts`).

## Risks / Trade-offs

- **[Risk] #511 open-PR catch-up to `pr_opened` is intentionally narrowed** → Mitigation: recover via re-dispatch of local state; preserve `ready`/`merged` catch-up; update tests so the old assertion is replaced by an explicit mid-flight continuity test.
- **[Risk] Incomplete mid-flight stage set misses a label** → Mitigation: define mid-flight as "any stage that is not pre-pipeline and not ready-to-deploy" (positive list of terminals/exceptions) rather than a fragile allow-list of only known mid stages, if that is simpler and safer; document the closed set in code + tests.
- **[Risk] Heal from `pr_opened` → `in_progress` could re-dispatch a truly finished PR-only row** → Mitigation: require mid-flight `pipeline_stage`; if stage is `ready-to-deploy`, use ready/merged paths instead.
- **[Risk] `next_actions.advance` remains dead for non-mid-flight `pr_opened`** → Mitigation: out of scope unless we still emit that combination; Decision 2 avoids creating new stranded rows; optional follow-up to noop or implement advance for pure PR-open crash with null stage.
- **[Risk] Parallel item selection** → Mitigation: unchanged concurrency rules; only which state the crashed item occupies changes.

## Migration Plan

1. Ship gate + tests; regenerate plugin mirror if `core/` changes.
2. In-flight loop runs: on next reconcile/resume, mid-flight local items stop demoting; with heal, already-`pr_opened` mid-flight items return to `in_progress` and continue.
3. Rollback: revert the change; prior over-repair behavior returns (no data migration).

## Open Questions

- _(Resolved in Decision 2)_ Treat `pending` + mid-flight + open PR the same as `in_progress` for the gate — yes (#601).
- _(Resolved in Decision 1/4)_ Shape A primary; optional heal for stranded `pr_opened`.
- Exact mid-flight membership: implementers SHOULD prefer "not pre-pipeline and not ready-to-deploy" (or an explicit shared set) and lock it with tests; no further product decision required before coding.
