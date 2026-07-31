## Context

`scripts/install.mjs` defines two installer hosts (`claude`, `codex`) with
overlays under `hosts/claude` and `hosts/codex`. There is no `hosts/grok` and
`--host` rejects anything outside `claude|codex|all`.

Observed production layout (2026-07-30, after v1.29.0 upgrade):

```text
~/.grok/skills/pipeline → ~/.claude/skills/pipeline
```

Grok Build discovers skills under `~/.grok/skills/`. Symlinking to the
Claude-managed tree reuses the same core, launcher, and version identity that
`pipeline doctor` already checks via install-root `core/package.json` and the
running `VERSION`. That works operationally but is undocumented: reinstall
guidance never mentions re-creating the Grok link, and install help still
reads as Claude/Codex-only.

Doctor checks `install:version-coherence` and `install:version-freshness` key
off the **running** engine install root and `VERSION`, not the consumer host
name. A symlink that resolves into a managed Claude install should already be
coherent; this change must not break that and should pin it with a regression
when implementation touches path resolution.

## Goals / Non-Goals

**Goals:**

- Make the supported Grok consumption path discoverable from README and install
  help without reverse-engineering the tree.
- State clearly that Grok is not a full first-class host overlay (no required
  `hosts/grok` SKILL.md fork in this change).
- Prefer the **symlink** layout so Claude update and Grok share one core
  (single version truth for doctor).
- Optionally add a low-cost installer target `--host grok` that materializes
  that layout.
- Keep doctor version-coherence / version-freshness correct when entry path is
  a symlink to a managed install.

**Non-Goals:**

- Full Grok-specific SKILL.md fork or Grok-only command overlays unless the
  host hard-requires distinct front matter (not observed as required today).
- Changing Claude or Codex install destinations, markers, or shadow detection.
- Teaching `pipeline path` hostCoverage enums for Grok as a hard requirement
  of the docs-only MVP (stretch only if `--host grok` lands and path discovery
  already has a clean extension point).
- Auto-merge, review-mode changes, or multi-host packaging redesign.

## Decisions

### D1 — Document symlink-first; copy is second-class

**Choice:** Document preferred layout as:

```bash
mkdir -p ~/.grok/skills
ln -sfn ~/.claude/skills/pipeline ~/.grok/skills/pipeline
```

(or equivalent when `CLAUDE_CONFIG_DIR` relocates Claude). Document a **copy**
of the skill tree as an acceptable alternative with the trade-off that updates
to Claude no longer refresh Grok until the copy is refreshed.

**Why not copy-first:** Two trees diverge on version; doctor/version-freshness
then depend on which entry the operator runs. Symlink preserves single-core
semantics already used by Claude installs.

**Alternatives considered:**

- *Docs-only, no copy mention* — incomplete; some environments forbid
  symlinks.
- *Document only `npx` without a skill path* — does not match how Grok loads
  skills from `~/.grok/skills/`.

### D2 — Grok is not a first-class host overlay in the MVP

**Choice:** Do **not** add `hosts/grok/` or a Grok SKILL.md fork for the
required path. Claude’s SKILL.md + core is sufficient for the observed
symlink model. README SHALL say Grok is a consumer of the Claude (or shared)
install via path layout, not a third packaged host overlay.

**Why:** Issue non-goal forbids a full fork unless required. Avoids build.mjs
mirror / host packaging churn for documentation debt.

### D3 — Stretch: `--host grok` materializes the symlink, does not fork overlay

**Choice (stretch):** If implemented, `HOSTS.grok`:

- `skillsDir`: `~/.grok/skills` (honor a future `GROK_HOME` / documented env
  only if one already exists in-repo; otherwise home-relative `~/.grok` to
  match observed layout).
- Install behavior: ensure parent dirs exist; create or refresh
  `pipeline` as a **symlink** to the Claude-managed skill dir when that dir
  exists; if Claude is not installed, either (a) fail with remediation to
  install Claude first, or (b) stage the shared core into a managed path and
  link Grok there — prefer **(a)** for simplicity unless tests show Claude is
  often absent for Grok-only operators.
- Reuse managed-marker semantics only on real install trees; a pure symlink
  target that points at a managed Claude tree inherits the marker from the
  target (do not invent a second unmanaged tree at the Grok path).
- Include `grok` in `--host` usage / error strings and in auto-detect only when
  `~/.grok` (or chosen base) exists **and** stretch is implemented.

**Why symlink not copy for `--host grok`:** Matches D1 and keeps doctor’s
single install root.

**Alternatives considered:**

- *Full host overlay like codex* — out of scope; duplicates SKILL.md.
- *Always copy core into `~/.grok/skills/pipeline`* — dual-version risk.

### D4 — Doctor symlink correctness is an invariant, not a new check id

**Choice:** Do not add a new doctor check named for Grok. Require that
`install:version-coherence` and `install:version-freshness` continue to use
the install root of the running engine such that resolving through a symlink
to a managed tree yields the same version comparison as running from the
Claude path. Add a regression (unit or install-smoke adjacent) only if path
resolution needs an explicit `realpath` or if current code would mis-report.

**Why:** Freshness already compares running `VERSION` to GitHub release tags;
coherence compares `VERSION` to `package.json` under install root. The bug
class is “wrong root when invoked via symlink,” not “missing Grok-specific
check.”

### D5 — README placement

**Choice:** Add a short subsection under Install (or Hosts) titled for Grok
Build consumers: layout, symlink command, reinstall note (“re-run Claude
install, then re-create the symlink” / or `--host grok` if present), and the
not-first-class statement. Keep it after the primary Claude/Codex quickstart
so newcomers are not derailed (consistent with `readme-user-clarity` optional
separation).

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Claude uninstall leaves a dangling Grok symlink | Docs note dependency on Claude tree; stretch `--host grok` can fail closed if target missing. |
| Stretch `--host grok` expands installer surface | Keep stretch optional in tasks; docs-only MVP still closes acceptance criteria 1–5. |
| Copy layout diverges versions | Docs mark copy as second-class; prefer symlink. |
| Env-var sprawl (`GROK_HOME`) without host support | Do not invent env vars in MVP; use `~/.grok` unless code already defines one. |
| `pipeline path` schema stays claude/codex-only | Accept for MVP; extend only if stretch needs host detection lists in the same PR. |

## Migration Plan

1. Land docs + help text (and tests that assert help mentions Grok layout).
2. Optionally land `--host grok` + unit tests for symlink creation / refresh.
3. Confirm doctor on a symlink layout (manual or automated) against a managed
   Claude install.
4. No data migration; existing operator symlinks remain valid.
5. Rollback: revert docs/installer host entry; operators keep manual symlink.

## Open Questions

- Should stretch `--host grok` auto-install Claude first when missing, or only
  fail with remediation? **Default for implementer: fail with remediation**
  unless product feedback demands chaining.
- Does Grok honor a non-default skills root via env today? Confirm at
  implement time before adding env support.
