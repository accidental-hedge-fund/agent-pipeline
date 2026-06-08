## Context

The test gate (`core/scripts/testgate.ts`) already supports an explicit `test_gate.command` override in `.github/pipeline.yml`. When set, the gate runs that command verbatim (via `shellSplit` + direct process spawn) instead of auto-detecting from the package manifest. The `&&`-chained syntax is already handled by `shellSplit`. No logic changes are needed in testgate.ts — this change is entirely configuration, documentation, and test coverage.

The incident: #45's implementation passed `npm test` locally, but CI also runs `node scripts/build.mjs --check` (plugin mirror sync). The mirror was stale. The gate didn't catch it because auto-detection only finds the `test` script.

## Goals / Non-Goals

**Goals:**
- Set `test_gate.command` in this repo's `.github/pipeline.yml` so the gate runs the same steps as CI.
- Add documentation (README + inline pipeline.yml comment) making the CI-parity pattern explicit for operators.
- Add a regression test proving the gate blocks when a compound command's non-test CI step fails.

**Non-Goals:**
- Auto-discovering CI commands from `.github/workflows/*.yml` files (would couple the gate to GHA syntax; out of scope).
- Changing testgate.ts logic — the existing mechanism is correct.
- Handling generated-artifact regeneration inside the harness (the gate's existing post-pass dirty check already catches uncommitted generated files; no new behavior needed there).

## Decisions

**Decision: Fix via config, not code.**
The `test_gate.command` field exists precisely for this case. Adding auto-GHA-discovery would be complex and fragile (matrix jobs, conditional steps, `uses:` actions). The operator-configured approach keeps the gate simple and explicit. Rationale: a one-line config change is easier to review, easier to roll back, and immediately verifiable.

**Decision: Wrap all CI steps in a single `npm run ci` script, not a raw `&&` chain.**
`test_gate.command` is whitespace-tokenized and spawned without a shell (no `sh -c`), so a raw `&&` in the config value would be treated as a literal argument rather than a shell operator. Wrapping the full CI command sequence (`npm test && node scripts/build.mjs --check && npm run ci:install-smoke`) in a single `npm run ci` script keeps the config value a single token and preserves short-circuit semantics via the npm script runner. This is the correct approach for any multi-step CI command.

**Decision: Regression test targets the compound-command failure path.**
The test should verify that a `test_gate.command` of form `<passing-cmd> && <failing-cmd>` causes the gate to block. This precisely models the stale-mirror scenario: the first command (npm test) passes but the second (build.mjs --check) fails. The existing test harness in `testgate.test.ts` already mocks process spawning, so the new test case is a thin addition.

## Risks / Trade-offs

- **Config drift risk:** If CI changes its command sequence, `.github/pipeline.yml` must be manually updated. Mitigation: the README note and inline comment remind operators to keep `test_gate.command` in sync with CI.
- **Shell operator parsing:** `&&` works; pipes and more complex shell syntax are not supported by `shellSplit` without a shell invocation. Mitigation: `runTests` in testgate.ts already falls through to `sh -c` for compound commands — verify this is the case; if not, note it as a follow-up.
