## Why

When a user migrates from the older personal `~/.claude/skills/pipeline` install to the `pipeline@ahf-tools` plugin, the two installs collide as duplicate `/pipeline` skills — Claude Code picks up everything in the skills scan directory. Today `scripts/install.mjs` prints a prose tip ("Tip: removing a duplicate plugin install…") but never checks whether a pre-existing personal install exists; migrating users end up with two `/pipeline` entries or — as happened in a real case — a backup (`pipeline.proven-bak`) placed inside `~/.claude/skills/`, which also loads as a second skill.

## What Changes

- `scripts/install.mjs install --host claude` gains a **shadow-detection check** that runs after the existing prereq check but before the copy step. If `<skillsDir>/pipeline` already exists and is **not** the target being written by this installer, a non-blocking warning is emitted.
- The warning offers to **relocate** the pre-existing directory to `<claudeBase>/pipeline.<timestamp>.bak` (outside the skills scan dir) so it is preserved but no longer loaded.
- Relocation is **non-destructive**: never overwrites an existing backup; picks a unique name if needed.
- If the user declines (or the environment is non-interactive), install proceeds and the warning names the exact command to relocate later.
- All paths honor `CLAUDE_CONFIG_DIR` via the existing `claudeBase()` helper — no hardcoding.
- README "Claude Code — plugin marketplace" section references the detection rather than only prose-instructing manual removal.
- Unit tests cover detection, safe relocation (no-clobber, unique-name), and `CLAUDE_CONFIG_DIR` override.

## Capabilities

### New Capabilities

- `installer-shadow-detection`: Detect a pre-existing `~/.claude/skills/pipeline` personal install during `install --host claude`, warn the user, and offer safe non-destructive relocation to a backup path outside the skills scan directory.

### Modified Capabilities

_(none — no existing spec-level behavior changes)_

## Impact

- **`scripts/install.mjs`**: new detection + interactive relocation logic (~50–80 lines), integrated into the existing prereq-check flow.
- **`README.md`**: minor prose update in the "Claude Code — plugin marketplace" section.
- **`scripts/install.test.mjs`** (new or extended): unit tests for the new logic.
- **No breaking changes** — detection is non-blocking; install always proceeds.
- **No runtime dependencies added** — Node builtins only (`fs`, `os`, `readline`).
