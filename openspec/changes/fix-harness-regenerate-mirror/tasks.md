## 1. Add mirror-regeneration instruction to per-host context files

- [ ] 1.1 Verify that `CLAUDE.md` (repo root) already contains golden rule #1 with the `node scripts/build.mjs` directive — confirm it is present and no edit is required
- [ ] 1.2 Add a prominent instruction block to `hosts/claude/SKILL.md` stating: after editing any file under `core/`, run `node scripts/build.mjs` and include the regenerated `plugin/` in the same commit
- [ ] 1.3 Add the same instruction block to `hosts/codex/SKILL.md` so the Codex harness receives the directive

## 2. Regenerate mirror and verify CI

- [ ] 2.1 Run `node scripts/build.mjs` to regenerate `plugin/` from the updated `hosts/claude/SKILL.md` (host additions are included in the mirror)
- [ ] 2.2 Run `npm run ci` from repo root and confirm all checks pass (core tests, mirror-in-sync check, install smoke)

## 3. Commit

- [ ] 3.1 Commit `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and the regenerated `plugin/` together with a message referencing #75
