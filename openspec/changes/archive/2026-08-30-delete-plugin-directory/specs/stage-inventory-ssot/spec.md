## REMOVED Requirements

### Requirement: Generated Claude SKILL overlay SHALL carry the shared compact one-pager

**Reason:** The transitional plugin SKILL overlay is deleted with `plugin/`. The four generated host SKILLs already carry the compact one-pager.

**Migration:** Compact verb/follow contract remains on `hosts/claude/SKILL.md` and its byte-identical peers via `generated-short-host-skill`. `build.mjs --check` asserts those host SKILLs without a plugin overlay.

## ADDED Requirements

### Requirement: Host SKILL regeneration SHALL NOT write a plugin overlay

After `hosts/claude/SKILL.md` is regenerated from `renderHostSkill()`, `node scripts/build.mjs` SHALL NOT write a plugin SKILL overlay. CI's `node scripts/build.mjs --check` gate SHALL pass without a `plugin/` tree. The compact one-pager SHALL remain on the four generated host SKILLs.

#### Scenario: Host skill update does not recreate plugin/

- **WHEN** `hosts/claude/SKILL.md` is regenerated as the compact one-pager
- **THEN** `node scripts/build.mjs` SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md`
- **AND** `node scripts/build.mjs --check` SHALL pass while `plugin/` is absent
