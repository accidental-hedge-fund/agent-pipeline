## 1. Handoff contract and pure formatting

- [x] 1.1 Define the early handoff payload type (fields: `schema_version`, `kind`, `run_id`, `run_dir`, `events`, `engine`, `resumed`, optional `selector`) and a pure formatter that returns one JSON line with `kind: "loop_run_handoff"` — no I/O in the formatter.
- [x] 1.2 Resolve absolute `run_dir` and `events` via existing loop store helpers (`runDir` / events path under `resolveStateHome`), never relative to cwd.
- [x] 1.3 Add a small stdout write+flush helper (or injectable seam) so the handoff line is flushed for piped consumers; keep it testable without a real long-running supervisor.

## 2. Engine / supervisor emit seam

- [x] 2.1 Thread an `onRunReady` (or equivalent) callback through `defaultRunLoopEngine` / supervisor attach so it fires once after exclusive lock acquisition and before any `dispatchItem` call.
- [x] 2.2 Pass enough context into the callback (`runId`, absolute paths, engine, `resumed`, selector when known) for the CLI formatter; do not print from the store layer.
- [x] 2.3 Ensure lock/init/selector/config failure paths never invoke `onRunReady`; `--audit` never invokes it.

## 3. CLI surface (`runLoopCommand`)

- [x] 3.1 In `runLoopCommand`, wire the handoff: on `onRunReady`, format and flush the `loop_run_handoff` JSON to stdout before the engine await completes its first dispatch.
- [x] 3.2 Keep the existing terminal drive summary JSON unchanged in required keys; ensure it never uses `kind: "loop_run_handoff"`.
- [x] 3.3 Optionally print a brief human stderr line pointing at `run_id` / events path (operator aid only — not the machine contract).
- [x] 3.4 Confirm preflight failure still exits non-zero with remediation, zero durable writes beyond existing contracts, and no handoff JSON.

## 4. Host packaging

- [x] 4.1 Update the `pipeline:loop` command documentation source so multi-item durable drive is not described as “completes in seconds” / “No Monitor needed.”
- [x] 4.2 Document that a successful drive emits early handoff JSON (`run_id` + absolute `events` path) for progress follow; keep Claude and Codex packaging aligned.
- [x] 4.3 Leave full skill orchestration rewrite (#668) out of this change.

## 5. Tests

- [x] 5.1 Unit/CLI test: successful fresh drive emits exactly one stdout JSON object with `kind: "loop_run_handoff"` and required fields before the first mocked dispatch.
- [x] 5.2 Unit/CLI test: `--resume` path emits handoff with `resumed: true` before first dispatch of that process.
- [x] 5.3 Unit/CLI test: preflight failure and lock-held failure emit no `loop_run_handoff` and preserve non-zero exit / zero durable mutation contracts.
- [x] 5.4 Unit/CLI test: `--audit` emits no handoff and remains read-only.
- [x] 5.5 Prove the primary regression bites without the fix (only terminal `run_id` after supervisor completion fails the “before first dispatch” assertion).
- [x] 5.6 All new tests use dependency seams — no real network, git, or subprocess.

## 6. Verify and mirror

- [x] 6.1 Run core tests for the touched suites; fix failures.
- [x] 6.2 If `core/` or host packaging changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [x] 6.3 Run `npm run ci` from repo root until green (`ci:core`, `build.mjs --check`, install smoke, `openspec validate --all`).
