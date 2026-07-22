## 1. Durable loop store (`durable-loop-store`)

- [ ] 1.1 Create `core/scripts/loop/` and define the `LoopStoreDeps` seam (filesystem, clock,
      pid liveness, hostname, uuid), mirroring `AdvanceReviewDeps` / `ShaGateDeps` conventions.
- [ ] 1.2 Implement state-home resolution (Pipeline override → XDG → home default) and the run
      directory layout; define the native `pipeline/loop-contract@1` and
      `pipeline/loop-ledger@1` schema ids as single-sourced constants.
- [ ] 1.3 Implement atomic document writes (temp file → flush → rename) and append-only log
      writes for events and decisions.
- [ ] 1.4 Implement the event log with in-memory next-sequence tracking (no whole-file re-read
      per append) preserving dense 0-based sequencing; emit a stop event exactly once.
- [ ] 1.5 Implement the decision log.
- [ ] 1.6 Implement the read-only status projection (run id, engine, repo, canonical hash, item
      states, active items, budgets, consecutive-blocked, barrier, stop, lock + staleness, last
      reconcile, event count) with a zero-write guarantee.
- [ ] 1.7 Tests: layout, precedence, atomicity under simulated mid-write failure, append-only
      guarantee, dense sequencing, single stop event, status-is-read-only, unknown-run failure.

## 2. Locking (`durable-loop-store`)

- [ ] 2.1 Implement exclusive-create lock acquisition returning the holder record + token.
- [ ] 2.2 Implement token-required mutation guards, release, and lock status.
- [ ] 2.3 Implement staleness classification: same host + dead pid → stale; same host + live pid
      → not stale; different host → never stale. No time-based TTL.
- [ ] 2.4 Implement recovery: refuse a non-stale lock without explicit force; remove rather than
      transfer; emit a recovery event naming the previous holder and reason; invalidate the old
      token.
- [ ] 2.5 Tests: race produces one holder, token mismatch refused with holder named, read-only
      ops need no token, dead-pid recovery, cross-host never auto-recovered, old token invalid
      after recovery.

## 3. Contract compilation and dependency ordering (`durable-loop-engine`)

- [ ] 3.1 Define the discovery input type and validate required keys (repo name + base branch,
      selector, snapshot items); refuse missing keys as validation failures.
- [ ] 3.2 Apply documented defaults for objective, worktree policy, done definition, recovery
      budgets, stop limit, verification block, report format.
- [ ] 3.3 Fix the orchestration invariants on the compiled contract (dependency-aware sequential
      ordering, max one active item, exclusive-lock single-engine advance) irrespective of input.
- [ ] 3.4 Implement deterministic dependency ordering: topological with a documented tie-break,
      duplicate ids refused, cycles refused, out-of-snapshot deps dropped.
- [ ] 3.5 Implement the Pipeline-native canonical hash (sorted keys, compact separators, UTF-8
      preserved, `engine` and the hash field excluded from the hashed body).
- [ ] 3.6 Implement run initialization: refuse an existing run directory as a conflict directing
      the caller to resume; seed the ledger; emit the initialization event.
- [ ] 3.7 Tests: missing-key refusals, default application, invariants not caller-settable,
      ordering determinism + stability, cycle/duplicate refusal, dropped dangling dep,
      cross-engine identical hash, re-init conflict leaves the run untouched.

## 4. Ledger, transition graph, gates, recovery, stops, barrier (`durable-loop-engine`)

- [ ] 4.1 Encode the transition graph as data and enforce it; `deployed` and `abandoned` have no
      outgoing edges.
- [ ] 4.2 Append history entries recording time, from, to, acting engine (from the lock holder),
      and any theme, evidence, or note. Require a theme on every transition into blocked and
      persist it as the item's blocked theme.
- [ ] 4.3 Implement the four authority grants derived only from discovery's explicit grants,
      their transition mapping, and the authority-class refusal; refuse unknown grant names at
      compile time.
- [ ] 4.4 Require non-empty evidence on every gated transition and record it verbatim.
- [ ] 4.5 Implement recovery-budget charging on `blocked → in_progress` (theme key with default
      fallback), terminal stop on exhaustion, and the global stop guard refusing every later
      transition.
- [ ] 4.6 Implement consecutive-blocked counting, the stop on exceeding the limit, and the reset
      rule (forward progress only — not on entering `in_progress`).
- [ ] 4.7 Implement the merge barrier: set on `→ merged` with the SHA, refuse every `→ in_progress`
      while set, emit set/cleared events.
- [ ] 4.8 Tests: table-driven over all ordered state pairs (legal accepted, illegal refused),
      terminal states, theme requirement, authority refusals + no widening by objective, evidence
      requirement, budget charge/exhaustion, stopped-run refusal, consecutive-blocked stop and
      reset semantics, barrier set/block/clear.

## 5. Evidence mandates including native-`/goal` parity (`durable-loop-engine`)

- [ ] 5.1 Implement the Agent Pipeline execution mandate at its three points (preflight evidence
      on `→ in_progress`, `pipeline:ready-to-deploy` stage on `→ ready`, pipeline-merge marker +
      SHA on `→ merged`) with its own failure class.
- [ ] 5.2 Implement the native autonomous goal-mode evidence validator: engine match, run-id
      match, `active` status, timestamp parse, and the 300-second freshness window in either
      direction; own failure class with the documented corrective action.
- [ ] 5.3 Enforce the mandate on every entry to `in_progress` (including resume from `blocked`)
      and on lock acquisition over a run with an in-progress item, before the lock is created.
- [ ] 5.4 Record accepted native-goal evidence on the item history and as the run's last
      native-goal check; emit the resume-check event; expose it in status.
- [ ] 5.5 Confirm read-only operations and non-`in_progress` transitions stay ungated.
- [ ] 5.6 Keep the #506 native-`/goal` *capability probe* (`checkNativeGoalCapability`) distinct
      from this *evidence mandate* — separate call sites, separate failure classes, no merging.
- [ ] 5.7 Tests: each mandate refusal, both freshness directions, wrong engine/run/status,
      lock-acquisition gating with zero writes on refusal, ungated read-only paths.

## 6. Reconciliation (`durable-loop-engine`)

- [ ] 6.1 Accept a caller-supplied observed-truth document; make no GitHub or subprocess call.
- [ ] 6.2 Report item-state drift without mutating item states; ignore items absent on either
      side.
- [ ] 6.3 Record the observation with a monotonic sequence number and time; emit the event.
- [ ] 6.4 Clear the merge barrier only when the truth reports a base commit and includes the
      barrier's merged SHA; emit the cleared event carrying the old barrier.
- [ ] 6.5 Tests: drift reported not applied, zero external calls through the seams, unmatched
      items ignored, sequence monotonicity, barrier clears only on both conditions.

## 7. Facade repoint and external-check retirement (`pipeline-loop-facade`)

- [ ] 7.1 Rewrite `runLoopCommand` (`core/scripts/pipeline.ts`) to execute the run through the
      in-repo engine instead of printing a hand-off selector; keep `--audit` write-free.
- [ ] 7.2 Wire per-item dispatch through the existing `pipeline/loop-execution@1` contract
      (`core/scripts/loop-execution-contract.ts`); normalize unrecognized outcomes to `failed`
      with no silent re-dispatch. Contract meaning is unchanged.
- [ ] 7.3 Delete `discoverGoalLoop`, `goalLoopDiscoveryRoots`, `checkLoopContractCoherence`,
      `GOAL_LOOP_SUPPORTED_CONTRACT_SCHEMAS`, `GOAL_LOOP_SUPPORTED_LEDGER_SCHEMAS` and the
      `state.py` regex reader from `core/scripts/loop-preflight.ts`.
- [ ] 7.4 Replace them with the in-repo store schema-compatibility check and keep the fixed
      preflight order: normalize → store compatibility → native-goal capability → compile.
- [ ] 7.5 Rewire `core/scripts/stages/doctor.ts` to the new check; a missing goal-loop install
      must no longer fail doctor.
- [ ] 7.6 Leave argument normalization (`normalizeLoopArgs`, `MAX_RANGE_SPAN`) and the #506
      capability probe untouched, including the selector-free `--audit` bypass.
- [ ] 7.7 Tests: run with no goal-loop installed anywhere, zero-goal-loop-subprocess assertion,
      doctor passes without the install, preflight order + zero mutation on each failure,
      `--audit` zero-write, existing `loop-command.test.ts` / `loop-preflight.test.ts`
      expectations updated only where the requirement genuinely changed.

## 8. Legacy import and migration window (`goal-loop-run-import`)

- [ ] 8.1 Implement legacy root resolution (`GOAL_LOOP_STATE_HOME` → XDG → home default),
      read-only, consulted only on a native-store miss or for migration reporting.
- [ ] 8.2 Validate legacy schema ids against the supported set (`goal-loop/contract@2`, `@3`,
      `goal-loop/ledger@2`); refuse others naming found and supported ids, with no partial import.
- [ ] 8.3 Refuse import when the legacy lock is live on this host or recorded on another host,
      and when a superseded marker already exists — with zero writes on every refusal.
- [ ] 8.4 Translate contract + ledger + event log + decision log into the native schemas under
      the same run id, preserving item states, history, blocked themes, budgets,
      consecutive-blocked, barrier, last reconcile, stop, last native-goal check, and log
      ordering/sequence. Preserve the legacy `canonical_hash` verbatim and record its provenance.
- [ ] 8.5 Write the single superseded marker into the legacy run directory (the only legacy write).
- [ ] 8.6 Report importable and non-terminal legacy run counts in preflight diagnostics; passing
      with none present.
- [ ] 8.7 Capture real goal-loop `@2` and `@3` run fixtures under `core/test/fixtures/` and add
      replay tests; assert byte-identical legacy documents before and after import and exactly
      one legacy write through the seam.

## 9. Docs, mirror, and verification

- [ ] 9.1 Update `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`: the loop section describes
      an in-repo engine, drops the goal-loop install prerequisite, and states the legacy-run
      import path and migration window.
- [ ] 9.2 Update `README.md` where the loop's external dependency is described.
- [ ] 9.3 `grep -rn "goal-loop" core/ hosts/` and confirm the only remaining references are the
      import module, its fixtures/tests, and documentation of the migration path.
- [ ] 9.4 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` in the same change.
- [ ] 9.5 `openspec validate absorb-goal-loop-core --strict` passes.
- [ ] 9.6 `npm run ci` passes from the repo root.
- [ ] 9.7 Record a bounded live `pipeline:loop` run on a host with no goal-loop installed as
      evidence for the acceptance criteria.
