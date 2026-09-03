## Why

#1277 shipped a train-level event stream, but three evidence-integrity defects remain. A host cannot follow a live child loop, two same-clock trains can share one run directory, and an already-contained item omits `train_merge_proven`. Unique-operation FRG (#1368) already consumes these proofs. They must land as shared train-event law, not as a later mole.

## What Changes

- Publish `train_loop_linked` from the child loop's typed `onRunReady` handoff after the loop store and exact events path exist, and before that child can block on work. A later wave result MAY confirm the same identity. It SHALL NOT duplicate the event or replace it with a guessed run.
- Allocate each train run ID with exclusive directory publication and a bounded collision suffix, through injected I/O and clock/ID seams. Two starts that share one clock instant SHALL receive distinct run IDs and isolated event sequences.
- When allocation is exhausted, report typed degraded or unknown train-event coverage, create no shared run store, and continue the same advance and merge mutations. Identity allocation remains observational.
- Emit `train_merge_proven` whenever base containment is proven, including already-contained reconciliation. Distinguish `newly-merged` from `already-contained` with an additive `proof_disposition` field. Both paths still emit `train_merge_integrated`.
- Keep `train --json` stdout as one final `train_status` object. Keep the existing early `train_run_handoff` on stderr.

**BREAKING:** none for train scheduling, recovery, merge order, merge authority, exit codes, or the `--json` stdout object kind.

## Capabilities

### New Capabilities

- None. This change tightens existing train-event evidence. It does not add a collector, store layout, or CLI verb.

### Modified Capabilities

- `train-event-stream`: live `train_loop_linked` from child `onRunReady`; exclusive collision-safe train run identity with observational allocation failure; complete merge proof including already-contained items and `proof_disposition`.
- `integrated-train-mode`: additive `events_coverage` on the existing one-object `train_status` when train-event identity cannot be published exclusively. `schema_version` stays `1`. Advance, merge, and park law do not change.

## Impact

- **Train events:** `core/scripts/train-events.ts` allocates the run directory exclusively, retries with a suffix on collision, and reports coverage without appending to a shared store.
- **Train command:** `core/scripts/stages/train.ts` emits live linkage through the existing wave `onRunReady` / `onLoopReady` seam, suppresses duplicate handoffs, and emits `train_merge_proven` for both newly merged and already-contained proofs.
- **Wave wiring:** `advanceWaveThroughLoop` already captures `onRunReady`. Train SHALL append `train_loop_linked` from that callback before `runLoopEngine` returns, not only after `advanceWave()` resolves.
- **Run store:** reuse `RunStoreDeps.mkdir` without `recursive` as the exclusive create. Do not treat a colliding train directory as idempotent re-entry. Do not change advance `initRunDir` resume for issue-prefixed IDs.
- **JSON / stderr:** additive `events_coverage` and optional omitted `run_id` on `train_status` when allocation fails. `train_run_handoff` stays on stderr. No extra stdout JSON objects.
- **Tests:** injected I/O, clock, ID, and wave seams. No live network, git, or subprocess. Bite live linkage timing, duplicate suppression, same-clock collision, allocation exhaustion, newly merged proof, and already-contained proof.
- **Does not:** add an external sink, SQLite, alerts, dashboards, or observer controller. Does not change train work-list order, recovery, merge-first, merge authority, or release behavior.

## Acceptance criteria

- [ ] A blocked or live child loop produces a followable `train_loop_linked` event before that child reaches terminal state.
- [ ] That link contains the exact child loop run ID and absolute events path from `onRunReady`. No stdout scraping, latest-run lookup, or synthetic identity is used.
- [ ] Two trains started with the same injected timestamp receive distinct run IDs and isolated event sequences.
- [ ] Exhausted identity allocation reports degraded or unknown train-event coverage, creates no shared run store, and does not change which issues advance or merge.
- [ ] Newly merged and already-contained items both emit `train_merge_proven`. Their typed `proof_disposition` differs. Both still emit `train_merge_integrated`.
- [ ] Tests cover live linkage timing, duplicate handoff suppression, same-clock collision, allocation failure, new merge, and already-contained merge proof using injected dependencies.
- [ ] No train lifecycle, retry, or merge-authority behavior changes.
- [ ] `train --json` stdout remains exactly one `train_status` object. Early `train_run_handoff` remains on stderr.
- [ ] After `core/` edits, `node scripts/build.mjs` runs. `npm run ci` passes.
