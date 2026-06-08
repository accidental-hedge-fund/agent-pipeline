## Context

The pipeline's test gate resolves its command via a priority chain (see README): explicit `test_gate.command` → auto-detected `test`/`build` script → language-default. Auto-detection finds `npm test`; it does not inspect the `test` script body or discover sibling CI steps. Agent-pipeline's CI (`.github/workflows/ci.yml`) runs three discrete steps that must all pass before a PR is safe:

1. `npm test` — unit tests (core + install smoke)
2. `node scripts/build.mjs --check` — verifies `plugin/` mirror is in sync with `core/`
3. Install smoke test (`node scripts/ci-install-smoke.mjs`)

Without an explicit `test_gate.command`, only step 1 runs inside the bounded fix loop. Steps 2 and 3 are invisible to the gate and only surface at pre-merge CI.

## Goals / Non-Goals

**Goals:**

- Gate command on agent-pipeline covers all three CI steps.
- A stale `plugin/` mirror causes a test-gate failure, not a CI failure.
- A single npm script wraps all steps so `test_gate.command` stays a single token (the command is tokenized without shell semantics — `&&` would not work in the config value).

**Non-Goals:**

- Changing auto-detection defaults for other repos.
- Auto-regenerating the `plugin/` mirror after `core/` edits (a distinct future improvement).
- Changing which steps CI runs.

## Decisions

### Wrap all CI steps in `npm run ci` rather than a shell one-liner

`test_gate.command` is whitespace-tokenized and spawned without a shell. Compound operators (`&&`, `;`) must therefore live inside a script, not in the config value. An npm `ci` script is the natural wrapper: it's already a common convention, it's discoverable via `npm run`, and the content mirrors `.github/workflows/ci.yml` exactly — making CI-gate parity mechanical to verify.

Alternatives considered:
- A dedicated shell script (`scripts/ci.sh`): adds a file, less conventional.
- Setting `test_gate.command` to multiple tokens (`"npm test node scripts/build.mjs --check"`): not supported; only the first token is the executable.

### Keep the `ci` script as a sequential chain in `package.json`

`npm test && node scripts/build.mjs --check && npm run ci:install-smoke` is the authoritative sequence. Storing it in `package.json` means `npm run ci` and the CI workflow are maintained in the same place; drift between them is visible in a single diff.

## Risks / Trade-offs

- [Risk] The `ci` script's constituent steps could silently drift from the CI workflow. → Mitigation: The spec requires the `ci` script to match CI; review of any `ci.yml` change must also update the script.
- [Risk] The install smoke test adds latency to every in-pipeline test run. → Accepted: the smoke test is fast (< 10 s) and its failure mode (broken install) is exactly the kind of thing the gate should catch.
