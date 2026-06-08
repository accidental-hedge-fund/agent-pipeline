## Why

Users who set `last30days.enabled: true` in their pipeline config get a silent skip when the skill is missing or produces no signal — with no explanation of why. The single-line `console.log` in `gatherCarryForward` is opaque to anyone who doesn't know the codebase, leaving them to wonder whether the feature is broken or misconfigured.

## What Changes

- In `gatherCarryForward` (`core/scripts/stages/planning.ts`), replace the two terse `console.log` skip lines with a richer, non-blocking hint message that names (a) the skill install command and (b) that data-source keys live in the skill, not the pipeline.
  - Branch 1 — `res.unavailable`: hint that the skill or Python toolchain was not found, with install guidance.
  - Branch 2 — `!res.success || !hasSignal(brief)`: hint that the skill ran but returned no usable signal, with a pointer to adding data-source keys in the skill.
- When `last30days.enabled` is false (the default), **no hint is emitted** and no behavior changes.
- The hint never throws, blocks, or retries — the "proceed without it" path is unchanged.
- Update the README "last30days context (optional)" section to document that data-source keys belong in the skill, which keys give the most lift, and link to the skill's own setup.
- Unit tests: hint-on-unavailable, hint-on-no-signal, no-hint-when-disabled.

## Capabilities

### New Capabilities

- `last30days-setup-hint`: Non-blocking contextual hint surfaced at the two empty-brief branches in `gatherCarryForward` when `last30days.enabled: true`, plus the corresponding README documentation note.

### Modified Capabilities

<!-- none — no existing spec-level behavior is changing; the overall last30days integration behavior (non-blocking, opt-in) is unchanged -->

## Impact

- **`core/scripts/stages/planning.ts`** — `gatherCarryForward`: two `console.log` calls replaced with hint-emitting calls; no other logic changes.
- **`core/scripts/last30days.ts`** — read-only for this change (return types and `hasSignal`/`run` signatures referenced but not modified).
- **`README.md`** — "last30days context (optional)" section gains a note on data-source keys and a link.
- **Test files** — new unit tests for the three hint scenarios.
- **No API keys read, stored, or prompted for by the pipeline.** The hint only points users at the skill's own setup.
