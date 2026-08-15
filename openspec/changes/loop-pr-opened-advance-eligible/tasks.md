## 1. Pure advance-still-needed classification

- [ ] 1.1 Add a pure helper (or expand the existing mid-flight/heal predicate) that defines advance-still-needed for an open-PR identity: open PR, not `ready_label_present`, not merged, stage not `needs-human` (includes intake-ready `ready` and mid-flight)
- [ ] 1.2 Unit-test the helper table: stage `ready`, `fix-2`, `null`, `ready-to-deploy` (via ready_label), `needs-human`, merged — with no I/O
- [ ] 1.3 Confirm `ready_label_present` remains bound only to `pipeline:ready-to-deploy` (intake-ready alone must not set it)

## 2. Reconcile: expand heal and local→pr_opened gate

- [ ] 2.1 Expand stranded `pr_opened` heal in `loop/reconcile.ts` so advance-still-needed open PR restores to `in_progress` (not mid-flight-only), with audited history note
- [ ] 2.2 Preserve precedence: merged and `ready_label_present` catch-up win over heal; do not heal `needs-human`
- [ ] 2.3 Generalize local-state open-PR gate so advance-still-needed local work (`in_progress` / `pending` / `implemented`) is not repair-forwarded to stranded `pr_opened` on open PR alone (prevents heal oscillation for intake-ready)
- [ ] 2.4 Keep mid-flight gate behavior as a subset; existing mid-flight tests stay green
- [ ] 2.5 Idempotence: second reconcile leaves healed item at `in_progress` without re-promoting to `pr_opened`

## 3. Supervisor: re-dispatch + no-progress guard

- [ ] 3.1 Confirm supervisor cycle re-dispatches all `in_progress` items (including healed intake-ready) before selecting new `pending` work
- [ ] 3.2 Add defense-in-depth: do not stop with `supervisor_no_progress` while any non-done item has `next_actions === "advance"`
- [ ] 3.3 Ensure action-evidence / cycle progress does not classify pure stranded-`advance` as legitimate terminal emptiness without restore+dispatch

## 4. Regression tests that bite

- [ ] 4.1 Reconcile: `pr_opened` + stage `ready` + open PR + !R2D + checks success → `in_progress` (fails without heal expansion)
- [ ] 4.2 Reconcile: `in_progress` + stage `ready` + open PR + !R2D does **not** demote to stranded `pr_opened` (oscillation guard)
- [ ] 4.3 Reconcile: mid-flight heal, R2D → `ready`, merged → `merged`, needs-human not healed
- [ ] 4.4 Supervisor execution-trace: intake-ready + `pr_opened` fixture → `dispatchItem` called (`dispatched >= 1`)
- [ ] 4.5 Supervisor: `next_actions: advance` never terminates as `supervisor_no_progress` under consecutive no-progress limit
- [ ] 4.6 All new tests use injected observe/store/supervisor fakes only — no real network, git, or subprocess

## 5. OpenSpec deltas, mirror, CI

- [ ] 5.1 Keep requirement/scenario deltas under `openspec/changes/loop-pr-opened-advance-eligible/specs/` only during implementation; do not hand-edit living `openspec/specs/` until archive
- [ ] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [ ] 5.3 Run targeted tests (`loop-reconcile`, `loop-supervisor`, helper), then `npm run ci` until green
- [ ] 5.4 `openspec validate loop-pr-opened-advance-eligible` (and CI `openspec validate --all`) pass
