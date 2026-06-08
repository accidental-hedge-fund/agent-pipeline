## Context

`scripts/install.mjs` installs the pipeline skill into `~/.claude/skills/pipeline` (honoring `CLAUDE_CONFIG_DIR`). It already performs a non-blocking `preflight()` check for Node, `gh`, auth, and companion dependencies before writing any files. The install step then atomically stages the new tree and replaces `dest` with it.

The problem: there is no distinction between (a) a directory that was previously written by this installer and (b) a personal skill that the user placed there manually. When a migrating user runs the installer for the first time, the personal install is silently overwritten — or worse, a backup placed inside `~/.claude/skills/` still loads as a second skill.

## Goals / Non-Goals

**Goals:**
- Detect whether the pre-existing `~/.claude/skills/pipeline` dir was placed by this installer or by the user manually, before the first overwrite.
- Emit a non-blocking warning + relocation offer when a personal (unmanaged) install is detected.
- Relocation: `mv <skillsDir>/pipeline <claudeBase>/pipeline.<unique>.bak` — outside the scan dir, non-destructive, no-clobber.
- Honor `CLAUDE_CONFIG_DIR` for all path calculations.
- Work in non-interactive environments (CI, piped `npx`) without blocking.

**Non-Goals:**
- Auto-deleting the old install.
- Detecting collisions in the Codex skills dir (noted as a trivial follow-up in the issue).
- Changing how Claude Code discovers skills — that is outside our control.
- Windows path support beyond what the existing script already provides.

## Decisions

### D1 — Managed-by marker file

**Decision**: On each successful install, write an empty sentinel file `.pipeline-installer-managed` inside `<dest>/` (the installed skill dir). On future install runs, if `<dest>` exists AND contains `.pipeline-installer-managed`, treat it as managed (no warning). If `<dest>` exists WITHOUT this file, treat it as a personal install and trigger the shadow warning.

**Alternatives considered**:
- _Inspect file content_ (check if `scripts/pipeline.mjs` matches the shim template): fragile — the shim could change; personal installs might coincidentally match.
- _Date-based heuristic_ (mtime vs. package version): unreliable across copy operations and CI environments.
- _Always warn_: creates noise on routine `update` runs where the installer already owns the dir.

The marker is cheap (empty file), survives `npm ci`, and gives a clear, queryable signal.

### D2 — Relocation path outside the skills scan directory

**Decision**: Relocate to `<claudeBase>/pipeline.<timestamp>.bak`, where `<claudeBase>` is one level above `skills/`. This ensures it is no longer in the scan directory but is easy to find. If a backup with that name already exists, append `.1`, `.2`, etc. until unique (never overwrite).

**Alternatives considered**:
- `~/.pipeline.bak`: too far from the install location; harder to find for rollback.
- `<skillsDir>/pipeline.bak`: still inside the scan dir — the exact failure mode from the original incident.

### D3 — TTY detection for interactivity

**Decision**: Use `process.stdin.isTTY` to determine whether to prompt. In a non-TTY environment (CI, `npx … | sh`, piped input), skip the interactive prompt, emit the warning with the manual-relocation command, and proceed with install. In a TTY, prompt with `readline` (Node builtin — no new deps).

**Alternatives considered**:
- `--no-interactive` flag: adds surface area; TTY detection covers all cases automatically.
- Always skip prompting: removes utility for the primary migration use case (developer running it interactively).

### D4 — Check placement

**Decision**: Add a new `detectPersonalSkill(host)` function called from `main()` after `preflight()` and before any `installHost()` call. Keeps `preflight()` read-only and diagnostic; relocation is a separate, clearly-named step.

**Alternatives considered**:
- Inside `preflight()`: `preflight` is read-only by convention; mixing mutation breaks that contract.
- Inside `installHost()`: too late — the marker file and the atomic staging both need the clean separation.

## Risks / Trade-offs

- [Marker file survives atomic rename?] The marker is written AFTER the atomic `renameSync` (same install loop that writes `dest`). It is added as one additional `writeFileSync` call inside `installHost`. If the process dies between the rename and the marker write, the next run will falsely warn. Mitigation: write the marker into the staging dir before the rename — it then lands atomically with the rest.
- [Unique-name loop unbounded?] In theory hundreds of `.bak.N` files could exist. Mitigation: cap the loop at 100 and fail with a clear message if all are taken (practically impossible).
- [Backup grows stale] Users may accumulate old backups. Non-goal to clean these up — relocation is one-time per migration.

## Migration Plan

1. The marker is added to new installs only — no backfill for existing installs. Users with managed installs who update will get a false-positive warning on their first update after this change ships.
   - Mitigation: the warning is non-blocking; user can re-run `install` a second time and it will see the marker and be quiet. Or add a one-time "backfill marker" path: if the existing dir's `scripts/pipeline.mjs` matches the shim header comment (`// agent-pipeline cross-tool`), treat it as managed and write the marker silently before continuing.
2. README update is a small prose change — no migration concern.
