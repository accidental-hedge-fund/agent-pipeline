## 1. Pure advance-still-needed classification

- [x] 1.1 Add a pure helper (or expand the existing mid-flight/heal predicate) that defines advance-still-needed for an open-PR identity: open PR, not `ready_label_present`, not merged, stage not `needs-human` (includes intake-ready `ready` and mid-flight)
- [x] 1.2 Unit-test the helper table: stage `ready`, `fix-2`, `null`, `ready-to-deploy` (via ready_label), `needs-human`, merged — with no I/O
- [x] 1.3 Confirm `ready_label_present` remains bound only to `pipeline:ready-to-deploy` (intake-ready alone must not set it)

## 2. Reconcile: expand heal and local→pr_opened gate

- [x] 2.1 Expand stranded `pr_opened` heal in `loop/reconcile.ts` so advance-still-needed open PR restores to `in_progress` (not mid-flight-only), with audited history note
- [x] 2.2 Preserve precedence: merged and `ready_label_present` catch-up win over heal; do not heal `needs-human`
- [x] 2.3 Generalize local-state open-PR gate so advance-still-needed local work (`in_progress` / `pending` / `implemented`) is not repair-forwarded to stranded `pr_opened` on open PR alone (prevents heal oscillation for intake-ready)
- [x] 2.4 Keep mid-flight gate behavior as a subset; existing mid-flight tests stay green
- [x] 2.5 Idempotence: second reconcile leaves healed item at `in_progress` without re-promoting to `pr_opened`
- [x] 2.6 Restore non-dispatchable advance-still-needed `implemented` to `in_progress` in the same heal path (crash-after-PR-open residual; review-1 #1068)

## 3. Supervisor: re-dispatch + no-progress guard

- [x] 3.1 Confirm supervisor cycle re-dispatches all `in_progress` items (including healed intake-ready) before selecting new `pending` work
- [x] 3.2 Add defense-in-depth: do not stop with `supervisor_no_progress` while any non-done item has `next_actions === "advance"`
- [x] 3.3 Ensure action-evidence / cycle progress does not classify pure stranded-`advance` as legitimate terminal emptiness without restore+dispatch

## 4. Regression tests that bite

- [x] 4.1 Reconcile: `pr_opened` + stage `ready` + open PR + !R2D + checks success → `in_progress` (fails without heal expansion)
- [x] 4.2 Reconcile: `in_progress` + stage `ready` + open PR + !R2D does **not** demote to stranded `pr_opened` (oscillation guard)
- [x] 4.3 Reconcile: mid-flight heal, R2D → `ready`, merged → `merged`, needs-human not healed
- [x] 4.4 Supervisor execution-trace: intake-ready + `pr_opened` fixture → `dispatchItem` called (`dispatched >= 1`)
- [x] 4.5 Supervisor: `next_actions: advance` never terminates as `supervisor_no_progress` under consecutive no-progress limit
- [x] 4.6 All new tests use injected observe/store/supervisor fakes only — no real network, git, or subprocess
- [x] 4.7 Supervisor execution-trace: `implemented` + open non-R2D PR → heal to `in_progress` and `dispatchItem` called (`dispatched >= 1`)

## 5. OpenSpec deltas, mirror, CI

- [x] 5.1 Keep requirement/scenario deltas under `openspec/changes/loop-pr-opened-advance-eligible/specs/` only during implementation; do not hand-edit living `openspec/specs/` until archive
- [x] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [x] 5.3 Run targeted tests (`loop-reconcile`, `loop-supervisor`, helper), then `npm run ci` until green
- [x] 5.4 `openspec validate loop-pr-opened-advance-eligible` (and CI `openspec validate --all`) pass
