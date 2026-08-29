## Context

See `proposal.md` for why. Current law and code (validated in this worktree):

- #1151 / living `factory-two-track-engine-pinning` already requires ship-end verbs (`factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, `ensureAnnotatedReleaseTag`) to exec the candidate launcher. `resolveCandidateEngine` in `core/scripts/ship-end-candidate.ts` already returns absolute `launcherPath` plus candidate SHA. Candidate **prepare** uses that path via `shipEndCliPrefix`. Nested pack-loop spawn does not.
- `defaultSpawnCandidateLoop` in `core/scripts/factory-release-prepare.ts` execs `PIPELINE_BIN?.trim() || "pipeline"` with `stdio: "ignore"`. `--engine-track candidate` is on the argv. OS `spawn` success plus `observeDetachedChildStart` then `markDispatched` marks `dispatch_state: "dispatched"`. `isPendingLoopDispatch` is `dispatch_state === "bound"` only. `FactoryReleaseLoopDispatchState` is `"bound" | "dispatched"` only.
- `classifyBoundPackLoopLiveness` in `core/scripts/stages/ship-adapter.ts` returns `"live"` when `lockPidAlive`, **or** when `ledgerPresent && !ledgerStopPresent && !eventsTerminal`. The Tugboat copy is `frg_pack_loop_is_live` in `examples/supervisor/shell/frg-pack-helpers.sh` (same ledger-or-pid law). Unreadable lock/ledger is `"unknown"`, and wait law treats unknown as continue. That is the false-live stall.
- Supervisor `heartbeat_at` refreshes on cycle completion in `driveSupervisor` (`core/scripts/loop/supervisor.ts`) and during recovery backoff 5s chunks. A long first cycle, or a child that dies before any cycle, leaves a non-terminal ledger that current wait law treats as live.
- `loop_run_handoff` already exists (`core/scripts/loop/handoff.ts`, stdout JSON after exclusive lock, before first item dispatch). Pack-loop spawn does not consume it because stdout is ignored. The parent detaches (`detached: true`) and `unref`s, so a live stdout watch would not survive a detached parent anyway.

**Conflict (do not average):** living pack-wait requirements say unreadable lock/ledger SHALL NOT count as not-live, and a non-terminal ledger is live. This change replaces that classifier with acknowledged-process identity plus a fresh heartbeat. The locked 2026-08-29 design, plus the plan-review revisions below, is the source of truth.

**Conflict (do not average):** original acceptance criterion 3 said a pre-first-cycle exit SHALL retry spawn **or** fail closed. The locked design already narrowed that: a failure after the OS accepted the child and before the first valid handoff fails closed. OS never-started (ENOENT) remains retryable on the same `loop_run_id`. Plan review adds: exit `0` before handoff is also failure.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Mixed-binary spawn.** Site symptom: pin 1.39.14 PATH `pipeline` rejected `publish_unpublished_stage_commit` written by candidate `6670cee`. The class is: a child that must interpret a contract written by candidate SHA `C` MUST exec the same candidate engine. Shared surface: pack-loop spawn invocation (`defaultSpawnCandidateLoop` / `productionDispatchPackLoop` and any later dispatcher), not a PATH pin mole.
2. **OS accept is not dispatch.** Site symptom: `dispatch_state: "dispatched"` after `spawn` while the child was already dead. The class is: persist `bound` before spawn; persist `starting` after OS accept; persist `dispatched` only after a valid durable `loop_run_handoff` plus matching `supervisor.json` process identity.
3. **Non-terminal ledger is not liveness.** Site symptom: dead pid + open ledger classified `live`, wait cap disabled for hours. The class is: acknowledged PID + process-start identity + boot identity + fresh heartbeat. Shared **status object**, consumed by in-engine ship, Tugboat, and the playbook.

After this lands, the next pin≠candidate ship that adds a recovery recipe, and the next pack child that dies before the first cycle, do **not** need new mole issues.

## Goals / Non-Goals

**Goals:**

- One typed `CandidateInvocation` (absolute executable, immutable argv, SHA) passed from the resolver to dispatch. Never re-derived from PATH, `PIPELINE_BIN`, `process.argv`, or `--engine-track`.
- Durable dispatch state machine: `bound` / `starting` / `dispatched` / `failed`, with observation deadline and attempt evidence under the binding.
- Dispatch acknowledgement is a durable/atomic `loop_run_handoff` that survives a detached parent.
- Shared liveness **status JSON** used by every ship-path FRG pack waiter. TS and Bash do not share a function; they consume the same status.
- Periodic supervisor heartbeat independent of cycle completion, as an engine invariant with a fake-clock seam.
- One run-lineage `resume_count` after acknowledged death; failed process identity is audit evidence. A new PID does not mint a second grant.
- Visible, bounded, redacted stderr in ship `last_error`, including evidence-write failure.

**Non-Goals:**

- Removing `publish_unpublished_stage_commit` from the candidate catalogue.
- Making `--engine-track candidate` skip doctor.
- Cross-host locks (single-host remains the supported concurrency scope).
- Merging inside advance/loop.
- Restoring `--skip-frg`.
- Changing the closed recovery-recipe catalogue policy.
- A second durable scheduler or grant schema.
- A new public `pipeline loop liveness` verb unless prepare JSON cannot carry the status. Prefer embedding the status on candidate prepare `in_progress`.

## Decisions

### Decision 1 — Typed `CandidateInvocation`; never PATH, `PIPELINE_BIN`, `process.argv`, or `--engine-track`

Introduce a frozen object, built once from `resolveCandidateEngine` plus the bound `loop_run_id`:

```
CandidateInvocation = {
  executable: absolute launcherPath,
  argv: Object.freeze(["loop", "--resume", <id>, "--engine-track", "candidate", "--profile", "claude"]),
  candidateSha: 40-hex C
}
```

`productionDispatchPackLoop` / `defaultSpawnCandidateLoop` SHALL take that object. Fail closed if it is missing, `executable` is not an absolute existing launcher, `candidateSha` is not exact 40-hex, or `candidateSha` does not equal `request.integrated_candidate.git_sha`. Do not rebuild it from PATH, `PIPELINE_BIN`, `process.argv[1]`, or the `--engine-track` flag.

`--engine-track candidate` stays on argv as doctor/soak intent and run-evidence metadata. Docs and spawn code SHALL NOT treat it as the binary selector.

`PIPELINE_CANDIDATE_ENGINE_ROOT` remains an allowed root under existing `resolveCandidateEngine` rules.

Rejected: `PIPELINE_BIN` override for operators. That is how the pin leaked into the child.

Rejected: `process.execPath` + `core/scripts/pipeline.ts` from the prepare process. Prepare may already be the candidate, but the child MUST still be the verified launcher at SHA `C`.

Pattern citation: `shipEndCliPrefix` + `shipEndLeafArgv` in `core/scripts/ship-end-candidate.ts` already freeze an absolute launcher plus leaf argv for prepare itself. Pack-loop spawn follows that same object, not a second PATH lookup.

### Decision 2 — Durable dispatch state machine

Replace `FactoryReleaseLoopDispatchState = "bound" | "dispatched"` with four states persisted on `factory-release-binding.json` under the existing write lock / atomic write:

| State | Meaning | Next spawn? |
| --- | --- | --- |
| `bound` | Request bound. Never spawned, or OS spawn never started (ENOENT / throw before `spawn` event). | Later invoke MAY retry the same `loop_run_id` with the same `CandidateInvocation`. |
| `starting` | OS accepted the child. No valid durable handoff yet. `observation_deadline` is set. | Do not spawn a second child. Observe until handoff, proven exit, or deadline. |
| `dispatched` | Valid durable `loop_run_handoff` plus matching `supervisor.json` identity. | Adopt if live. One-resume path only after acknowledged death (Decision 7). |
| `failed` | Terminal pre-handoff failure: any child exit (`0` or non-zero), crash after OS accept before handoff, observation-deadline expiry, or mismatched handoff. | Fail closed. Do not retry. Do not mint a new `loop_run_id`. |

Persist under the binding (additive fields):

- `dispatch_state`
- `observation_deadline` (ISO) while `starting`
- `spawn_attempt` evidence (`error_code`, pid if known, at)
- `candidate_invocation` snapshot (`executable`, `argv`, `candidateSha`)
- `stderr_evidence_path` when captured
- `resume_count` (integer, default 0)
- `failed_process_identity` (audit only: pid, boot_id, started_at)

`isPendingLoopDispatch` becomes `dispatch_state === "bound"` (retryable never-started only). `starting` is not pending retry.

Exit `0` before handoff is failure. A child that exits cleanly without publishing a valid handoff did not acknowledge.

Concurrent prepare reconciliation: before any spawn, read the binding. Adopt a valid dispatched holder. Observe `starting` in-window. Fail closed on `failed`. Retry only `bound`. Never blindly create a second child.

Startup observation window: engine constant `PACK_LOOP_STARTUP_OBSERVATION_MS = 30_000`. Persist the deadline at the `bound` → `starting` transition. Repository config cannot lengthen it.

Rejected: treat OS accept as `dispatched` and retry only when `bound`. That is today's stall.

Rejected: retry pre-handoff catalogue crashes. The child already proved it cannot boot that contract on that binary.

### Decision 3 — Durable/atomic `loop_run_handoff` transport

Stdout `loop_run_handoff` stays the live-harness contract (`formatLoopRunHandoff` in `core/scripts/loop/handoff.ts`). Pack-loop **acknowledgement** SHALL NOT depend on the parent still holding those pipes.

At `onRunReady` (after exclusive lock, before first dispatch), the child SHALL also write a durable acknowledgement through the store's `writeFileAtomic` seam, token-guarded like `writeSupervisorProcess`:

- Path: `<run_dir>/loop-run-handoff.json` (mode inherited from store atomic write).
- Payload: existing `LoopRunHandoff` fields plus `candidate_sha` (40-hex) and a supervisor identity snapshot (`pid`, `boot_id`, `started_at`, `token`).
- Write is atomic. A concurrent reader never sees a partial object.

A detached or restarted parent reconciles by reading that file. It does not require the original stdout pipe.

Validation before `dispatched`:

1. `run_id` equals the bound `loop_run_id` (exact).
2. `candidate_sha` equals the frozen `CandidateInvocation.candidateSha`.
3. `run_dir` and `events` are absolute.
4. `realpath(run_dir)` is contained in the durable loop store home (`<state-home>/runs/<id>`).
5. `realpath(events)` is contained in that `run_dir`.
6. `supervisor.json` PID, `boot_id`, and `started_at` match the handoff snapshot and the live lock holder.

Mismatch → `failed`, typed identity error, no `dispatched`.

Rejected: parse stderr prose for the run id.

Rejected: keep `stdio: "ignore"` and poll `supervisor.json` only. The issue requires visible stderr, and handoff is the typed ack.

Rejected: parent-only stdout watch. Detached prepare plus `unref` drops the pipe.

### Decision 4 — Stderr capture is drain, redact, bound, persist

Pack-loop spawn SHALL NOT use `stdio: "ignore"` for stdout or stderr. Stdin stays ignored.

Spawn stdio: `["ignore", stdoutSink, stderrSink]`.

Mechanics:

- Drain both pipes on `data` so the child cannot block on a full pipe.
- Bound: keep 16 KiB head + 16 KiB tail (32 KiB total) per stream.
- Redact **before** persist with existing `redactSecrets` + `sanitize` from `core/scripts/artifact-sanitize.ts` (same path as `capWriteHealthError` in `core/scripts/run-store.ts`). Catalogue validation text MUST survive. FRG credential material and home-directory secrets MUST NOT.
- Persist under the prepare work dir or the loop run dir, mode `0600`, path recorded on the binding as `stderr_evidence_path`.
- Evidence-write failure: still fail closed with the child exit or observer error. `last_error` names the exit/error **and** the write failure. Do not swallow the exit because the excerpt file could not be written.

Ship `last_error` format (single string):

```
pack-loop child exit <n> (<error_code>): <safe excerpt> (evidence: <path>)
```

When there is no numeric exit (spawn throw): `pack-loop spawn error <code>: <safe excerpt> (evidence: <path-or-none>)`.

Parent prepare JSON stdout stays clean: evidence files are not mixed into the prepare result body except by path reference and the liveness status object (Decision 5).

### Decision 5 — One consumer protocol for liveness

TS and Bash cannot share a function. The authoritative result is a versioned JSON object produced by one TS probe:

```
PackLoopLivenessStatus = {
  schema_version: 1,
  kind: "pack_loop_liveness",
  loop_run_id,
  status: "live" | "not-live" | "unknown" | "failed",
  reason,                  // typed: no_handoff | dead_pid | pid_reuse | stale_heartbeat | unreadable_identity | pre_handoff_exit | ...
  observed_at,
  observation_deadline,    // present while unknown/starting
  heartbeat_at,
  stderr_evidence_path
}
```

Owner module: new `core/scripts/loop/pack-loop-liveness.ts`. `classifyBoundPackLoopLiveness` / `probeBoundPackLoopLive` in `ship-adapter.ts` become thin wrappers that consume this status. They SHALL NOT keep the ledger-or-pid law.

Live requires **all** of, after a valid durable handoff:

1. Exact PID still alive on this host
2. Process-start identity (`started_at`) matches the acknowledged `supervisor.json` record
3. Boot identity (`boot_id`) matches
4. Heartbeat is present, parseable, not in the future beyond a small clock-skew slack of 1s, and not older than `PACK_LOOP_HEARTBEAT_STALE_MS`
5. Record `run_id` equals the bound loop

A non-terminal ledger is never sufficient. Dead-or-missing pid is not live. PID reuse without matching start/boot identity is not live. False live MUST NOT disable the wait cap.

Heartbeat edge cases:

- Missing `heartbeat_at` after handoff → `not-live` (stale).
- Malformed timestamp → `unknown` until observation deadline, then `failed` typed identity error.
- Future `heartbeat_at` beyond 1s slack → malformed, same as above. It SHALL NOT count as fresh.

Unreadable identity: `unknown` until the persisted observation deadline, then `failed`. It does not authorize resume and does not count as live after that window.

**Consumer protocol:** candidate `factory-release prepare` embeds `liveness: PackLoopLivenessStatus` on `in_progress` (and on fail-closed pre-handoff results). In-engine ship (`classifyFrgPackWaitDecision`) reads that field, falling back to the TS probe with the same schema. Tugboat and the playbook SHALL stop using the Python ledger-or-pid copy in `frg_pack_loop_is_live`. They SHALL read `liveness.status` from the prepare JSON they already capture each wait tick. Rewrite `frg_pack_loop_is_live` to a thin mapper of that field (or delete its ledger parser and have `frg_pack_wait_decision` take the prepare JSON). Do not leave two laws.

Rejected: keep non-terminal ledger as live "to outlive long packs". Long work is covered by Decision 6.

Rejected: a second independent Bash classifier that "matches" TS by copying field names.

### Decision 6 — Periodic heartbeat is an engine invariant

Supervisor `heartbeat_at` SHALL advance on a periodic process cadence even while a cycle is in flight. Cycle-end refresh stays. Recovery-backoff 5s chunks stay; they are not sufficient.

Engine constants (not `.github/pipeline.yml` keys):

- `PACK_LOOP_HEARTBEAT_CADENCE_MS = 5_000`
- `PACK_LOOP_HEARTBEAT_STALE_MS = 30_000`

Repository configuration SHALL NOT lengthen the cadence or raise the stale threshold. A config value that tries to is ignored. Unit tests prove the clamp.

Mechanics:

- `driveSupervisor` starts a heartbeat timer after attach via an injected `setHeartbeatInterval` / `clearHeartbeatInterval` seam on `SupervisorDeps` (fake clock + fake timer in tests; no real `setInterval` in unit tests).
- Each tick calls `writeSupervisorProcess` with the current lock token (existing token guard).
- A tick without current lock ownership is a no-op (do not write).
- `finally` of `driveSupervisor` MUST clear the timer. Tests prove cleanup.
- `deps.store.now()` is the clock. Tests inject it.

Rejected: a user-facing config key.

### Decision 7 — Resume budget is run-lineage scoped

Persist `resume_count` on the binding for that `loop_run_id` (the run lineage). Default 0.

When an acknowledged (`dispatched`) process dies while the run remains resumable and non-terminal:

- If `resume_count === 0`: increment to 1, record `failed_process_identity` as audit evidence, spawn **once** with the **same** `CandidateInvocation`, require a new valid durable handoff before `dispatched`.
- If `resume_count >= 1`: terminal. Do not spawn. A new PID on the resumed process does **not** mint a new grant.

Unreadable identity does not increment `resume_count` and does not spawn.

The grant persists under the binding so a later invoke cannot claim a second grant.

Rejected: key the budget only by failed process identity so a new PID gets a fresh grant. That is unbounded restart with extra steps.

Rejected: unbounded re-spawn of a crashing supervisor.

Rejected: reuse the `run_fatal` supersede path.

### Decision 8 — Tests inject spawn, identity, clock, and timers

No real network, git, or subprocess. Inject fake `Spawn`/`ChildProcess` (EventEmitter), store, PID probe, clock, and timers.

Required bites (must fail on current code before the fix):

- Mixed-binary: candidate SHA `C` contract contains `publish_unpublished_stage_commit`; pin `P` catalogue rejects it; `PIPELINE_BIN` unset; assert the **actual spawned executable** is `C`'s launcher, not PATH `pipeline` / `P`. Do not mock the candidate catalogue in place of the executable assertion.
- Rewrite `captured.command === "/opt/pipeline"` tests in `core/test/factory-release-prepare.test.ts`.
- OS spawn error/throw leaves `bound`, retryable.
- Pre-handoff exit `0` and exit `1` both → `failed`, not `dispatched`.
- Crash after OS accept before handoff → `failed`.
- Handoff SHA mismatch → not `dispatched`.
- Valid handoff then immediate death → not `live`; one resume then terminal.
- Concurrent prepare reconciliation does not spawn a second child.
- PID reuse is not `live`.
- Fresh / stale / malformed / future heartbeat.
- Unreadable evidence inside the window = `unknown`; after deadline = `failed`.
- Dead pid + no `ledger.stop` + no terminal events is not `live`.
- False live does not disable wait cap (`classifyFrgPackWaitDecision` and Tugboat helper).
- Stderr drain + `last_error` excerpt + evidence path; evidence-write failure still reports the exit.
- Periodic heartbeat during a long in-flight cycle (fake timer).
- One-resume-then-terminal (`resume_count`).

Existing tests that encode dead-pid + open ledger as live (`core/test/ship-adapter.test.ts`, `core/test/tugboat.test.ts`) MUST be rewritten to the new law.

## Implementation sequence / ownership

Do not start composer migrations or docs before the spawn/handoff state machine exists.

1. **Candidate invocation + handoff state** (owner: `factory-release-prepare.ts`, `ship-end-candidate.ts`, `loop/handoff.ts`, `loop/store.ts`)
   - `CandidateInvocation` type and fail-closed builder from `resolveCandidateEngine`.
   - Four-state binding + observation deadline + attempt evidence.
   - Durable atomic `loop-run-handoff.json`.
   - Stderr drain/redact/persist.
   - Tests in `core/test/factory-release-prepare.test.ts` (and a focused handoff validation test next to `core/test/loop-command.test.ts` if the durable write lives in `handoff.ts`).
2. **Heartbeat + liveness** (owner: `loop/supervisor.ts`, `loop/types.ts`, new `loop/pack-loop-liveness.ts`)
   - Periodic timer seam, constants, cleanup.
   - Authoritative `PackLoopLivenessStatus`.
   - Tests in `core/test/loop-supervisor.test.ts` and a new `core/test/pack-loop-liveness.test.ts`.
3. **Composer migrations** (owner: `stages/ship-adapter.ts`, `examples/supervisor/shell/frg-pack-helpers.sh`, `tugboat.sh`)
   - Embed status on prepare JSON; ship wait + Tugboat + playbook consume it.
   - Rewrite/remove ledger-derived `frg_pack_loop_is_live`.
   - Tests in `core/test/ship-adapter.test.ts` and `core/test/tugboat.test.ts`.
4. **Generated mirror / docs** (owner: `scripts/build.mjs`, FRG/ship runbook text)
   - `node scripts/build.mjs` after any `core/` edit; include `plugin/`.
   - `--engine-track candidate` is not a binary selector.
   - `npm run ci` from repo root. Do not claim pass without that evidence.

## Risks / Trade-offs

- **[Risk] Observing handoff delays prepare JSON `in_progress`.** → Mitigation: wait only the startup observation window. Valid handoff → `in_progress`. Pre-handoff failure → failed, not in_progress.
- **[Risk] Periodic heartbeat from a stuck cycle looks live forever.** → Mitigation: stale threshold still applies; existing no-progress watchdog still stops a spinning run.
- **[Risk] Fail-closed unreadable identity flaps on transient FS errors.** → Mitigation: bounded observation window first; then typed error, not silent retry.
- **[Risk] One-resume hides a mixed-binary crash by restarting the same pin.** → Mitigation: resume uses the frozen `CandidateInvocation`. Pin PATH is never the resume binary. Budget is lineage-scoped so a new PID cannot loop.
- **[Risk] Weakening the wait-unknown law kills a live pack during a lock-file race.** → Mitigation: observation window plus explicit process identity; live acknowledged pid with fresh heartbeat still outlives the CI cap.
- **[Risk] Spec/code drift on Tugboat pack-fail sentences.** → Mitigation: this change MODIFIES both the dedicated wait requirements and the pack-phase restatement so archive does not leave "unreadable is live".
- **[Risk] Parent stdout watch misses handoff after detach.** → Mitigation: durable `loop-run-handoff.json` is the ack; stdout remains a live-harness extra.

## Migration Plan

No durable schema migration for existing `dispatched` bindings. A binding already marked `dispatched` without a valid durable handoff is not live under the new classifier (dead pid + open ledger is not live). Ship fail-closes or takes the one-resume path only when acknowledgement evidence exists and `resume_count === 0`.

Unknown `dispatch_state` values fail closed. Additive fields default: `resume_count = 0`, no deadline.

Rollback is revert of the change; mixed-binary spawn and false-live wait return.

Operators do not edit `ledger.json`. `PIPELINE_BIN` is no longer a pack-loop override.

## Open Questions

_(none — plan-review items are locked in Decisions 1–8)_
