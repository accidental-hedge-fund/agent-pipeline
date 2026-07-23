## Why

The in-repo durable loop engine (#508–#511) now owns the run's durable *state*: contract
compilation, the ledger, exclusive locking with liveness-based staleness, typed blocker
classification and recovery (#509), durable paused/waiting holds and audited authority
amendments (#510), and verified live reconciliation (#511). But nothing in-repo actually
*drives a run to completion*. `pipeline loop` (`core/scripts/pipeline.ts`) still runs its
read-only preflight and then **prints a delegation payload** for the host `SKILL.md` to hand
off to a separately installed external `goal-loop` skill (`loop-preflight.ts` even discovers
that install via `.goal-loop-manifest.json` / `state.py`). That is the "thin external-skill
facade" the `pipeline-loop-facade` and `durable-loop-engine` living specs already say must not
exist: those specs forbid depending on, discovering, or invoking an external goal-loop skill,
and require Agent Pipeline to be the sole authoritative engine — yet the actual *supervisor*
that consumes the engine primitives and executes items is still the external skill.

This change closes that gap by implementing the missing runtime: an **Agent Pipeline-owned
durable loop supervisor** that drives a compiled run cycle-by-cycle through the engine
primitives already in `core/scripts/loop/`, hands whole items off through the
`pipeline/loop-execution@1` contract (never a per-stage verb, never a merge), and survives
process death. It adds exactly the durable state the issue names and the engine does not yet
carry: **process identity** (which supervisor process owns this run right now), a
**watchdog / no-progress** signal (so a wedged or spinning driver stops instead of burning the
run), an **action-evidence** trail (a durable per-cycle record of what the supervisor decided
and did), **resume** semantics that safely take over a run whose supervisor is provably gone,
and a substantive read-only **audit** mode over that trail. All of it lives in the *same* run
directory under the Pipeline state home — no second ledger, lock, run-id namespace, or store.

## What Changes

- **Supervisor drive loop.** Add an in-repo supervisor (e.g. `core/scripts/loop/supervisor.ts`)
  that, given a compiled/locked run, repeatedly: reconciles live truth (#511), selects the next
  dependency-ready active item (respecting the contract's `max_active_items: 1`), dispatches that
  whole item through `pipeline/loop-execution@1`, records the terminal outcome into the ledger via
  the engine's transition/recovery/pause paths, and continues until the run reaches a terminal
  condition (all items done/abandoned, a stop record, a paused/waiting hold, or a watchdog stop).
  The supervisor SHALL NOT set, skip, or reorder pipeline stage labels, SHALL NOT expose or call any
  per-stage verb, and SHALL NOT merge — every stage transition originates in the unmodified
  per-item advance state machine, which continues to own exactly one issue at a time.
- **Persisted process identity.** Add a durable `supervisor.json` process-identity record in the run
  directory — engine, pid, hostname, a per-boot id, `started_at`, a monotonic `heartbeat_at`, and the
  held lock token — written at attach and refreshed every cycle. It composes with (does not replace)
  the existing `lock.json`: the lock answers "who may write," the process record answers "who is
  driving right now and is it still alive and progressing."
- **Watchdog / no-progress detection.** Each cycle is classified as *progress* (a durable delta: an
  item transition, a reconciliation change, a recovery attempt, a new block/hold, or a stop) or
  *no-progress*. After a bounded number of consecutive no-progress cycles the supervisor stops the run
  terminally with a dedicated stop reason rather than hot-spinning. This run-level cycle watchdog is
  distinct from, and composes with, the item-level `repeated_no_progress` bound already in
  `loop/recovery.ts` (#509).
- **Action-evidence trail.** Each cycle appends a durable, append-only action-evidence entry
  (sequence, time, the item acted on if any, the action taken, the resulting outcome/next-action, and
  the progress classification) so a resuming process or an auditor can reconstruct exactly what the
  supervisor did — the durable answer to "what happened between then and the crash."
- **Resume / takeover semantics.** `--resume <run-id>` attaches a fresh supervisor to an existing run
  *only* when the prior holder is provably gone by the store's existing rules — a released lock, or a
  same-host dead-pid lock recovered through the engine's provably-dead recovery path. Before resuming
  execution it runs a reconciliation pass so it acts on verified live truth, records a resume marker
  in the action-evidence trail, and continues from the ledger's current position. A run whose holder
  is still alive (fresh heartbeat / live pid) is **refused**: the supervisor surfaces the live holder
  and exits without a second driver — consistent with the store's exclusive-lock invariant and the
  documented single-host concurrency scope (#459). Cross-host unverifiable liveness is treated as
  not-recoverable, not as dead.
- **Substantive audit mode.** `--audit` renders a read-only report over the run's durable artifacts —
  the current/last process identity, the action-evidence timeline, the watchdog/no-progress state, and
  the current position — performing no ledger write, no lock acquisition, no process-record write, and
  no GitHub mutation, exactly as the facade's read-only audit invariant requires.
- **Retire the external-skill dependency in the loop path.** The `pipeline loop` command drives the
  in-repo supervisor instead of printing an external-skill delegation payload, and the run-start
  preflight stops discovering/requiring an installed external goal-loop skill (its
  `loop:contract-coherence` check is replaced by the in-repo durable loop store's schema-compatibility
  check, per the already-living `pipeline-loop-facade` spec). The documented read-only legacy-run
  *import* path is unaffected — a pre-existing legacy run remains addressable by id.

## Acceptance Criteria

- [ ] `pipeline loop <selector>` starts a run and drives it to a terminal condition entirely in-repo:
  through injected seams, the run compiles a contract, locks, and executes at least one selected item
  via the `pipeline/loop-execution@1` contract with **no** subprocess invocation of an external
  goal-loop skill or its state CLI recorded on any path.
- [ ] A durable `supervisor.json` process-identity record (engine, pid, hostname, per-boot id,
  `started_at`, `heartbeat_at`, lock token) is written in the run directory at attach and its
  `heartbeat_at` advances on each cycle; a unit test asserts the record is written and refreshed
  through the injected store seam with zero real process, network, or git calls.
- [ ] The supervisor classifies each cycle as progress vs. no-progress; after the configured
  consecutive-no-progress bound it records a terminal stop with a dedicated no-progress supervisor stop
  reason and halts, and a test proves a run that would otherwise spin (no eligible item, no drift, no
  recovery) stops instead of looping unbounded.
- [ ] Each cycle appends an append-only action-evidence entry (monotonic sequence, time, item acted on
  or none, action, outcome/next-action, progress classification); the trail is reconstructable in order
  from the run directory and a test asserts sequence monotonicity and append-only behavior.
- [ ] The supervisor issues **no** pipeline stage-label write of its own and exposes no per-stage verb:
  a test drives a full item through execution and asserts every stage-label transition originated in the
  per-item advance state machine, and that the supervisor performed no merge.
- [ ] `--resume <run-id>` attaches to an existing run only when the prior holder is provably gone
  (released lock, or same-host dead-pid recovered via the store's provably-dead path), runs a
  reconciliation pass before continuing, records a resume marker in the action-evidence trail, and
  continues from the ledger's current position without creating a second run, lock, or run directory.
- [ ] `--resume <run-id>` against a run whose lock holder is still alive (fresh heartbeat / live pid, or
  cross-host unverifiable) is refused non-zero, surfaces the live holder, and performs no ledger write,
  no lock acquisition, no process-record write, and no GitHub mutation.
- [ ] `--audit` renders the process identity, action-evidence timeline, watchdog/no-progress state, and
  current position for an existing run and performs zero durable writes — no ledger write, no lock
  acquisition, no `supervisor.json` write, and no GitHub mutation — asserted through the injected seams.
- [ ] The `pipeline loop` run-start path no longer discovers, requires, or invokes an installed external
  goal-loop skill; its preflight uses the in-repo durable loop store's schema-compatibility check, and a
  run on a host with no goal-loop skill installed at any root starts, executes, and reports a run id with
  no install-remediation failure; the read-only legacy-run import path remains addressable by run id.
- [ ] `node scripts/build.mjs` regenerates the plugin mirror and `npm run ci` (including
  `openspec validate --all`) is green; every new regression test bites (fails without the change).

## Capabilities

### New Capabilities

- `durable-loop-supervisor`: the Agent Pipeline-owned runtime that drives a compiled durable loop run
  to completion — a cycle loop that reconciles, selects one dependency-ready item, hands it off whole
  through `pipeline/loop-execution@1`, and records the outcome through the engine; a persisted
  process-identity record with heartbeat; a run-level watchdog/no-progress stop; an append-only
  action-evidence trail; provably-safe resume/takeover of a dead supervisor; and a read-only audit
  surface over those artifacts — all in the single authoritative run directory, never a second store,
  never touching the per-item advance state machine, and never merging.

## Impact

- **Specs:** new `durable-loop-supervisor` capability. No existing requirement is removed or modified —
  the supervisor consumes the already-living `durable-loop-engine`, `durable-loop-store`,
  `durable-run-reconciliation`, `durable-blocker-classification`, `durable-pause-and-authority`, and
  `pipeline-loop-facade` capabilities; this change adds the driver they were built to serve.
- **Code (implementation step only, not this change):** a new `core/scripts/loop/supervisor.ts` drive
  loop; a `LoopSupervisorProcess` / action-evidence type plus a new supervisor stop reason in
  `core/scripts/loop/types.ts`; store helpers for the `supervisor.json` record and the action-evidence
  log (mirroring the existing atomic-write / append-only / token-guarded helpers in `loop/store.ts`);
  wiring `pipeline loop` in `core/scripts/pipeline.ts` to drive the supervisor and to resume/audit; and
  replacing the external-skill discovery in `loop-preflight.ts` with the in-repo store
  schema-compatibility check. All I/O behind injected seams so unit tests do no real network, git, or
  subprocess calls. Regenerate `plugin/` via `node scripts/build.mjs`.
- **Interoperability:** additive — a run that never had a `supervisor.json` (a pre-#512 run) audits and
  resumes with the record simply absent until first attach. No new external write path and no
  auto-merge / auto-release / auto-deploy is introduced (golden rule #4). Single-host operation remains
  the supported concurrency scope for the run lock and process record (#459).
