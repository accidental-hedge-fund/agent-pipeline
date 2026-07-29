## 1. Contract and pure helpers

- [x] 1.1 Extend `LoopEvidencePointer` in `core/scripts/loop-execution-contract.ts` with an optional absolute events path field; document that `pipeline_run_id` is the real advance run-store basename when a store exists
- [x] 1.2 Add pure helpers (exported for unit tests) to: compute a pinned advance run id + absolute `events.jsonl` path for a repo root + issue + timestamp; build start-linkage and terminal-linkage event payloads; map a known pin into a truthful evidence pointer
- [x] 1.3 Extend `dispatchItemChildArgs` to accept and pass an optional pinned `--run-id` (whole-item hand-off only; still no `--once`)

## 2. Real dispatch seam

- [x] 2.1 Update `realDispatchItem` to pin the advance run id before spawn, pass `--run-id` on the child argv, and return `evidence.pipeline_run_id` equal to that real id (not synthetic-only when the store is known)
- [x] 2.2 Include the absolute `events` path on the evidence pointer when known; never advertise a non-existent path as live proof when init never happened
- [x] 2.3 Introduce an injectable deps seam for spawn/now/path helpers and an optional start-linkage callback so unit tests never spawn a real process

## 3. Supervisor durable linkage events

- [x] 3.1 Record a durable start-linkage event on the loop run when advance run identity is known (before/at child wait), carrying `item_id`, real `pipeline_run_id`, and absolute events path when known
- [x] 3.2 Record a durable terminal-linkage event after dispatch returns, carrying the same ids plus the terminal outcome
- [x] 3.3 Ensure writes go through the existing loop store `appendEvent` injectable seam; do not create a second ledger/run directory

## 4. Tests

- [x] 4.1 Unit tests for pure helpers: pin → argv includes `--run-id`; evidence pointer uses real store id; synthetic-only path only when no store
- [x] 4.2 Unit tests for dispatch seam with injected fakes: start callback fires with real ids; terminal response evidence is truthful
- [x] 4.3 Supervisor unit tests with fake `dispatchItem` / store: start and end linkage events appear with matching ids and outcome
- [x] 4.4 Prove the regression bites: without the fix, at least one assertion on real `pipeline_run_id` fails against synthetic `pipeline-loop-…` evidence
- [x] 4.5 Regression: spawn then exit before store init omits start linkage and live `events_path`; mid-wait store ready publishes start linkage once confirmed

## 5. Mirror, CI, and validation

- [x] 5.1 Run `node scripts/build.mjs` if any `core/` files changed and commit regenerated `plugin/` in the same change
- [x] 5.2 Run `npm run ci` from repo root and fix failures until green
- [x] 5.3 Run `openspec validate loop-dispatch-advance-run-linkage` (and `openspec validate --all` via CI) to keep the change structurally valid
