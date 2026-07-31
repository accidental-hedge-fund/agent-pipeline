## Why

Grok Build users already consume agent-pipeline by symlinking
`~/.grok/skills/pipeline` → `~/.claude/skills/pipeline`, but the installer only
documents and installs `--host claude|codex|all`. That Grok layout is
undocumented, easy to break on reinstall (Claude update replaces the target;
nothing re-creates the Grok link), and operators cannot tell from README or
install help whether Grok is supported. Doctor and version checks must stay
correct when the skill path is a symlink to the Claude-managed core.

## What Changes

- Document the **supported Grok skill layout** in the README and installer help:
  preferred symlink (`~/.grok/skills/pipeline` → Claude install), optional copy,
  and that Grok is **not** a first-class host overlay (no `hosts/grok` SKILL.md
  fork required for this change).
- Keep install help (`scripts/install.mjs` header usage and `--host` error text)
  accurate about supported hosts and the Grok layout.
- **Stretch (in scope if low-cost):** add first-class `--host grok` that installs
  into `~/.grok/skills/pipeline` (symlink to the Claude-managed core when
  present, otherwise a shared/core staging path consistent with installer
  conventions), includes `grok` in host selection/detection messaging, and
  updates usage strings accordingly. Still no full Grok-specific SKILL.md fork
  unless the host requires it.
- Preserve doctor `install:version-coherence` and `install:version-freshness`
  behavior when the active skill path is a symlink to a managed install (same
  core package path / version as the real target).

## Acceptance criteria

- [ ] README documents the supported Grok layout: symlink
      `~/.grok/skills/pipeline` → Claude skill install is preferred; a copy of the
      skill tree is an acceptable alternative.
- [ ] README states that Grok is not a first-class installer host overlay
      (or, if `--host grok` ships, states what that target does and that there is
      still no separate `hosts/grok` SKILL.md fork).
- [ ] Installer help / usage (header comment and unknown-`--host` error text)
      document or point to the Grok layout; they no longer imply only Claude and
      Codex consumers exist without mentioning Grok.
- [ ] After a Claude reinstall/update, documented steps (or automated
      `--host grok` if implemented) let an operator restore the Grok skill path
      without reverse-engineering paths from source.
- [ ] When `~/.grok/skills/pipeline` is a symlink to a managed Claude install,
      `pipeline doctor` still reports correct `install:version-coherence` and
      `install:version-freshness` against that same core (no false mismatch
      solely because the entry path is a symlink).
- [ ] **Stretch:** `node scripts/install.mjs install --host grok` creates or
      refreshes `~/.grok/skills/pipeline` (symlink to Claude core or shared
      staging) and `grok` appears in host detection / usage lists.
- [ ] No full Grok-specific SKILL.md fork unless required by the host.
- [ ] `npm run ci` passes.

## Capabilities

### New Capabilities

- `grok-skill-path`: Supported ways Grok Build consumers obtain the pipeline
  skill (documented symlink/copy layout; optional installer `--host grok`);
  doctor correctness when the skill path is a symlink to a managed install.

### Modified Capabilities

- `readme-user-clarity`: README must document the Grok skill layout and host
  status accurately alongside Claude/Codex install paths.

## Impact

- **Docs / UX:** `README.md` install section; `scripts/install.mjs` usage header
  and `--host` error / detection messaging.
- **Optional installer:** `scripts/install.mjs` `HOSTS` table and related tests
  (`scripts/install.test.mjs` or equivalent) if stretch `--host grok` lands.
- **Doctor:** No intentional behavior change; regression coverage that symlink
  entry paths still resolve to the same install root for version checks
  (`core/scripts/stages/doctor.ts` / doctor tests as needed).
- **Out of scope:** Full Grok host overlay (`hosts/grok`), Grok-only SKILL.md
  fork, changing Claude/Codex install semantics, auto-merge, or review-rigor
  demotion.
