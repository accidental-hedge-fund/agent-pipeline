## Why

`review-1` (and the same path for `review-2`) can assemble a review prompt that exceeds the reviewer’s hard input ceiling (Codex: 1,048,576 characters). Today the pipeline still spawns the reviewer; the harness fails with `input_too_large`, the stage blocks as generic `harness-failure`, and auto-loop / recovery treats that class as retriable — so the same oversize payload is sent again. Unblock-and-rerun guidance for `harness-failure` is wrong for this class. Operators get a crash, a wasted retry, and no distinct diagnosis.

## What Changes

- After the fully assembled review prompt is built (post-`buildReview*Prompt` and any in-path appendages such as Tester evidence), and **before** harness spawn for both `review-1` and `review-2`, count assembled prompt **characters**.
- Compare that count to a ceiling: the configured reviewer’s **declared** finite max when one exists; otherwise the Codex default of `1048576` characters.
- When over the ceiling: call `setBlocked` with distinct kind `review-prompt-too-large`, return a blocked outcome with that `blockerKind`, and **never** spawn the reviewer for that attempt.
- Do **not** spend an auto-loop / auto-recovery retry on the same payload for this kind (`isAutoLoopRecoverable` must treat it as non-recoverable).
- Blocker recipe and reason text MUST NOT instruct operators to “unblock and re-run as-is” (that cannot succeed until the payload or ceiling changes).
- Under-ceiling prompts keep today’s spawn and review path unchanged.
- **Out of scope (grill-locked):** finding or shrinking the unaccounted ~1.29 MB; chunking diffs; stripping conventions; per-model ceiling tables; skipping review to advance.

## Acceptance Criteria

Observable, falsifiable outcomes that make #1054 done:

- [ ] When the assembled `review-1` prompt character count is strictly greater than the effective ceiling, the pipeline blocks with `blockerKind: "review-prompt-too-large"` and the reviewer harness is **not** invoked (spawn count stays 0 for that attempt).
- [ ] The same oversize preflight applies to `review-2` (adversarial prompt path).
- [ ] When the assembled prompt is at or under the ceiling, review proceeds to harness invoke exactly as today (no new false block).
- [ ] Effective ceiling uses the configured reviewer’s declared finite max when present; when absent / unlimited / unknown, ceiling is `1048576` characters.
- [ ] A `review-prompt-too-large` block is **not** auto-loop recoverable: no second review harness spawn is performed on the same payload solely because of auto-loop / auto-recovery continuation.
- [ ] The blocked comment’s “How to unblock” recipe for this kind does **not** contain “unblock and re-run as-is” (or equivalent “re-run without changing the payload” guidance).
- [ ] Unit tests inject deps (fake prompt assembly / ceiling / setBlocked / harness invoker); no real network, git, or subprocess. If `core/` changes, regenerate `plugin/`. `npm run ci` green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `review-layer`: Require a pre-spawn character-count preflight on the fully assembled review prompt for both review rounds; over ceiling → block without spawn; under ceiling → unchanged invoke path.
- `blocked-recovery-recipes`: Add closed `BlockerKind` member `review-prompt-too-large` with a non-empty recipe that does **not** advise re-running the same payload as-is; keep exhaustiveness / snapshot coverage for the new kind.
- `bounded-auto-loop`: Treat `review-prompt-too-large` as a non-recoverable blocked kind so automatic continuation does not re-spend a retry on the identical oversize prompt.

## Impact

- **Primary:** `core/scripts/stages/review-routing.ts` (`invokePromptHarnessReview` / advance-review path after prompt assembly, before `invokeReviewer` / ensemble / stage executor spawn); possibly a small pure helper for ceiling resolution + char count.
- **Blocker surface:** `core/scripts/types.ts` (`BLOCKER_KINDS`, `BLOCKER_RECIPES`); recovery snapshot tests (`blocked-recipes` / related).
- **Auto-loop recoverability:** `isAutoLoopRecoverable` in `core/scripts/pipeline-run.ts` (and any durable projection that would re-drive review solely from this kind).
- **Related existing law (do not regress):** #779 / `production-treatment-preflight` byte limits against adapter `maxPromptBytes` remain; this change is a **character** ceiling for review prompts with a Codex-default fallback when the reviewer declares unlimited/unknown (Codex today declares `maxPromptBytes: "unlimited"` for stdin delivery, which does not express the 1,048,576-char API ceiling).
- **Out of scope:** prompt content reduction, diff chunking, conventions stripping, merge path, review rigor demotion.
- **Program:** v1.39.1. Issue #1054. Grill-locked 2026-08-15.
