## Why

The `buildFixPrompt` and `buildTestFixPrompt` builders omit the `conventions` key that every other code-editing prompt builder injects via `readConventions`. This means fix and test-fix editing rounds receive repo conventions only through best-effort host auto-load (Claude's headless CLAUDE.md; Codex's `-C` flag), making conventions delivery to the most correction-sensitive step implicit and host-dependent rather than explicit and uniform.

## What Changes

- `fix.md` gains a `{{conventions}}` placeholder (mirroring `implementing.md`).
- `test_fix.md` gains a `{{conventions}}` placeholder.
- `buildFixPrompt` passes `conventions: readConventions(cfg)` in the interpolation map.
- `buildTestFixPrompt` passes `conventions: readConventions(cfg)` in the interpolation map.
- `implementing.md` line 15 is updated to name the profile-appropriate conventions file (CLAUDE.md / AGENTS.md) instead of hardcoding only "CLAUDE.md", so the instruction is accurate under the Codex profile.
- `hosts/codex/SKILL.md` per-repo-config example uses `AGENTS.md` (or omits the filename) instead of `CLAUDE.md`.
- Unit tests assert that `buildFixPrompt` and `buildTestFixPrompt` embed the injected conventions content; the tests bite without the fix.

## Capabilities

### New Capabilities

- `fix-prompt-conventions-injection`: The fix and test-fix harness prompts SHALL embed the target repo's conventions via the same `readConventions` → `{{conventions}}` mechanism already used by the implementing prompt, making conventions delivery to every code-editing step explicit and host-independent.

### Modified Capabilities

- `cross-host-profiles`: The `implementing.md` conventions instruction and the Codex SKILL.md per-repo-config example SHALL name the profile-appropriate conventions filename (CLAUDE.md or AGENTS.md) rather than hardcoding CLAUDE.md only.

## Impact

- `core/scripts/prompts/index.ts` — `buildFixPrompt` and `buildTestFixPrompt` builders.
- `core/scripts/prompts/fix.md` and `test_fix.md` — new `{{conventions}}` placeholder.
- `core/scripts/prompts/implementing.md` line 15 — conventions filename reference.
- `hosts/codex/SKILL.md` — per-repo-config example.
- `core/test/prompts.test.ts` (or adjacent test file) — two new regression test cases.
- `plugin/` mirror regenerated after any `core/` edit.
- No config schema change; no change to `readConventions` logic.
