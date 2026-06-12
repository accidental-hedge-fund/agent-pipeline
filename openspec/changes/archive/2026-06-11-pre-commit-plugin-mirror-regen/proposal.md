## Why

Manually running `node scripts/build.mjs` and re-staging `plugin/` after every `core/` edit is the #1 source of wasted CI/review rounds in this repo — roughly 13 of the last 14 functional commits required it. A local pre-commit hook can detect the affected paths, run the regeneration automatically, and stage the outputs before the commit lands, removing the manual step entirely while leaving `build.mjs --check` as the authoritative enforcement gate.

## What Changes

- Add `.githooks/pre-commit`: a shell script that, when staged paths include `core/` or `hosts/claude/`, runs `node scripts/build.mjs` and stages `plugin/` and `.claude-plugin/marketplace.json`. Commits that touch only unrelated paths (e.g., README, docs) skip the hook body entirely.
- Add `npm run setup-hooks` script (`package.json` + `scripts/setup-hooks.mjs`) that sets `git config core.hooksPath .githooks` and prints a one-line confirmation, so contributors can wire the hook with a single command.
- Add a one-line note to `README.md` (contributor setup section) pointing to `npm run setup-hooks`.

## Capabilities

### New Capabilities

- `pre-commit-mirror-regen`: A local pre-commit hook that auto-regenerates and stages the `plugin/` mirror whenever a commit touches `core/` or `hosts/claude/`, plus a setup script to wire it.

### Modified Capabilities

- `core-mirror-sync`: The existing spec's requirement that harnesses manually run `build.mjs` is augmented: when the pre-commit hook is active, the mirror MUST be staged automatically; the hook MUST NOT stage unrelated working-tree changes.

## Impact

- New: `.githooks/pre-commit` (shell), `scripts/setup-hooks.mjs` (Node.js).
- Modified: `package.json` (new `setup-hooks` script entry), `README.md` (contributor note).
- No changes to `core/`, `plugin/`, the state machine, CLI, config, or runtime behavior.
- CI behavior unchanged: `build.mjs --check` remains the enforcement gate.
