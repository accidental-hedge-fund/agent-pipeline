# core-mirror-sync Specification

## Purpose
TBD - created by archiving change fix-harness-regenerate-mirror. Update Purpose after archive.
## Requirements
### Requirement: Repo-local agent instructions SHALL direct harnesses to regenerate the plugin/ mirror after editing core/

Every repo-local context file read by an agent harness (`CLAUDE.md` at the repo root, `hosts/claude/SKILL.md`, and the Codex-host equivalent) SHALL contain an explicit instruction stating that after any edit to a file under `core/`, the harness SHALL run `node scripts/build.mjs` and include the regenerated `plugin/` directory in the same commit. When the pre-commit hook (`.githooks/pre-commit`) is active in a contributor's clone, the hook SHALL fulfill this instruction automatically; the harness instruction remains normative for agent contexts where git hooks do not run.

#### Scenario: Repo CLAUDE.md contains the mirror-regeneration instruction

- **WHEN** a human or agent reads the repo-root `CLAUDE.md`
- **THEN** the document SHALL contain a directive that unambiguously states: run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror after editing `core/`

#### Scenario: Claude Code SKILL.md contains the mirror-regeneration instruction

- **WHEN** the Claude Code harness loads `hosts/claude/SKILL.md` before executing an implementation or fix step
- **THEN** the file SHALL contain the same directive so that Claude Code receives the instruction regardless of whether it reads the repo-root CLAUDE.md first

#### Scenario: Codex-host context file contains the mirror-regeneration instruction

- **WHEN** the Codex harness loads its per-host context file (e.g., `hosts/codex/AGENTS.md`) before executing an implementation or fix step
- **THEN** the file SHALL contain the same directive so that Codex receives the instruction

#### Scenario: Harness edits core/ and regenerates mirror in the same commit

- **WHEN** an agent harness edits any file under `core/` in response to the instruction
- **THEN** the harness SHALL run `node scripts/build.mjs` before committing
- **AND** the resulting commit SHALL include both the `core/` changes and the updated `plugin/` files

#### Scenario: pre-commit hook fulfills the instruction for human contributors

- **WHEN** a human contributor has activated the hook via `npm run setup-hooks` and stages a `core/` edit
- **THEN** the pre-commit hook SHALL run `node scripts/build.mjs` and stage the regenerated mirror automatically
- **AND** the harness instruction in `CLAUDE.md`/`SKILL.md` remains in place for agent contexts where hooks do not execute

#### Scenario: test-gate backstop remains the deterministic safety net

- **WHEN** a harness commit edits `core/` but omits the regenerated `plugin/` mirror
- **THEN** `npm run ci` (which runs `build.mjs --check`) SHALL still detect and fail on the stale mirror
- **AND** the bounded fix loop SHALL self-heal the omission as before

