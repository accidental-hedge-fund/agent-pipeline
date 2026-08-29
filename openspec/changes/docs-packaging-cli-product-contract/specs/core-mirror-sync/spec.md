## ADDED Requirements

### Requirement: Repo-root golden rule 1 SHALL name CLI plus SKILL as the product until the mirror is retired

Repo-root `AGENTS.md` and `CLAUDE.md` golden rule #1 SHALL state that the product is the `pipeline` CLI plus a short host SKILL. Those files SHALL NOT present “always commit the regenerated `plugin/` core mirror” as the forever packaging rule. Until issue #1048 lands, golden rule #1 or the immediately following sentence SHALL state that `node scripts/build.mjs --check` still applies. This requirement SHALL NOT rewrite host `SKILL.md` files (issue #1049).

#### Scenario: AGENTS.md golden rule 1 is product-first

- **WHEN** a contributor reads repo-root `AGENTS.md` golden rule #1
- **THEN** the rule SHALL name CLI plus SKILL as the product
- **AND** it SHALL state that `build.mjs --check` still applies until #1048
- **AND** it SHALL NOT say always commit `plugin/` as the forever rule

#### Scenario: CLAUDE.md stays in sync

- **WHEN** a contributor reads repo-root `CLAUDE.md` golden rule #1
- **THEN** the rule SHALL match `AGENTS.md` on CLI plus SKILL as the product
- **AND** it SHALL carry the same transitional `build.mjs --check` until #1048 sentence

## MODIFIED Requirements

### Requirement: Repo-local agent instructions SHALL direct harnesses to regenerate the plugin/ mirror after editing core/

Until issue #1048 lands, repo-local agent instructions SHALL still direct a harness that edits `core/` to run `node scripts/build.mjs` and include the regenerated `plugin/` directory in the same commit, or SHALL state that `build.mjs --check` still applies. Repo-root `AGENTS.md` and `CLAUDE.md` SHALL present that instruction as a transitional CI gate, not as the forever product rule. Host `SKILL.md` files MAY keep the existing mirror-regeneration wording in this slice. When the pre-commit hook (`.githooks/pre-commit`) is active in a contributor's clone, the hook SHALL fulfill regeneration automatically; the harness instruction remains normative for agent contexts where git hooks do not run.

#### Scenario: Repo CLAUDE.md contains the mirror-regeneration instruction

- **WHEN** a human or agent reads the repo-root `CLAUDE.md`
- **THEN** the document SHALL contain a directive that unambiguously states: run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror after editing `core/`, or that `build.mjs --check` still applies until #1048
- **AND** that directive SHALL be presented as transitional, not as the forever product rule

#### Scenario: Claude Code SKILL.md contains the mirror-regeneration instruction

- **WHEN** the Claude Code harness loads `hosts/claude/SKILL.md` before executing an implementation or fix step
- **THEN** the file SHALL still contain a mirror-regeneration directive so that Claude Code receives the instruction regardless of whether it reads the repo-root CLAUDE.md first
- **AND** this slice SHALL NOT rewrite that SKILL.md file

#### Scenario: Codex-host context file contains the mirror-regeneration instruction

- **WHEN** the Codex harness loads its per-host context file (e.g., `hosts/codex/AGENTS.md`) before executing an implementation or fix step
- **THEN** the file SHALL contain the same directive so that Codex receives the instruction
- **AND** this slice SHALL NOT rewrite host SKILL.md files

#### Scenario: Harness edits core/ and regenerates mirror in the same commit

- **WHEN** an agent harness edits any file under `core/` in response to the instruction
- **THEN** the harness SHALL run `node scripts/build.mjs` before committing
- **AND** the resulting commit SHALL include both the `core/` changes and the updated `plugin/` files until #1048 retires that gate

#### Scenario: pre-commit hook fulfills the instruction for human contributors

- **WHEN** a human contributor has activated the hook via `npm run setup-hooks` and stages a `core/` edit
- **THEN** the pre-commit hook SHALL run `node scripts/build.mjs` and stage the regenerated mirror automatically
- **AND** the harness instruction in `CLAUDE.md`/`SKILL.md` remains in place for agent contexts where hooks do not execute

#### Scenario: test-gate backstop remains the deterministic safety net

- **WHEN** a harness commit edits `core/` but omits the regenerated `plugin/` mirror
- **THEN** `npm run ci` (which runs `build.mjs --check`) SHALL still detect and fail on the stale mirror until #1048 retires that gate
- **AND** the bounded fix loop SHALL self-heal the omission as before
