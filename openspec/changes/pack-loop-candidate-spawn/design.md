## Context

See `proposal.md` for why. Current law and code:

- #1151 / living `factory-two-track-engine-pinning` already requires ship-end verbs (`factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, `ensureAnnotatedReleaseTag`) to exec the candidate launcher. `resolveCandidateEngine` already returns absolute `launcherPath` plus candidate SHA. Candidate **prepare** uses that path. Nested pack-loop spawn does not.
- `defaultSpawnCandidateLoop` execs `PIPELINE_BIN?.trim() || "pipeline"` with `stdio: "ignore"`. `--engine-track candidate` is on the argv. OS `spawn` success plus `observeDetachedChildStart` marks `dispatch_state: "dispatched"`. `isPendingLoopDispatch` is `dispatch_state === "bound"` only.
- `classifyBoundPackLoopLiveness` returns `"live"` when `lockPidAlive`, **or** when `ledgerPresent && !ledgerStopPresent && !eventsTerminal`. Unreadable lock/ledger is `"unknown"`, and wait law treats unknown as continue. That is the false-live stall.
- Supervisor `heartbeat_at` refreshes on cycle completion (and during recovery backoff chunks). A long first cycle, or a child that dies before any cycle, leaves a non-terminal ledger that current wait law treats as live.
- `loop_run_handoff` already exists (`kind: "loop_run_handoff"` after exclusive lock, before first item dispatch). Pack-loop spawn does not consume it because stdout is ignored.

**Conflict (do not average):** living pack-wait requirements say unreadable lock/ledger SHALL NOT count as not-live, and a non-terminal ledger is live. This change replaces that classifier with acknowledged-process identity plus a fresh heartbeat. The locked 2026-08-29 design is the source of truth.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Mixed-binary spawn.** Site symptom: pin 1.39.14 PATH `pipeline` rejected `publish_unpublished_stage_commit` written by candidate `6670cee`. The class is: a child that must interpret a contract written by candidate SHA `C` MUST exec the same candidate engine. Shared surface: pack-loop spawn invocation (`defaultSpawnCandidateLoop` / `productionDispatchPackLoop` and any later dispatcher), not a PATH pin mole.
2. **OS accept is not dispatch.** Site symptom: `dispatch_state: "dispatched"` after `spawn` while the child was already dead. The class is: persist `bound` before spawn; persist `dispatched` only after a valid `loop_run_handoff` plus matching `supervisor.json` process identity.
3. **Non-terminal ledger is not liveness.** Site symptom: dead pid + open ledger classified `live`, wait cap disabled for hours. The class is: acknowledged PID + process-start identity + boot identity + fresh heartbeat. Shared classifier used by in-engine ship, Tugboat, and the playbook.

After this lands, the next pin≠candidate ship that adds a recovery recipe, and the next pack child that dies before the first cycle, do **not** need new mole issues.

## Goals / Non-Goals

**Goals:**

- One candidate invocation object (absolute executable, argv, SHA) shared by prepare and its pack-loop child.
- Dispatch acknowledgement is the existing typed `loop_run_handoff`, validated against `supervisor.json`.
- Shared liveness classifier used by every ship-path FRG pack waiter.
- Periodic supervisor heartbeat independent of cycle completion, as an engine invariant.
- One recorded resume after acknowledged death; pre-handoff exit fails closed.
- Visible, bounded, redacted stderr in ship `last_error`.

**Non-Goals:**

- Removing `publish_unpublished_stage_commit` from the candidate catalogue.
- Making `--engine-track candidate` skip doctor.
- Cross-host locks (single-host remains the supported concurrency scope).
- Merging inside advance/loop.
- Restoring `--skip-frg`.
- Changing the closed recovery-recipe catalogue policy.
- A second durable scheduler or grant schema.

## Decisions

### Decision 1 — Reuse `resolveCandidateEngine`; never PATH or `PIPELINE_BIN`

Pack-loop spawn SHALL take the same `CandidateEngine` already resolved for candidate prepare: `launcherPath` as the absolute executable, `commitSha` as the bound SHA, argv `["loop", "--resume", <id>, "--engine-track", "candidate", "--profile", "claude"]` (or the current equivalent). `PIPELINE_CANDIDATE_ENGINE_ROOT` remains an allowed root under existing `resolveCandidateEngine` rules. PATH `pipeline` and `PIPELINE_BIN` are not production fallbacks.

`--engine-track candidate` stays on argv as doctor/soak intent and run-evidence metadata. Docs and spawn code SHALL NOT treat it as the binary selector.

Rejected: `PIPELINE_BIN` override for operators. That is how the pin leaked into the child. An operator who needs a different engine uses `PIPELINE_CANDIDATE_ENGINE_ROOT` or the existing candidate worktree, both of which still prove SHA `C`.

Rejected: `process.execPath` + `core/scripts/pipeline.ts` from the prepare process. Prepare may already be the candidate, but the child MUST still be the verified launcher at SHA `C`, not whatever Node happened to run the parent.

### Decision 2 — Pipe stdout and stderr to pipeline-owned evidence; consume `loop_run_handoff`

Detached spawn today uses `stdio: "ignore"`, so the parent cannot see handoff JSON or catalogue stderr. Spawn SHALL redirect stdout and stderr to pipeline-owned files under the prepare work dir or the loop run dir (mode `0600`). Stdin stays ignored. The parent SHALL watch stdout for one `kind: "loop_run_handoff"` JSON object, then validate:

- `run_id` equals the bound `loop_run_id`
- `run_dir` and `events` are absolute paths under the durable loop store
- `supervisor.json` process identity matches (pid, boot_id, started_at / process-start identity, lock token)

Only then persist `dispatch_state: "dispatched"`. OS `spawn` / `observeDetachedChildStart` remains a start signal, not acknowledgement.

Rejected: parse stderr prose for the run id. `loop_run_handoff` is already the machine-readable contract.

Rejected: keep `stdio: "ignore"` and poll `supervisor.json` only. The issue requires visible stderr on non-zero exit, and handoff is the typed ack.

### Decision 3 — Bound reconciliation before any second spawn

Before spawning, reconcile the persisted binding:

| Observed state | Action |
| --- | --- |
| Valid existing holder (matching handoff + live acknowledged identity) | Adopt. Do not spawn. |
| `bound`, child running, inside startup observation window, no handoff yet | Observe. Do not spawn a second child. |
| `bound`, proven pre-handoff non-zero exit | Fail closed. Do not retry. |
| OS spawn never started (ENOENT / spawn error) and binding still `bound` | Later invoke MAY retry spawn of the same `loop_run_id`. |
| Unreadable identity evidence | Bounded observation window, then typed fail closed. No resume grant. |

Never blindly create a second child. This narrows acceptance criterion 3: a failure before the first valid handoff fails closed; only a previously acknowledged durable run receives the single bounded resume.

Rejected: treat OS accept as dispatched and retry only when `bound`. That is today's stall.

Rejected: retry pre-handoff catalogue crashes. The child already proved it cannot boot that contract on that binary. Retrying the same invocation loops; retrying a different binary without a new candidate resolution hides the class bug.

### Decision 4 — Shared acknowledged-process liveness classifier

Replace `lockPidAlive || (ledgerPresent && !ledgerStopPresent && !eventsTerminal)`.

After acknowledgement, live requires **all** of:

1. Exact PID still alive on this host
2. Process-start identity matches the acknowledged `supervisor.json` record
3. Boot identity matches
4. Heartbeat is fresh under the engine stale threshold
5. Record `run_id` equals the bound loop

A non-terminal ledger is never sufficient. Dead-or-missing pid is not live. PID reuse without matching start/boot identity is not live. False live MUST NOT disable the wait cap.

Unreadable identity: keep a short observation window so a startup race is not instant fail, then fail closed. This **replaces** the current "unreadable SHALL NOT count as not-live / keep waiting" law in factory-reliability-gate, ship-coordinator, tugboat-thin-ship, and supervisor-ship-playbook.

Rejected: keep non-terminal ledger as live "to outlive long packs". That is the stall. Long work is covered by Decision 5 (periodic heartbeat).

### Decision 5 — Periodic heartbeat is an engine invariant

Supervisor `heartbeat_at` SHALL advance on a periodic process cadence even while a cycle is in flight (long implementer, long recovery wait). Cycle-end refresh stays. Cadence and stale threshold are versioned engine safety invariants. Repository `.github/pipeline.yml` SHALL NOT lengthen cadence or raise the stale threshold.

Exact numeric cadence is an implementation constant with a unit test, not a repo config knob. Do not invent a user-facing config key.

Existing recovery-backoff chunked heartbeat stays; it is not sufficient because the first cycle can still starve the record.

### Decision 6 — One recorded resume after acknowledged death

Persist a resume grant keyed by `loop_run_id` plus the failed process identity (`pid`, `boot_id`, `started_at`). Allow one spawn after acknowledged death while the run is resumable and non-terminal. The new process MUST emit a new valid handoff. A second liveness loss is terminal.

Unreadable evidence does not mint a grant.

Rejected: unbounded re-spawn of a crashing supervisor. That is the hours-long stall with extra children.

Rejected: reuse the `run_fatal` supersede path. Pack-loop liveness loss is not that stop reason.

### Decision 7 — Redacted stderr in `last_error`

On non-zero child exit, copy a bounded redacted excerpt into pipeline-owned evidence. Ship `last_error` includes exit status, excerpt, and evidence path. Redaction SHALL drop FRG credential material and home-directory secrets. Catalogue validation text MUST survive.

Parent prepare JSON stdout stays clean: evidence files are not mixed into the prepare result body except by path reference.

### Decision 8 — Tests inject spawn, identity, and time

No real network, git, or subprocess. Inject spawn argv/env, handoff payload, `supervisor.json`, pid liveness, heartbeat clock, and stderr bytes. Required bites:

- Candidate vs pin executable when recipe `publish_unpublished_stage_commit` is in the candidate contract
- `PIPELINE_BIN` unset still does not exec PATH `pipeline`
- OS accept does not persist `dispatched`
- Pre-handoff exit 1 fails closed and fills `last_error`
- Dead pid + no `ledger.stop` + no terminal events is not `live`
- PID reuse is not `live`
- Heartbeat freshness during a long in-flight cycle
- One-resume then terminal second loss
- Unreadable identity does not grant resume
- False live does not disable wait cap

Existing tests that assert `captured.command === "/opt/pipeline"` from `PIPELINE_BIN`, and that dead-pid + open ledger is live, MUST be rewritten to the new law. They currently encode the bug.

## Risks / Trade-offs

- **[Risk] Observing handoff delays prepare JSON `in_progress`.** → Mitigation: wait only the startup observation window, then return `in_progress` after valid handoff. Pre-handoff failure returns failed, not in_progress.
- **[Risk] Periodic heartbeat from a stuck cycle looks live forever.** → Mitigation: stale threshold still applies; heartbeat must keep moving. Existing no-progress watchdog still stops a spinning run.
- **[Risk] Fail-closed unreadable identity flaps on transient FS errors.** → Mitigation: bounded observation window first; then typed error, not silent retry.
- **[Risk] One-resume hides a mixed-binary crash by restarting the same pin.** → Mitigation: resume uses the same candidate invocation object. Pin PATH is never the resume binary.
- **[Risk] Weakening the wait-unknown law kills a live pack during a lock-file race.** → Mitigation: observation window plus explicit process identity; live acknowledged pid with fresh heartbeat still outlives the CI cap.
- **[Risk] Spec/code drift on the restated Tugboat pack-fail sentences.** → Mitigation: this change MODIFIES both the dedicated wait requirements and the pack-phase restatement so archive does not leave "unreadable is live".

## Migration Plan

No durable schema migration for existing `dispatched` bindings. A binding already marked `dispatched` without a valid handoff is not live under the new classifier (dead pid + open ledger is not live). Ship fail-closes or takes the one-resume path only when acknowledgement evidence exists.

New fields (resume grant, evidence stderr path) are additive. Rollback is revert of the change; mixed-binary spawn and false-live wait return.

Operators do not edit `ledger.json`. `PIPELINE_BIN` is no longer a pack-loop override.

## Open Questions

_(none)_
