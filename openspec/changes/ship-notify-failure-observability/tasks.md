## 1. Helper behavior (ship-notify.sh)

- [x] 1.1 Update `examples/supervisor/shell/ship-notify.sh` header docs: retry defaults, audit/marker paths, optional env (`SHIP_NOTIFY_MAX_ATTEMPTS`, backoff override for tests/production).
- [x] 1.2 Capture messenger send exit status and stderr (or truncated reason) per attempt; remove the silent `|| true` / discard-only path as the sole failure handling.
- [x] 1.3 Implement bounded retry loop (default 3 attempts) with default backoff 5s/15s/45s and env override that can zero sleeps for tests.
- [x] 1.4 On success: append success audit line under `$STATE_ROOT/notify/`; clear any key-scoped final-failure marker for that attempt if present; exit 0.
- [x] 1.5 On final failure: append failure audit line (timestamp + reason); write supervisor-visible marker under notify state dir; exit 0.
- [x] 1.6 Preserve existing dedupe file format/TTL, `--force` bypass, empty-message no-op, `SHIP_NOTIFY=0` no-op, and unconfigured Buzz no-op (no invented failure markers when messenger is not configured).

## 2. Regression tests

- [x] 2.1 Add `core/test/ship-notify.test.ts` spawning the helper with temp `PIPELINE_SUPERVISOR_STATE` and a fake executable `BUZZ_BIN` (call counter + scripted exit codes); zero/near-zero backoff via env.
- [x] 2.2 Fixture: fail twice then succeed → three send invocations, success audit, no final-failure marker, exit 0.
- [x] 2.3 Fixture: fail all attempts → failure audit + marker, exit 0, attempt count equals budget.
- [x] 2.4 Fixture: TTL dedupe suppresses second identical send; `--force` still attempts send and surfaces failure artifacts when the fake always fails.
- [x] 2.5 Fixture: unconfigured / `SHIP_NOTIFY=0` / empty message → exit 0, no send, no invented failure marker.
- [x] 2.6 Ensure the fail-all fixture would fail if audit/marker writing were removed (prove the regression bites).
- [x] 2.7 Fixture: unwritable audit/marker targets after fail-all send → exit 0 with stderr persistence fallback (best-effort observability).
- [x] 2.8 Fixture: unusable `PIPELINE_SUPERVISOR_STATE` with fail-all sends → exit 0; messenger still attempted; stderr notes state/persistence failure.

## 3. Docs and operator notes

- [x] 3.1 Brief note in `docs/runbooks/ship-milestone.md` and/or `docs/supervisor.md` / `examples/supervisor/README.md`: on quiet Buzz, check `notify/audit.log` and failure markers under `PIPELINE_SUPERVISOR_STATE`.
- [x] 3.2 Note post-merge reinstall of `ship-notify` from `examples/supervisor/shell/` into `~/.local/bin` (same sibling install loop as Tugboat).

## 4. Validate and CI

- [x] 4.1 Run `openspec validate ship-notify-failure-observability` (and fix any structural issues).
- [x] 4.2 Run targeted `core` tests for ship-notify (and related if touched).
- [x] 4.3 If any `core/` files changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change when required.
- [x] 4.4 Run `npm run ci` from repo root and leave green.
