## 1. Live-advance probe seam

- [ ] 1.1 Add an injectable host-local `probeLiveAdvance(issueId)` (or equivalent) seam used by the supervisor — returns not-live or live with evidence class (`lock_held` | `active_run_store` | `wrapper_pid` / linkage), optional `pipeline_run_id`, holder pid, events path
- [ ] 1.2 Wire production probe to existing per-issue lock liveness, non-terminal run-store detection, and non-terminal loop advance linkage; do not invent live paths when evidence is absent
- [ ] 1.3 Unit-test the pure/injected probe classifier (live vs not-live, dead-PID / terminal store = not live) with no real network, git, or subprocess

## 2. Hold-clear re-admit gate

- [ ] 2.1 Update `reopenClearedBlockedHolds` (or successor) so `pipeline:blocked` absence re-admits to the executable frontier only when the live-advance probe reports not live and no non-terminal loop linkage exists
- [ ] 2.2 When label is cleared but advance is still live, keep the item excluded from full re-dispatch and append a durable deferred/coexistence record distinct from unconditional `loop_item_hold_cleared`
- [ ] 2.3 Unit test: waiting → blocked cleared → live advance still running → no second full dispatch / no `run_fatal`

## 3. Pre-dispatch coexistence check

- [ ] 3.1 Before `pipeline/loop-execution@1` full dispatch, consult the live-advance probe (and existing linkage); on live evidence, attach/skip/wait instead of spawning a second advance
- [ ] 3.2 Ensure attach/wait records durable coexistence markers and counts as progress when new evidence is recorded (compose with no-progress watchdog)
- [ ] 3.3 Unit test: selected item with live lock/run-store does not call a second full dispatch

## 4. Pass-2 failed-outcome safety net

- [ ] 4.1 In supervisor failed-outcome handling, detect lock-held / already-running / install-in-progress evidence before default `workflow-engine-defect`
- [ ] 4.2 Map that evidence to non-fatal coexistence wait/hold/skip; never `run_fatal` solely for it
- [ ] 4.3 Preserve ordering relative to existing nets: crash without evidence → defect; precondition no-op → exclusion; `pipeline:blocked` present → needs-human hold; coexistence evidence → non-fatal; else → defect
- [ ] 4.4 Unit test: failed + lock/already-running evidence → not `workflow-engine-defect` / not `run_fatal`; multi-item siblings continue
- [ ] 4.5 Regression: genuine crash/reject with no coexistence and no blocked label still `workflow-engine-defect` / `run_fatal`

## 5. Durable events and mirror

- [ ] 5.1 Ensure event trail / action-evidence distinguishes `already_running` / `lock_held` (or equivalent) from engine defects; include `item_id` and optional run id / holder
- [ ] 5.2 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [ ] 5.3 Run `npm run ci` from repo root; treat red as not-done
