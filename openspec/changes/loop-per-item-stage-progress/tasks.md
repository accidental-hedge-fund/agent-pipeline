## 1. Ledger schema and pure stage mapping

- [ ] 1.1 Extend `LoopItemLedgerEntry` (and any ledger schema validators/parsers) with additive optional current-stage projection fields: stage name, optional round, updated-at, optional real `advance_run_id`
- [ ] 1.2 Add pure helpers that map advance run events (`stage_start`, `stage_complete`, `review_verdict`, and terminal outcomes as needed) into material stage-projection deltas; export for unit tests
- [ ] 1.3 Add pure helpers to format an audit stage-table row and a one-line follow/progress event from a projection or structured loop event
- [ ] 1.4 Ensure older ledgers without stage fields still load; status treats missing projection as absent (no schema hard-fail)

## 2. Supervisor observation during dispatch wait

- [ ] 2.1 After advance-run linkage is confirmed, observe the linked advance `events.jsonl` (poll or shared follow seam) during the child wait
- [ ] 2.2 On material stage/round change, atomically update the item's ledger projection and set/mirror the real advance run id from linkage
- [ ] 2.3 Append a structured `loop_item_stage_progress` (or equivalent stable kind) event on the loop run trail with `item_id`, stage, optional round, advance run id when known, and timestamp
- [ ] 2.4 Keep whole-item hand-off: no GitHub stage-label writes, no per-stage verbs, no merge from this path
- [ ] 2.5 On terminal dispatch outcome, reconcile stage presentation with existing coarse terminal `state` mapping without inventing a live advance path when none exists

## 3. Status and audit stage table

- [ ] 3.1 Extend `getStatus` / status projection to expose per-item current-stage fields when present
- [ ] 3.2 Extend `auditSupervisor` (or audit report shape) to include a per-item stage-progress section
- [ ] 3.3 Render the stage table in the `pipeline loop --audit` CLI output: item id, stage (or queued/pending), advance run-id when known
- [ ] 3.4 Prefer the real advance run-store id from linkage on audit/follow surfaces; never present synthetic-only ids as the sole drill-down when a real id is known

## 4. Follow observation path

- [ ] 4.1 Accept a documented read-only stage-progress follow combination (recommended: `--audit --follow`) in loop arg normalization / preflight allowlist
- [ ] 4.2 Implement follow to stream clean one-line stage transitions from durable loop events (and optional initial table), not per-item harness `terminal.log`
- [ ] 4.3 Classify the follow path as read-only: no store lock, no ledger write, no GitHub mutation, no `pipeline-starting-*.lock`
- [ ] 4.4 Keep mutating `--resume` semantics unambiguous and documented relative to the observation follow path

## 5. Tests

- [ ] 5.1 Unit tests for pure mapping: stage_start / review_verdict / non-material duplicates / unconfirmed store
- [ ] 5.2 Unit tests for ledger+event write path with injected store and fake advance-event reader (no real child process)
- [ ] 5.3 Unit tests for audit renderer: includes stage + advance run-id; queued items omit fabricated live ids
- [ ] 5.4 Unit tests for follow/format helpers and read-only classification of the follow argv combination
- [ ] 5.5 Regression that fails against today's audit surface when only coarse `in_progress` is present without per-item stage

## 6. Mirror, validation, and CI

- [ ] 6.1 Run `node scripts/build.mjs` if any `core/` files changed and commit regenerated `plugin/` in the same change
- [ ] 6.2 Run `openspec validate loop-per-item-stage-progress` and fix structural issues
- [ ] 6.3 Run `npm run ci` from repo root until green
