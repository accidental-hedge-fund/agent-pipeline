## Why

Outbound Buzz ship notifications fail silently. During the v1.39.0 ship (2026-08-14), a flaky relay returned repeated `502 Bad Gateway` responses; critical posts (`#599` stage-done → pre-merge blocked; train → failed) never reached the channel even though on-disk dedupe files claimed they were sent. The shared helper (`examples/supervisor/shell/ship-notify.sh`) discards `buzz messages send` exit status and stderr (`|| true` / `exit 0`), so a blocked issue or failed ship can sit for hours with zero Buzz signal. Operators need failed deliveries to be logged, retried for transient faults, and visible to the supervisor without turning notify into a ship-blocking gate.

## What Changes

- Make `ship-notify.sh` capture `buzz messages send` exit status and stderr instead of masking them.
- Retry failed sends with bounded backoff (default: 3 attempts, e.g. 5s / 15s / 45s) before giving up — transient 502s match the observed failure class.
- On final failure, write a supervisor-visible audit/marker artifact under the notify state dir (timestamp + reason/stderr summary) so humans and outer supervisors can see missed posts.
- Keep process exit code **0** after final failure (notify remains best-effort; ship/train MUST NOT block on messenger delivery).
- Keep the success path unchanged: exit 0, no spam when there is nothing to post, no-op when Buzz is not configured.
- Keep dedupe semantics: write dedupe key as today; `--force` still bypasses TTL dedupe and MUST NOT mask send errors.
- Add regression fixtures (fake `BUZZ_BIN`) proving: transient 502 then success → one post + success audit; all attempts fail → audit + marker, exit 0.
- Document the observability contract in supervisor/ship runbook notes only as needed for operators (install path still the shared example binary).

## Capabilities

### New Capabilities

- `supervisor-ship-notify`: Shared host-side ship status notifier contract — capture/retry Buzz send failures, audit successful and failed delivery, supervisor-visible final-failure markers, best-effort exit behavior, force/dedupe rules, and regression fixtures for transient vs permanent send failure.

### Modified Capabilities

- (none) — Tugboat / playbook / stage-watch continue to invoke the same sibling helper; their phase contracts do not change. Delivery observability is owned by the shared notify helper so every caller inherits the class fix.

## Acceptance criteria

- [ ] With a fixture `buzz messages send` that fails twice (e.g. exit non-zero / 502-class stderr) then succeeds on the third attempt, `ship-notify.sh` posts exactly once and records a successful delivery audit entry under the notify state root.
- [ ] With a fixture that fails every attempt within the retry budget, `ship-notify.sh` writes an audit log line (timestamp + reason) and a supervisor-visible failure marker under the notify state root, and the process still exits 0.
- [ ] On-disk dedupe behavior is unchanged for normal keys within TTL (same content + key → no second send); stage posts and callers that pass keys are unaffected in success cases.
- [ ] `--force` bypasses TTL dedupe and still surfaces send failures (audit/marker on final failure; does not swallow stderr/status).
- [ ] When `SHIP_NOTIFY=0` or Buzz is not configured (`BUZZ_BIN` / channel / credentials missing), the helper still no-ops with exit 0 and does not invent failure markers.
- [ ] Successful sends leave no final-failure marker for that attempt; empty message still exits 0 without posting.
- [ ] Notify failure never blocks Tugboat / ship-playbook / train phase progression solely because Buzz delivery failed (best-effort: exit 0 after exhaustion).
- [ ] Automated tests cover the transient-success and permanent-failure fixtures; `openspec validate ship-notify-failure-observability` and `npm run ci` are green.

## Impact

- **Primary surface:** `examples/supervisor/shell/ship-notify.sh` (shared install binary for Tugboat, ship playbook, stage-watch, Hermes Option 1 path).
- **Callers (no API change expected):** `tugboat.sh`, `pipeline-ship-playbook.sh`, `ship-stage-watch.sh` — they keep invoking the sibling helper; observability improves under the same argv/env contract.
- **State dir:** under `PIPELINE_SUPERVISOR_STATE` / `notify/` — existing dedupe files plus new audit log and/or failure marker files.
- **Tests:** new or extended `core/test/` coverage driving the shell helper with a fake `BUZZ_BIN` (pattern matches `ship-stage-watch.test.ts`).
- **Docs:** brief operator note in supervisor/ship runbook if needed (where to look when Buzz is silent).
- **Out of scope:** new state machine; ship/train hard-fail on notify; MessagingPort/Slack product path; changing dedupe TTL defaults; engine stage gates on delivery; second notify binary.

## Class vs site (engine / ship-path dogfood)

| Question | Answer |
|----------|--------|
| Class vs site? | **Class:** host-side messenger adapters that treat local bookkeeping (dedupe file write) as proof of remote delivery and swallow send errors. **Site:** `ship-notify.sh` is the single shared adapter all Option 1 ship composers use. |
| Shared surface? | Fix the shared helper once — Tugboat, playbook, and stage-watch inherit. Do not special-case one composer. |
| Next identical fault? | Transient relay 502s retry; permanent failures leave audit + marker under the known state dir so the next silent channel does not require a new mole issue to rediscover masking. |
