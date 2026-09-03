## Context

See `proposal.md` for why. Current law and code:

- `initTrainRunStore` calls `trainRunIdFor(startedAt)` then `initRunDir`. `trainRunIdFor` is only a millisecond timestamp. `initRunDir` uses `mkdir({ recursive: true })` and returns if `run.json` already exists, so two same-clock trains share one directory and one `seq` stream.
- `advanceWaveThroughLoop` already captures child identity in `onRunReady` (after the loop store exists, before dispatch). It assigns `out.loopRun` only after `runLoopEngine` returns. `runTrain` then appends `train_loop_linked`. A blocked child is not followable from the train stream while it is live.
- `emitMergeCatalog` emits `train_merge_proven` only when `!merged.already`. Already-contained reconciliation still emits `train_merge_integrated`. Containment is the proof; the proven event is missing.
- Loop store exclusive publication (`renameDirExclusive` of a staged contract+ledger) is the wrong layer for train. Train needs exclusive *identity*, not atomic multi-document init. Advance `initRunDir` idempotent re-entry MUST stay for issue-prefixed resume.
- Unique-operation FRG already consumes #1301 live linkage, collision-safe physical run ids, and merge proof. This change supplies those proofs. It does not reimplement the FRG gate.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The sites are one late `train_loop_linked`, one shared `train-<timestamp>` directory, and one omitted `train_merge_proven`. The class is: train-level evidence MUST be live, exclusively published, and complete for every proven integration.
2. **Shared surfaces.** Existing child `onRunReady`, `RunStoreDeps.mkdir` without `recursive`, `appendEvent`, `train_merge_proven`, additive `train_status` coverage. Not a train-local collector or a second run-store.
3. **Next identical fault.** The next nested child (ship pack loop, later train wave) follows the same `onRunReady` live-link law. The next same-clock producer uses exclusive mkdir plus suffix. The next already-contained proof emits `train_merge_proven` with disposition. No new mole issue.

## Goals / Non-Goals

**Goals:**

- Emit followable `train_loop_linked` from the child typed `onRunReady` handoff before that child can block.
- Give concurrent same-clock trains distinct exclusive run directories, or no store at all.
- Record merge proof for both newly merged and already-contained items with a typed disposition.
- Keep allocation and event init observational.

**Non-Goals:**

- Changing `initRunDir` resume for advance runs.
- Copying loop `renameDirExclusive` staging into the generic run store.
- A new CLI verb, event sink, SQLite store, or observer controller.
- Changing train work-list order, recovery, merge-first, merge authority, or `--json` stdout object kind.

## Decisions

### 1. Live linkage uses the existing `onRunReady` callback (primary)

**Choice:** Extend the existing `advanceWave` context (`logicalOperationId` today) with an `onLoopReady` callback. Production `advanceWaveThroughLoop` **awaits** it from the current `onRunReady` handler after it has the exact `runId` and absolute `events` path, and before `runLoopEngine` returns. `runTrain` appends `train_loop_linked` there, once per loop run id, and that append SHALL complete before the await returns. That awaited callback is the sole append site. After the wave returns, `waveResult.loopRun` MAY confirm the same identity. Same identity SHALL NOT append a second event. A mismatched later identity SHALL keep the first live link, set `events_coverage` to `degraded`, and SHALL NOT abort the wave. Wave-result `loopRun` SHALL NOT append `train_loop_linked` when `onRunReady` never fired.

**Why:** The supervisor already fires `onRunReady` after exclusive lock and before dispatch (#665). `advanceWaveThroughLoop` already reads that identity. Moving the append to that callback is the first holding rung. A new bus, stdout scrape, or mtime lookup would recreate the defect FRG already forbids.

**Alternatives considered:**

- Keep append after `advanceWave()` and ask hosts to scrape `loop_run_handoff` on stderr → rejected. That is the current live-follow hole.
- Copy loop events into the train stream → rejected by #1277. Linkage is the drill-down.
- Invent a train-owned watcher of the loop state home → rejected. Exact `onRunReady` identity is already in process.

### 2. Exclusive mkdir plus bounded suffix; do not share `initRunDir` resume

**Choice:** Keep `trainRunIdFor(startedAt)` as `train-<filesystem-safe UTC ms>`. Allocate by creating `.agent-pipeline/runs/<id>/` with `mkdir` and `recursive: false` (EEXIST is a collision). Retry a suffix only on `EEXIST`. The bounded set is the unsuffixed id plus `-2` … `-8` (eight exclusive attempts). A non-`EEXIST` error (for example `EACCES`) does not suffix-retry; coverage is `unknown`. Exclusive mkdir is the claim. Only after a unique directory is created, call existing `initRunDir` for `run.json` / `events.jsonl` on that claimed path. Do not call `initRunDir` on a path whose exclusive create failed. Do not treat a colliding train directory as idempotent re-entry of a different train via `initRunDir` resume. Do not write store files under a directory whose exclusive create failed. Do not change advance `initRunDir` when `run.json` already exists for the same issue-prefixed id. A later conflicting `onRunReady` / `loopRun` identity keeps the first live link, sets `events_coverage` to `degraded`, and does not abort the wave.

**Why:** Node `mkdir` without recursive is already exclusive. It is on `RunStoreDeps`. Loop `renameDirExclusive` exists to publish a staged contract+ledger atomically; train identity is one empty directory. Reusing exclusive mkdir is the first holding rung. Changing generic `initRunDir` would break advance resume.

**Alternatives considered:**

- UUID train ids → rejected. `pipeline logs` listings stay timestamp-sorted next to advance ids; keep the `train-` prefix.
- Always fsync-rename a staged tree like loop `initRun` → extra layer. Train does not need atomic contract+ledger.
- Make `initRunDir` exclusive for every kind → rejected. Advance re-enters the same run id on purpose.

### 3. Allocation exhaustion degrades evidence and continues train

**Choice:** If every exclusive attempt fails, do not create or append to any candidate directory. Omit `train_run_handoff`. Omit `run_id` on `train_status`. Set additive `events_coverage` to `degraded` (or `unknown` when I/O failed before any exclusive success). Continue the same advance and merge mutations. Do not write `write-health.json` for a store that was never exclusively published.

**Why:** Write-health is per run directory. Sharing the colliding directory to record health would be the defect. `train_status` is the durable JSON the operator already reads. Coverage is observational; a missing stream MUST NOT become a merge or advance blocker.

**Alternatives considered:**

- Abort the train on allocation failure → rejected. Events are not authoritative.
- Append to the colliding directory and stamp write-health → rejected. That shares `seq` and identity.
- A sidecar coverage file under `.agent-pipeline/` → new layout. Additive `train_status` field is enough.

### 4. Both contained paths emit `train_merge_proven` with `proof_disposition`

**Choice:** In `emitMergeCatalog`, emit `train_merge_proven` whenever `kind === "integrated"` and containment was proven, including `merged.already`. Emit it only after containment is established and before `train_merge_integrated`. Payload includes issue number, linked PR when known, `proof_disposition` (`newly-merged` or `already-contained`), and the merge-result identity contained in the fetched base. Both paths share those invariants; only `proof_disposition` differs. Keep `train_merge_integrated` on both paths. Do not add a new event type. Non-merge trains still omit the merge catalog.

**Why:** Containment is the proof. Event absence is not a disposition. An additive field keeps `schema_version` at `1` and keeps existing readers that ignore unknown fields.

**Alternatives considered:**

- Infer already-contained from `train_merge_integrated` without proven → rejected. That is today's hole.
- A new `train_merge_already_contained` type → extra catalog entry for the same proof.
- Put disposition only on `train_merge_integrated` → FRG and hosts already key on `train_merge_proven`.

### 5. Stdout JSON and stderr handoff stay as they are, plus one additive field

**Choice:** `train --json` stdout remains exactly one `train_status` object (`schema_version` stays `1`). Successful exclusive init still flushes `train_run_handoff` on stderr before the first wave and still sets `run_id`. Failed allocation adds `events_coverage` and does not add extra stdout objects.

**Why:** #1184 forbids extra stdout JSON. The early handoff contract stays for the success path.

## Risks / Trade-offs

- **[Risk] Test fakes ignore `onLoopReady` and only set `loopRun` after return.** → Mitigation: wave-result confirmation is not an append site. Existing tests that do not assert `train_loop_linked` keep passing. A new live-link test MUST call `onLoopReady` and assert the event exists before the wave promise resolves.
- **[Risk] Exclusive mkdir of a suffix still races with a third train.** → Mitigation: each attempt is exclusive; the loser retries the next suffix. Exhaustion is bounded and observational.
- **[Risk] Changing `initRunDir` by accident breaks advance resume.** → Mitigation: collision handling lives in `initTrainRunStore` only. Tests MUST NOT require exclusive create for issue-prefixed `initRunDir`.
- **[Risk] `proof_disposition` readers that required proven-implies-attempted.** → Mitigation: already-contained still has `attempted: false`; tests cover both dispositions. Material filter already lists `train_merge_proven`.
- **[Trade-off] Suffix ids (`train-<ts>-2`) are new basenames.** Acceptable: they still start with `train-` and cannot collide with `<issue>-<timestamp>`.

## Migration Plan

- Additive for successful trains: live linkage appears earlier; merge proven appears on already-contained items; same-clock ids gain a suffix only on collision.
- Operators who follow `train_loop_linked` can dual-follow a blocked child. No host skill command change.
- Rollback: revert the change. Hosts again wait until the wave returns; same-clock trains can share a directory; already-contained omits proven.

## Open Questions

None that change the specs.
