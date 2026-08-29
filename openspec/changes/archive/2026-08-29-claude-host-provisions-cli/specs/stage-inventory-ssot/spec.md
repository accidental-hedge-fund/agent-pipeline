## REMOVED Requirements

### Requirement: Plugin mirror SHALL carry the Claude host stage inventory

**Reason:** Issue #1048 retires the plugin core mirror while retaining the generated Claude SKILL overlay.

**Migration:** Regenerate and commit the Claude SKILL overlay after host inventory changes; `build.mjs --check` no longer requires a copied core tree.

## ADDED Requirements

### Requirement: Generated Claude SKILL overlay SHALL carry the host stage inventory
After the Claude host SKILL stage inventory is updated, the generated plugin SKILL overlay SHALL be regenerated with `node scripts/build.mjs` and committed in the same change so the remaining plugin shell receives the corrected inventory. CI's `build.mjs --check` gate SHALL pass without a copied core tree.

#### Scenario: SKILL overlay check passes after host skill update
- **WHEN** `hosts/claude/SKILL.md` is updated for stage inventory alignment
- **THEN** `node scripts/build.mjs` SHALL be run and the regenerated `plugin/` content committed with the same change
- **AND** `node scripts/build.mjs --check` SHALL pass
