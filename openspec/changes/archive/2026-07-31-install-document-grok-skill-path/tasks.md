## 1. Documentation (required)

- [x] 1.1 Add a README subsection for Grok Build skill layout: preferred symlink (`~/.grok/skills/pipeline` → Claude skill path / `CLAUDE_CONFIG_DIR`), copy as secondary option with update trade-off, and explicit not-first-class-host (or accurate `--host grok` description if stretch lands)
- [x] 1.2 Document reinstall/update follow-up: after Claude skill update, re-create the Grok symlink or re-run the documented Grok install command
- [x] 1.3 Place the Grok subsection after the primary Claude/Codex quickstart so it does not block newcomers

## 2. Installer help (required)

- [x] 2.1 Update `scripts/install.mjs` usage header comment so host guidance acknowledges Grok consumers (documented layout and/or `--host grok` if implemented) without claiming unimplemented hosts
- [x] 2.2 Update unknown-`--host` / no-host-detected error text to point at the documented Grok layout when `grok` is not a first-class host, or list `grok` when it is
- [x] 2.3 Add or extend installer tests that assert help/error strings stay consistent with implemented `--host` values and mention the Grok path when required

## 3. Doctor symlink invariant (required)

- [x] 3.1 Confirm install-root resolution for `install:version-coherence` / `install:version-freshness` when the skill is reached via a symlink to a managed install; add an explicit realpath (or equivalent) only if current code would mis-report
- [x] 3.2 Add a regression test (doctor unit test with injectable paths, or install-smoke adjacent) that a symlink entry into a coherent managed tree still passes version-coherence and does not fail freshness solely due to the symlink

## 4. Stretch: `--host grok` (optional)

- [x] 4.1 Add `HOSTS.grok` targeting `~/.grok/skills` with install behavior that symlinks `pipeline` to the Claude-managed skill dir when present
- [x] 4.2 Fail closed with remediation when Claude-managed skill is missing (no silent divergent copy without guidance)
- [x] 4.3 Include `grok` in valid-host usage, parseArgs acceptance, and detection messaging; do not add `hosts/grok/SKILL.md` unless the host hard-requires it
- [x] 4.4 Unit-test `--host grok` create/refresh symlink, missing-Claude failure, and idempotent re-run
- [x] 4.5 If stretch ships, align README Grok subsection with `--host grok` commands

## 5. Verification

- [x] 5.1 Run targeted tests for installer help and doctor symlink coverage
- [x] 5.2 Run `openspec validate install-document-grok-skill-path` (or `openspec validate --all` if that is the repo gate) and fix structural issues
- [x] 5.3 Run `npm run ci` from repo root and ensure green
- [x] 5.4 Spot-check acceptance criteria from `proposal.md` against the landed diff
