## Why

When agent-pipeline's fix/implementation stages edit `core/` source without regenerating the `plugin/` mirror, the in-pipeline test gate (auto-detected as `npm test`) does not catch the staleness — only CI's `node scripts/build.mjs --check` step does. This means mirror staleness escapes the bounded fix loop and triggers a `blocked: CI failed` + manual regen-and-recover cycle at the pre-merge stage. The `test_gate.command` override capability was built in #48/#49 specifically for this class of problem; agent-pipeline must apply it to its own `.github/pipeline.yml`.

## What Changes

- Set `test_gate.command: "npm run ci"` in `.github/pipeline.yml` so the gate runs the full CI surface.
- Add a `ci` script to `package.json` that chains `npm test`, `node scripts/build.mjs --check`, and the install smoke test — matching all steps in `.github/workflows/ci.yml`.
- Document the "set `test_gate.command` when CI does more than `npm test`" pattern in the README.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `test-gate-ci-parity`: Add a requirement that the `ci` npm script executed by `test_gate.command` MUST cover all three CI steps (unit tests, build-mirror check, install smoke), and add a scenario demonstrating that a stale `plugin/` mirror is caught by the test gate — not at CI.

## Impact

- `.github/pipeline.yml` — `test_gate.command` field added.
- `package.json` — `ci` script added.
- `README.md` — "Matching CI" guidance added under the test/build gate section.
- No API surface changes, no breaking changes for other repos.
