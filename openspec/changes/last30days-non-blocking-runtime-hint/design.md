## Context

`gatherCarryForward` in `core/scripts/stages/planning.ts` runs when `last30days.enabled: true`. It calls `last30days.run()` and gates on `hasSignal()` before carrying the brief into planning. Both empty-brief paths currently emit a single terse `console.log` and return `""`.

Users who explicitly opt in via `last30days.enabled: true` see no actionable feedback: they don't know whether the skill is uninstalled, Python is missing, or data-source keys are unconfigured. This change adds a richer hint at those two branches.

The pipeline reads no API keys. The last30days skill owns its own env/Keychain key management entirely.

## Goals / Non-Goals

**Goals:**
- Surface a single, non-blocking human-readable hint when `last30days.enabled: true` and the brief is empty.
- Distinguish the two failure modes (skill unavailable vs. no signal) with different hint text.
- Document data-source keys in the README so users know where to find them.

**Non-Goals:**
- Prompting for, storing, or validating API keys in the pipeline.
- Making last30days a hard dependency or blocking run path.
- Modifying `last30days.run()` or `hasSignal()` signatures.
- Changing behavior when `last30days.enabled: false`.

## Decisions

### D1 — Keep hints in `gatherCarryForward`, not a separate helper

The two skip branches are already co-located in one small function. Extracting a `emitHint()` helper would add indirection for two call sites. Inline the hint text directly.

_Alternatives:_ A shared hint formatter — rejected as premature abstraction for two cases.

### D2 — `console.log` (same channel as existing pipeline logs)

All pipeline progress is written to `console.log`. The hint follows the same `[pipeline] #N: ...` prefix convention so it flows naturally in CI/TTY output without introducing a new output channel.

_Alternatives:_ `console.warn` — rejected because it would mark the output "warning" in some CI renderers, implying the run is degraded. The pipeline is functioning correctly; it's an informational hint.

### D3 — Hint text content

- **Unavailable branch**: point at `npx -y @last30days/skill` install and note keys live in the skill.
- **No-signal branch**: note that the skill ran but found no signal, and suggest adding data-source keys (name `BRAVE_SEARCH_API_KEY` as free; `SCRAPECREATORS_API_KEY` for fuller coverage) configured in the skill itself.

Both messages include a pointer to the skill's README for full setup — a URL the skill's own documentation provides.

### D4 — README update is prose, not code

The "last30days context (optional)" README section gets a short callout paragraph: keys belong in the skill, the two most impactful keys, and a link. No config schema changes needed.

## Risks / Trade-offs

- **Hint text staleness**: if the skill's install command or key names change, the hint text in `planning.ts` and the README paragraph go stale. Mitigation: the hint text references the skill's README link as the authoritative source rather than duplicating full instructions.
- **Verbosity**: users who don't care about last30days and left `enabled: true` by mistake will see the hint on every run until they disable or configure. Mitigation: the hint is a single line per run, same weight as other `[pipeline]` log lines — acceptable overhead.
