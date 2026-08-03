## 1. Host overlay and profile

- [ ] 1.1 Add `hosts/opencode/SKILL.md` (OpenCode invocation `/pipeline`, inventory-symmetric with Claude/Codex; no plugin-marketplace requirement)
- [ ] 1.2 Add `core/profiles/opencode.json` with `implementer: "opencode"`, reviewer a registered non-opencode adapter (default `claude`), `invocation: "/pipeline"`
- [ ] 1.3 Ensure launcher/profile wiring accepts the new profile name without special-casing beyond existing profile load

## 2. Installer host target

- [ ] 2.1 Add `HOSTS.opencode` tree-mode entry: base via `OPENCODE_CONFIG_DIR` or `~/.config/opencode`, skills under `skills/pipeline`, profile `opencode`, overlay `hosts/opencode`
- [ ] 2.2 Extend `VALID_HOSTS`, usage header, unknown-host errors, and `--host all` selection/detection to include `opencode` (no Claude prerequisite)
- [ ] 2.3 Wire install/update to stage core + overlay + launcher + managed marker for OpenCode
- [ ] 2.4 Wire uninstall to remove OpenCode managed skill tree only (plus command cleanup in §3)
- [ ] 2.5 Ensure `--host opencode` never mutates Claude/Codex/Grok paths; dry-run writes nothing

## 3. Native OpenCode /pipeline command

- [ ] 3.1 Implement `installOpenCodeCommands` writing `<opencodeBase>/commands/pipeline.md` with absolute launcher path under the same base
- [ ] 3.2 Implement argv-safe argument bridge (design D3) so ordinary pipeline args reach the launcher without shell interpolation/loss
- [ ] 3.3 Ensure `--version` / `-V` routing yields the same version string as the installed launcher / `core/package.json` without embedding full SKILL.md instructional body
- [ ] 3.4 Implement uninstall cleanup of installer-owned `pipeline.md` only; preserve sibling command files
- [ ] 3.5 Honor `OPENCODE_CONFIG_DIR` for both skill and command paths (no hardcoded default when override is set)

## 4. Shadow detection

- [ ] 4.1 Apply personal-skill shadow detect + TTY/non-TTY relocation/skip policy to OpenCode tree installs (same marker contract as Claude/Codex)
- [ ] 4.2 Relocate backups under the OpenCode base; never silent-overwrite unmanaged trees

## 5. Discovery (non-breaking)

- [ ] 5.1 Confirm `pipeline path` / `--json` Claude/Codex `hostCoverage` meanings unchanged when OpenCode is present
- [ ] 5.2 Optionally add additive `hosts.opencode.available` (and path if cheap); do not break existing enum consumers

## 6. Documentation

- [ ] 6.1 Document `install --host opencode` in README: default paths, `OPENCODE_CONFIG_DIR`, version command expectation
- [ ] 6.2 Align installer help strings with implemented hosts including `opencode`

## 7. Tests and verification

- [ ] 7.1 Installer unit tests: OpenCode install layout, isolation from Claude/Codex, dry-run, update, uninstall command+skill cleanup, `OPENCODE_CONFIG_DIR`
- [ ] 7.2 Tests for version routing contract (`--version`/`-V` matches launcher / package.json; no full skill-instruction template on version path)
- [ ] 7.3 Tests for argv safety (spaces / metacharacters not shell-expanded) at the bridge boundary
- [ ] 7.4 Shadow-detection tests for personal OpenCode skill (accept/decline/non-TTY)
- [ ] 7.5 Run `openspec validate native-opencode-pipeline-host` (and `openspec validate --all` if required by gate)
- [ ] 7.6 Run `npm run ci` from repo root and fix until green
- [ ] 7.7 Spot-check proposal acceptance criteria against the landed diff
