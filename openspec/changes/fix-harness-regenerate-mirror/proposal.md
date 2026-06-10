## Why

Every core-editing harness round (implementation, fix, test-fix) reliably burns one extra fix-loop attempt recovering from a stale `plugin/` mirror — because the agent edits `core/` but does not regenerate the mirror, and the `build.mjs --check` gate then fails. The maintainer's simplest fix is a repo-local instruction in CLAUDE.md/AGENTS.md telling agent harnesses to run `node scripts/build.mjs` and commit the mirror immediately after editing `core/`.

## What Changes

- `CLAUDE.md` (repo-root, checked-in) gains an explicit instruction: after any edit to `core/`, run `node scripts/build.mjs` and include the regenerated `plugin/` in the same commit.
- `hosts/claude/SKILL.md` and `hosts/codex/AGENTS.md` (or equivalent per-host context files) gain the same instruction so all host variants carry the hint.
- No new pipeline code or config keys are introduced (zero-machinery per maintainer decision).
- The existing `build.mjs --check` test-gate backstop is unchanged.

## Capabilities

### New Capabilities
- `core-mirror-sync`: Requirement that repo-local agent-harness instructions (CLAUDE.md / AGENTS.md / SKILL.md) include a directive to regenerate the `plugin/` mirror and commit it after editing `core/`.

### Modified Capabilities
<!-- No existing spec-level behavior changes. -->

## Impact

- `CLAUDE.md` at repo root — instruction added.
- `hosts/claude/SKILL.md` — instruction added (per-host context file read by Claude Code harness).
- `hosts/codex/AGENTS.md` or equivalent — instruction added (per-host context file read by Codex harness).
- `openspec/specs/core-mirror-sync/spec.md` — new living spec created.
- No changes to `core/scripts/`, `plugin/`, or any pipeline runtime logic.
