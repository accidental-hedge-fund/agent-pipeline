## MODIFIED Requirements

### Requirement: Repo-local agent instructions SHALL direct harnesses to regenerate the plugin/ mirror after editing core/

Every repo-local context file read by an agent harness (`CLAUDE.md` at the repo root, `hosts/claude/SKILL.md`, and the Codex-host equivalent) SHALL contain an explicit instruction stating that after any edit to a file under `core/`, the harness SHALL run `node scripts/build.mjs` so `build.mjs --check` can assert SKILL overlay and marketplace catalog freshness. The instruction SHALL NOT tell harnesses to commit a `plugin/` copy of `core/scripts` as the forever rule. The product install path is the CLI plus host SKILL. When the pre-commit hook (`.githooks/pre-commit`) is active in a contributor's clone, the hook SHALL fulfill the SKILL/catalog freshness instruction automatically; the harness instruction remains normative for agent contexts where git hooks do not run. Whole-tree deletion of `plugin/` is #1050.

#### Scenario: Repo CLAUDE.md contains the mirror-regeneration instruction

- **WHEN** a human or agent reads the repo-root `CLAUDE.md`
- **THEN** the document SHALL contain a directive to run `node scripts/build.mjs` after editing `core/` so `--check` can assert SKILL/catalog freshness
- **AND** SHALL NOT state that a `plugin/` core copy must always be committed as the forever rule

#### Scenario: Claude Code SKILL.md contains the mirror-regeneration instruction

- **WHEN** the Claude Code harness loads `hosts/claude/SKILL.md` before executing an implementation or fix step
- **THEN** the file SHALL contain the same directive so that Claude Code receives the instruction regardless of whether it reads the repo-root CLAUDE.md first

#### Scenario: Codex-host context file contains the mirror-regeneration instruction

- **WHEN** the Codex harness loads its per-host context file (e.g., `hosts/codex/AGENTS.md`) before executing an implementation or fix step
- **THEN** the file SHALL contain the same directive so that Codex receives the instruction

#### Scenario: Harness edits core/ and regenerates mirror in the same commit

- **WHEN** an agent harness edits any file under `core/` in response to the instruction
- **THEN** the harness SHALL run `node scripts/build.mjs` before committing
- **AND** the resulting commit SHALL include SKILL/catalog freshness outputs when the generator still writes them
- **AND** SHALL NOT add a new `plugin/` copy of `core/scripts`

#### Scenario: pre-commit hook fulfills the instruction for human contributors

- **WHEN** a human contributor has activated the hook via `npm run setup-hooks` and stages a `core/` edit
- **THEN** the pre-commit hook SHALL run `node scripts/build.mjs`
- **AND** SHALL NOT stage a `plugin/` core copy as required output
- **AND** the harness instruction in `CLAUDE.md`/`SKILL.md` remains in place for agent contexts where hooks do not execute

#### Scenario: test-gate backstop remains the deterministic safety net

- **WHEN** a harness commit leaves the generated SKILL overlay or marketplace catalog stale
- **THEN** `npm run ci` (which runs `build.mjs --check`) SHALL still detect and fail on that staleness
- **AND** the bounded fix loop SHALL self-heal the omission as before
- **AND** `--check` SHALL NOT fail solely because `plugin/` has no byte-identical core tree
