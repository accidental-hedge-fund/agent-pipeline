## Tasks

## 1. Supervisor process-identity & action-evidence types
- [ ] 1.1 Add a `LoopSupervisorProcess` record type to `core/scripts/loop/types.ts` (`engine`, `pid`,
      `hostname`, `boot_id`, `started_at`, `heartbeat_at`, `token`, `run_id`).
- [ ] 1.2 Add a `LoopActionEvidence` entry type (`seq`, `time`, `item_id: string | null`, `action`,
      `outcome`/`next_action`, `progress: "progress" | "no_progress"`), and a closed `action` set.
- [ ] 1.3 Add a supervisor no-progress `LoopStopRecord.reason` member (e.g.
      `supervisor_no_progress`) and a `consecutive_no_progress_limit` on the contract (default +
      documented).

## 2. Store helpers for the new run-directory artifacts
- [ ] 2.1 Add atomic-write helpers for `supervisor.json` (write at attach, refresh heartbeat) mirroring
      the existing atomic-write / token-guarded pattern in `core/scripts/loop/store.ts`.
- [ ] 2.2 Add an append-only, token-guarded `action-evidence.jsonl` log with an ordered reader,
      mirroring `appendEvent` / `readLog`.
- [ ] 2.3 Extend the read-only status projection to include the process identity, the action-evidence
      timeline, and the watchdog/no-progress state — writing nothing.

## 3. Supervisor drive loop
- [ ] 3.1 Add `core/scripts/loop/supervisor.ts` with an injected `SupervisorDeps` seam composing the
      store, reconciliation (`reconcile`), recovery, pause, and a `pipeline/loop-execution@1` dispatch
      seam — no direct network/git/subprocess.
- [ ] 3.2 Implement the cycle: reconcile → select one dependency-ready active item (respect
      `max_active_items: 1` and dependency order) → dispatch via `pipeline/loop-execution@1` → record
      outcome through the engine transition/recovery/pause paths.
- [ ] 3.3 Refresh `heartbeat_at` and append one `action-evidence` entry per cycle; classify the cycle
      as progress vs. no-progress from the durable delta.
- [ ] 3.4 Enforce the run-level watchdog: after `consecutive_no_progress_limit` no-progress cycles,
      record the `supervisor_no_progress` stop and halt; reset the count on any progress cycle.
- [ ] 3.5 Terminate the loop at any terminal condition (all items done/abandoned, a stop record, a
      paused/waiting hold, a watchdog stop) and return a structured result.

## 4. Resume / takeover
- [ ] 4.1 Implement attach: acquire the lock, or — when the lock is held by a same-host dead pid —
      recover it through the store's provably-dead recovery path; refuse a live/cross-host holder by
      surfacing the holder and exiting with zero writes.
- [ ] 4.2 On resume, run a reconciliation pass before continuing and append a resume marker to the
      action-evidence trail; continue from the ledger's current position with no second
      run/lock/run-directory.
- [ ] 4.3 Refuse resume when the recorded contract/ledger schema id is outside the store's supported
      set, before any takeover.

## 5. CLI wiring & external-skill retirement
- [ ] 5.1 Wire `pipeline loop` in `core/scripts/pipeline.ts` to drive the supervisor for start/resume
      and render the audit report for `--audit`, replacing the external-skill delegation payload.
- [ ] 5.2 Replace `loop:contract-coherence`'s external goal-loop discovery in
      `core/scripts/loop-preflight.ts` with the in-repo durable loop store's schema-compatibility
      check; keep the read-only legacy-run import path intact.
- [ ] 5.3 Make `--audit` fully read-only: no ledger write, no lock acquisition, no `supervisor.json`
      write, no GitHub mutation.

## 6. Tests (each must bite without the change)
- [ ] 6.1 Drive-loop test: a run executes items via a fake `pipeline/loop-execution@1` seam to a
      terminal condition with zero real network/git/subprocess and no external-skill invocation.
- [ ] 6.2 Process-identity test: `supervisor.json` is written at attach and its heartbeat advances per
      cycle through the injected store seam.
- [ ] 6.3 Watchdog test: a spin scenario (no eligible item, no drift, no recovery) stops with
      `supervisor_no_progress` instead of looping; a progress cycle resets the count.
- [ ] 6.4 Action-evidence test: one ordered, append-only entry per cycle; sequence strictly increasing;
      no prior entry rewritten.
- [ ] 6.5 No-stage-verb / no-merge test: every stage transition originates in the advance state machine;
      the supervisor performs no merge; an out-of-set outcome is recorded `failed` and not re-dispatched.
- [ ] 6.6 Resume tests: dead-holder resume reconciles + continues with no second store; live-holder and
      cross-host-holder resume are refused with zero writes; schema-out-of-set resume is refused.
- [ ] 6.7 Audit test: renders identity/timeline/watchdog/position with zero durable writes; a run with
      no `supervisor.json` audits without error.
- [ ] 6.8 Preflight test: a host with no goal-loop skill installed starts and runs; no external-skill
      subprocess recorded on any path.

## 7. Mirror & CI
- [ ] 7.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 7.2 `npm run ci` green from root (includes `openspec validate --all`).
