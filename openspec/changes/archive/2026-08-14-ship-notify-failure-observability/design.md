## Context

See `proposal.md` for motivation (silent Buzz failures during v1.39.0 ship).

**Current helper** (`examples/supervisor/shell/ship-notify.sh`):

1. Optional disable via `SHIP_NOTIFY=0`.
2. Normalize message; optional TTL dedupe under `$PIPELINE_SUPERVISOR_STATE/notify/<key>` (default TTL 120s); `--force` rewrites the key and skips TTL check.
3. No-op exit 0 when `BUZZ_BIN` / channel / credentials are missing.
4. On send: `set +e`; run `buzz messages send … >/dev/null 2>&1 || true`; always `exit 0`.

**Bug class:** dedupe file is written **before** send. Local bookkeeping looks successful even when the relay never accepted the message. Stderr and exit status are discarded.

**Callers:** Tugboat, ship playbook, stage-watch — all use the sibling binary. Fix once in the shared helper.

**Constraints:**

- Notify is best-effort; ship/train MUST NOT fail solely because Buzz failed.
- No second state machine or MessagingPort product path.
- Tests may spawn the shell script with a fake `BUZZ_BIN` (same pattern as `ship-stage-watch.test.ts`); unit tests must not hit a real relay.
- Installed host copy under `~/.local/bin/ship-notify` is refreshed from repo examples (existing install-parity story).

## Goals / Non-Goals

**Goals:**

- Capture send exit status and a short stderr/reason string.
- Retry transient failures with bounded backoff before giving up.
- Persist an append-only audit trail and a final-failure marker the supervisor can see.
- Preserve success, no-op, and dedupe behavior.
- Prove behavior with fixture binaries under `npm run ci`.

**Non-Goals:**

- Changing ship phase order or blocking ship on notify.
- Replacing Buzz with another messenger.
- Guaranteeing at-least-once delivery after process kill mid-retry (best-effort only).
- Rewriting dedupe TTL policy or key format.
- Auto-posting a second channel from the marker (supervisor may notice and act later; out of scope to invent a second notifier).

## Decisions

### D1: Fix the shared shell helper in place (not a new binary)

**Decision:** Edit `examples/supervisor/shell/ship-notify.sh` only. Keep argv `ship-notify.sh "<message>" [dedupe-key] [--force]` and existing env vars. Add optional env for retry tuning (`SHIP_NOTIFY_MAX_ATTEMPTS`, `SHIP_NOTIFY_BACKOFF_S` or fixed defaults documented in the header).

**Alternatives:**

- New `ship-notify-v2.sh` → rejected; dual install path diverges from single-helper rule.
- Engine TypeScript port → rejected; notify is host-side optional; shell is the install unit.

### D2: Bounded retry with fixed backoff schedule

**Decision:** Default **3 attempts**. Sleep **5s, 15s, 45s** between attempts (after failure, before next try). Success on any attempt stops the loop and records success audit. Exhaustion → failure audit + marker, exit 0.

Backoff may be shortened in tests via env (e.g. `SHIP_NOTIFY_BACKOFF_S="0 0 0"` or `SHIP_NOTIFY_RETRY_SLEEP=0`) so CI does not wait 65s.

**Rationale:** Observed fault was multi-minute relay flakiness; three tries with increasing delay cover short 502 windows without multi-minute hangs on every permanent failure.

**Alternatives:**

- Infinite retry → can hang ship detach loops.
- Immediate three tries with no sleep → fails under brief gateway blips.
- Exit non-zero on final failure → **BREAKING** for callers that treat any non-zero as phase failure; rejected by issue non-goal.

### D3: Audit log + final-failure marker under existing state root

**Decision:** Under `$STATE_ROOT/notify/`:

| Artifact | Role |
|----------|------|
| Existing `<key_safe>` | Dedupe only (epoch + tab + content). Unchanged format. |
| `audit.log` (append) | One line per terminal outcome: ISO/epoch timestamp, status (`ok` / `fail`), attempt count, optional key, truncated reason/stderr. |
| `failed/<key_or_anon>-<epoch>` or `failed.notice` | Supervisor-visible marker for final failure (content + reason). Exact filename shape is implementation detail as long as it is under `notify/` and durable. |

On success: append `ok` audit; do not leave a sticky failure marker for that attempt (optional: remove key-scoped failure marker if present).

**Rationale:** Operators already look at `PIPELINE_SUPERVISOR_STATE`. An append-only log survives multiple ships; a marker is greppable by outer supervisors.

**Alternatives:**

- stderr only → lost when callers discard output.
- Dedupe file encodes success → couples dedupe to delivery; harder to reason about force/TTL.

### D4: Capture stderr per attempt; do not print spam to caller stdout

**Decision:** Redirect each attempt’s stdout/stderr to a temp or variable. On intermediate failure, log attempt to audit or only keep last reason for the final line. Do not stream full Buzz noise to the caller unless `SHIP_NOTIFY_VERBOSE=1` (optional). Final process exit remains 0.

### D5: Dedupe timing stays pre-send

**Decision:** Keep writing the dedupe file **before** the send attempts (current behavior). Rationale: concurrent stage-watch heartbeats must still coalesce; re-sending every retry window after a failed post is desirable only when the key TTL expires or `--force` is used. Document that a failed send still “consumes” the dedupe slot for that content+key within TTL — operators use `--force` or wait TTL to retry the same key. Final-failure marker compensates so silence is not invisible.

**Alternative:** Write dedupe only after success → can amplify duplicate posts under concurrent callers; rejected for stage-watch spam risk.

### D6: Regression tests via fake `BUZZ_BIN`

**Decision:** Add `core/test/ship-notify.test.ts` that:

1. Creates a temp state root and a small executable fake that fails N times then succeeds (or always fails), logging calls to a counter file.
2. Invokes `bash examples/supervisor/shell/ship-notify.sh` with env pointing at the fake and zero/near-zero backoff.
3. Asserts: call count, audit line presence, marker presence/absence, exit 0, dedupe file shape.

Static assert: script body MUST NOT contain the old mask pattern as the sole send path (`|| true` swallowing without audit) — or assert positive presence of retry/audit markers.

### D7: Class-over-site

**Decision:** Do not patch Tugboat or playbook to special-case Buzz. The class is “shared messenger adapter masks delivery.” All composers inherit from the helper. Docs may one-line “check `notify/audit.log` / `notify/failed*` if channel is quiet.”

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Retry sleep slows ship heartbeats | Cap attempts; allow zero backoff in tests; default schedule only on real failures |
| Dedupe-before-send means failed post is not auto-retried by next identical stage line within TTL | Failure marker + `--force` + TTL expiry; document |
| Host still runs old `~/.local/bin/ship-notify` | Existing install-parity / runbook reinstall loop; PR notes post-merge install |
| Large stderr fills disk | Truncate reason (e.g. 500 chars) in audit/marker |
| Callers that grepped silent success assume no files | New files only under `notify/`; additive |

## Migration Plan

1. Land helper + tests in repo.
2. Operator hosts reinstall `ship-notify` from `examples/supervisor/shell/` (same loop as Tugboat siblings).
3. No schema migration; old dedupe files remain valid.
4. Rollback: reinstall previous helper binary; delete optional new audit/marker files if desired.

## Open Questions

None that block specs or tasks. Exact audit line field separator and marker filename template are left to implementation as long as scenarios remain falsifiable.
