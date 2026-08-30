# core-mirror-sync Specification

## Purpose

Define the single-source packaging and generated-artifact freshness contract after retirement of the committed `plugin/` core mirror.
## Requirements
### Requirement: Repo-local agent instructions SHALL require SKILL/catalog freshness after core edits

Every repo-local contributor context file read by an agent harness (`AGENTS.md` and `CLAUDE.md`) SHALL state that after editing a file under `core/`, the harness SHALL run `node scripts/build.mjs` so `build.mjs --check` can assert generated SKILL overlay and marketplace catalog freshness. The instruction SHALL NOT tell harnesses to commit a `plugin/` copy of `core/scripts`. The product install path is the CLI plus a short host SKILL. Whole-tree deletion of the remaining `plugin/` shell is #1050. Generated host SKILLs SHALL NOT be required to repeat that contributor essay; they MAY point at `docs/packaging.md`.

When the pre-commit hook (`.githooks/pre-commit`) is active, it SHALL fulfill the same SKILL/catalog freshness instruction automatically. After `node scripts/build.mjs`, it SHALL stage by exact path the four generated host SKILLs, `plugin/pipeline/skills/pipeline/SKILL.md`, and `.claude-plugin/marketplace.json`. It SHALL preserve the existing narrow-staging and unstaged/untracked-input guards. The written harness instruction remains normative when hooks do not run.

#### Scenario: Repo context names the freshness command

- **WHEN** a human or agent reads repo-root `AGENTS.md` or `CLAUDE.md`
- **THEN** the document SHALL direct contributors to run `node scripts/build.mjs` after editing `core/`
- **AND** SHALL describe `build.mjs --check` as a SKILL/catalog freshness gate
- **AND** SHALL NOT require a committed `plugin/` core copy

#### Scenario: Host context carries the same instruction

- **WHEN** a harness loads a generated host SKILL
- **THEN** the SKILL SHALL NOT be required to contain the `build.mjs` contributor essay
- **AND** SHALL NOT describe `plugin/` as a byte-identical engine mirror
- **AND** `AGENTS.md` / `CLAUDE.md` SHALL still carry the freshness instruction

#### Scenario: Harness edits core and refreshes generated outputs

- **WHEN** an agent harness edits any file under `core/`
- **THEN** the harness SHALL run `node scripts/build.mjs` before committing
- **AND** the commit SHALL include changed SKILL/catalog outputs when the generator writes them
- **AND** SHALL NOT add a new `plugin/` copy of `core/scripts`

#### Scenario: Pre-commit hook fulfills the instruction

- **WHEN** a contributor has activated the hook via `npm run setup-hooks` and stages a `core/` edit
- **THEN** the hook SHALL run `node scripts/build.mjs`
- **AND** SHALL stage `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, `hosts/opencode/SKILL.md`, `plugin/pipeline/skills/pipeline/SKILL.md`, and `.claude-plugin/marketplace.json`
- **AND** SHALL stage no unrelated `hosts/` or `plugin/` path
- **AND** SHALL NOT stage a `plugin/` core copy as required output

#### Scenario: Hook tests cover every generated host output

- **WHEN** the isolated pre-commit fixture runs after a generator-input edit
- **THEN** its stub generator SHALL write all four host SKILL outputs
- **AND** the committed-file assertion SHALL prove all four exact paths were staged
- **AND** a non-owned host or plugin working-tree change SHALL remain unstaged

#### Scenario: Test gate remains the deterministic backstop

- **WHEN** a commit leaves any of the four host SKILLs, the generated plugin SKILL, or marketplace catalog stale
- **THEN** `npm run ci` (which runs `build.mjs --check`) SHALL fail on that staleness
- **AND** the bounded fix loop SHALL receive the failure for repair
- **AND** `--check` SHALL NOT fail solely because `plugin/` has no byte-identical core tree

#### Scenario: Eval boundaries account for the same exact outputs

- **WHEN** an eval fixture allows a source path that can change `renderHostSkill` output and runs `build.mjs` or `npm run ci`
- **THEN** generated-packaging accounting SHALL require all affected host SKILL paths by exact name
- **AND** it SHALL NOT accept a broad `hosts/` or `plugin/` allowance in place of those paths

### Requirement: Repo-root golden rule SHALL name CLI plus SKILL as the product

Repo-root `AGENTS.md` and `CLAUDE.md` golden rule #1 SHALL state that the product is the `pipeline` CLI plus a short host SKILL. Those files SHALL NOT present a generated `plugin/` core mirror or a per-verb command pack as the product.

#### Scenario: AGENTS.md golden rule is product-first

- **WHEN** a contributor reads repo-root `AGENTS.md` golden rule #1
- **THEN** the rule SHALL name CLI plus SKILL as the product
- **AND** SHALL NOT require committing a `plugin/` core mirror

#### Scenario: CLAUDE.md stays in sync

- **WHEN** a contributor reads repo-root `CLAUDE.md` golden rule #1
- **THEN** the rule SHALL match `AGENTS.md` on CLI plus SKILL as the product
- **AND** SHALL describe the remaining build gate as SKILL/catalog freshness

