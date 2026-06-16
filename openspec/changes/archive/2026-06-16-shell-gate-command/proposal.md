## Why

`test_gate.command` is tokenized by a custom `shellSplit()` function and passed directly to `runCapped(cmd, args, …)` — no shell is ever involved. Any operator that requires a shell (`&&`, `||`, `;`, pipes, redirects) is therefore passed as a literal argument to the first program, which fails with an opaque error (e.g. pnpm treating `&&` as a package spec). Every multi-step gate expression is broken today, making `test_gate.command` unusable for the most common real-world case: `pnpm install && pnpm test`. The `eval_gate` already runs correctly via `sh -c`; the test gate must be aligned.

## What Changes

- `core/scripts/testgate.ts` (`runTests` + caller): when `test_gate.command` is set in config, run it as `sh -c <command>` rather than tokenizing it with `shellSplit`. Auto-detected commands (no explicit `test_gate.command`) continue to use direct spawn via the existing `ParsedCommand` / `shellSplit` path.
- `core/test/testgate.test.ts`: add a regression test that configuring `test_gate.command` with `&&` (e.g. `true && true`) correctly runs through a shell and passes.
- `openspec/specs/test-gate-ci-parity/spec.md` (delta): the third requirement currently documents the whitespace-tokenization behavior as a hard constraint and advises the operator to use an npm script to wrap multi-step commands. That constraint SHALL be removed and replaced with a requirement that configured commands are run through a POSIX shell.

## Capabilities

### New Capabilities
_(none)_

### Modified Capabilities
- `test-gate-ci-parity`: the requirement that documents `test_gate.command` as whitespace-tokenized and advises single-token-only values must be updated; configured commands SHALL now be executed through a POSIX shell, making shell operators valid.

## Impact

- `core/scripts/testgate.ts` — narrow change to the configured-command branch (~5 lines); `shellSplit` is retained for auto-detected commands and existing tests.
- `core/test/testgate.test.ts` — one new regression test; existing `shellSplit` unit tests are unaffected.
- No state-machine, config schema, harness, or other stage changes.

## Acceptance Criteria

- [ ] Configuring `test_gate.command: "true && true"` (or any `&&`-chained command) in pipeline.yml causes the test gate to execute it through `sh -c` and report pass.
- [ ] Configuring `test_gate.command: "false || true"` causes the gate to report pass (shell OR semantics work).
- [ ] Configuring `test_gate.command: "npm run ci"` (single-token, existing pattern) continues to work exactly as before.
- [ ] Auto-detected commands (no explicit `test_gate.command`) continue to use the direct-spawn path and are unaffected.
- [ ] The `test-gate-ci-parity` spec no longer says compound operators must live inside an npm script; it says configured commands are run through a POSIX shell.
- [ ] `npm run ci` passes end-to-end (all tests green, mirror in sync).
