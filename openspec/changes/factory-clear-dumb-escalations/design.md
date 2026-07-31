# Design: Clear dumb pre-merge escalations

## Context

Pre-merge has accumulated fail-closed paths that were correct for *real*
integrity risks (destructive archive rollback over operator dirt;
security residual) but were applied to **engine-owned** or **directionally
clear** cases. Dogfood 2026-07-31: only 1/N items reached ready-to-deploy;
most parks were residual-human or dirty-before-archive.

## Decisions

1. **Single dirt model for markers.** Reuse
   `stripPipelineInternalMarkers` / `isOnlyPipelineInternalMarkerDirt` from
   `salvage-harness-work.ts` in `maybeArchiveOpenspec`. Do not invent a
   second marker list.
2. **Marker-only → clean + unlink.** Unlink via `git clean -fd -- <marker>`
   so later porcelain checks stay clean. No commit of markers.
3. **code-behind-spec → autofix.** Expand `isAutoFixableFinding` only for
   that structured direction. Do not add bare `spec-divergence` to
   `PRE_MERGE_AUTOFIX_CATEGORIES` (would pull direction-less and
   spec-behind-code into implementer autofix incorrectly).
4. **spec-behind-code stays residual** for this change (existing bounded
   spec-repair / consistency guard paths own it). Out of scope: expanding
   residual to auto-invoke spec repair on pure residual batches.

## Risks

- Reviewers may omit `spec_divergence_direction`; those stay residual
  (fail-closed). Prompt/schema already request the field.
- Unlink of markers is best-effort; if clean fails, marker-only still
  proceeds because dirt decision already stripped them — a leftover
  marker file is non-fatal for archive rollback safety.

## Alternatives rejected

- Blanket residual auto-override — would skip security/scope judgment.
- Softening all dirty porcelain — would re-open #255 data-loss class.
