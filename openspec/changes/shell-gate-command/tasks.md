## 1. Fix testgate.ts — run configured command through a shell

- [ ] 1.1 In `testgate.ts`, change the configured-command branch (line ~180) from `shellSplit(cfg.test_gate.command)` to `{ cmd: "sh", args: ["-c", cfg.test_gate.command] }` so it no longer pre-tokenizes the operator-supplied string.
- [ ] 1.2 Update `runTests()` call (or its `ParsedCommand` construction) so the `sh -c` invocation goes through `runCapped("sh", ["-c", shellCmd], …)` — matching the pattern eval gate uses — and the label logged to console stays the raw configured command string (not `sh -c …`).

## 2. Regression test

- [ ] 2.1 Add a test in `testgate.test.ts` that sets `cfg.test_gate.command` to `"true && true"` and verifies the gate reports pass (proves `&&` is interpreted by a shell, not passed as a literal arg).
- [ ] 2.2 Add a test that sets `cfg.test_gate.command` to `"false && true"` and verifies the gate reports failure (first step exits non-zero, short-circuits).
- [ ] 2.3 Verify that the existing `runTests` unit tests (direct-spawn path with a `ParsedCommand`) continue to pass unmodified — confirm auto-detection is unaffected.

## 3. Validate spec delta

- [ ] 3.1 Run `openspec validate shell-gate-command` and fix any structural errors until it reports clean.

## 4. Mirror + CI

- [ ] 4.1 `node scripts/build.mjs` to regenerate `plugin/`.
- [ ] 4.2 `npm run ci` green from repo root before marking done.
