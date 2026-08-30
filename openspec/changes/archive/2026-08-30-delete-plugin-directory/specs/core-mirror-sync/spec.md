## REMOVED Requirements

### Requirement: Repo-local agent instructions SHALL require SKILL/catalog freshness after core edits

**Reason:** After #1050, generated packaging outputs are the four host SKILLs. The old requirement identity still names a plugin SKILL overlay and marketplace catalog that sourced `plugin/`.

**Migration:** Repo-local instructions require host-SKILL freshness after core edits and forbid writing or committing `plugin/`.

## ADDED Requirements

### Requirement: Repo-local agent instructions SHALL require host-SKILL freshness after core edits

Every repo-local contributor context file read by an agent harness (`AGENTS.md` and `CLAUDE.md`) SHALL state that after editing a file under `core/`, the harness SHALL run `node scripts/build.mjs` so `build.mjs --check` can assert generated host SKILL freshness. The instruction SHALL NOT tell harnesses to commit a `plugin/` tree or a `plugin/` copy of `core/scripts`. The product install path is the CLI plus a short host SKILL. Generated host SKILLs SHALL NOT be required to repeat that contributor essay; they MAY point at `docs/packaging.md`.

When the pre-commit hook (`.githooks/pre-commit`) is active, it SHALL fulfill the same host-SKILL freshness instruction automatically. After `node scripts/build.mjs`, it SHALL stage by exact path the four generated host SKILLs. It SHALL NOT stage any `plugin/` path. It SHALL preserve the existing narrow-staging and unstaged/untracked-input guards. The written harness instruction remains normative when hooks do not run.

#### Scenario: Repo context names the freshness command

- **WHEN** a human or agent reads repo-root `AGENTS.md` or `CLAUDE.md`
- **THEN** the document SHALL direct contributors to run `node scripts/build.mjs` after editing `core/`
- **AND** SHALL describe `build.mjs --check` as a generated host SKILL freshness gate
- **AND** SHALL NOT require a committed `plugin/` tree

#### Scenario: Host context carries the same instruction

- **WHEN** a harness loads a generated host SKILL
- **THEN** the SKILL SHALL NOT be required to contain the `build.mjs` contributor essay
- **AND** SHALL NOT describe `plugin/` as a remaining generated overlay
- **AND** `AGENTS.md` / `CLAUDE.md` SHALL still carry the freshness instruction

#### Scenario: Harness edits core and refreshes generated outputs

- **WHEN** an agent harness edits any file under `core/`
- **THEN** the harness SHALL run `node scripts/build.mjs` before committing
- **AND** the commit SHALL include changed host SKILL outputs when the generator writes them
- **AND** SHALL NOT add a `plugin/` path

#### Scenario: Pre-commit hook fulfills the instruction

- **WHEN** a contributor has activated the hook via `npm run setup-hooks` and stages a `core/` edit
- **THEN** the hook SHALL run `node scripts/build.mjs`
- **AND** SHALL stage `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` when those outputs changed
- **AND** SHALL stage no `plugin/` path
- **AND** SHALL stage no unrelated `hosts/` path

#### Scenario: Hook tests cover every generated host output

- **WHEN** the isolated pre-commit fixture runs after a generator-input edit
- **THEN** its stub generator SHALL write all four host SKILL outputs
- **AND** the committed-file assertion SHALL prove all four exact paths were staged
- **AND** a plugin or non-owned host working-tree change SHALL remain unstaged

#### Scenario: Test gate remains the deterministic backstop

- **WHEN** a commit leaves any of the four host SKILLs stale
- **THEN** `npm run ci` (which runs `build.mjs --check`) SHALL fail on that staleness
- **AND** the bounded fix loop SHALL receive the failure for repair
- **AND** `--check` SHALL NOT fail solely because `plugin/` is absent

#### Scenario: Eval boundaries account for the same exact outputs

- **WHEN** an eval fixture allows a source path that can change `renderHostSkill` output and runs `build.mjs` or `npm run ci`
- **THEN** generated-packaging accounting SHALL require all affected host SKILL paths by exact name
- **AND** it SHALL NOT accept a broad `hosts/` or `plugin/` allowance in place of those paths
