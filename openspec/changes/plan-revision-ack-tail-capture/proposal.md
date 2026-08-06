## Why

`plan-revision.ack@1` can hard-block plan-revision even when the implementer (observed: Grok with `--output-format streaming-json`) **did** emit a valid `## Feedback Incorporated` section with `[ADDRESSED]` / `[DEFERRED]` bullets. The human-readable `terminal.log` transcript contains a section that passes `verifyPlanRevisionOutput()`, but the stage still fails with “missing required ## Feedback Incorporated section”. This is a **false-negative harness-contract failure** caused by **product stdout reconstruction under tail-capped raw JSONL capture** — not a missing product requirement, not model refusal, and not fixed by mid-line header promotion (#658).

## What Changes

- **Product stdout completeness under telemetry tail capture**: when an adapter uses streaming machine-readable envelopes plus `captureMode: "tail"` (to keep terminal cost/usage lines), the pipeline SHALL still expose a **complete reconstructed assistant product text** to freeform/markdown stage-output contracts. Tail truncation of the raw envelope MUST NOT drop a leading acknowledgement that was actually streamed and forwarded to the human transcript.
- **Contract validation input**: `plan-revision.ack@1` (and equivalent freeform stdout contracts that validate full product text) SHALL validate against that complete product text (or an equivalent artifact that cannot lose the leading ack while only preserving the plan tail / cost envelope).
- **Format-repair honesty**: shared format-repair SHALL still run when the acknowledgement is **truly** missing from the product stream; it MUST NOT false-trigger solely because capture/reconstruction lost a section that the live forward path already printed.
- **Regression coverage**: synthetic large streaming plan-revision capture with the ack only in the first portion of the stream MUST pass under production Grok capture settings (`streaming-json` + tail + `MAX_OUTPUT` cap).
- **Telemetry preservation**: cost/usage recovery from a terminal envelope line under large streams remains supported; this change does not remove tail capture for accounting.
- **Optional (non-blocking for ship)**: durable recovery for this evidence key MAY prefer re-invoke/re-parse over full replan when evidence shows capture/reconstruction loss rather than true model omission. Version-coherence re-check of Grok CLI verified-against pin if 0.2.118+ changed streaming-json shapes.

No **BREAKING** product API change. `plan-revision.ack@1` remains intentional and hard.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `cli-harness-adapters`: require that machine-readable + tail-capture adapters still yield complete assistant product text for stdout consumers that validate freeform/markdown contracts; dual-buffer, plain-text side channel, or equivalent capture strategy is in scope.
- `harness-step-verification`: plan-revision acknowledgement verification SHALL be based on complete reconstructed product text, not a telemetry-tail-truncated fragment that diverges from the forwarded transcript.
- `stage-output-contract`: clarify that registered freeform/markdown contracts validate **product** output after envelope normalization, and that normalization MUST NOT silently drop leading product content that was successfully streamed.

## Impact

- `core/scripts/harness.ts` — capture bounding (`MAX_OUTPUT`, head/tail), optional dual-buffer / product-text path alongside raw telemetry capture.
- `core/scripts/harness-adapters/grok.ts` — `parseGrokTelemetry`, `makeGrokForwardTransform`, and/or capture mode interaction so product text for contracts is complete under production streaming-json + tail settings.
- Possibly shared adapter types / Claude/Codex tail paths if the fix is generalized rather than Grok-only (prefer general “product text vs telemetry capture” seam if small).
- `core/scripts/stages/planning.ts` / stage-output-contract consumers — only if validation must switch from `HarnessResult.stdout` to a dedicated product-text field/artifact.
- `core/test/*` — regression for large stream + leading `## Feedback Incorporated`; existing ack/format-repair cases remain green.
- `plugin/` mirror regenerated if `core/` changes (`node scripts/build.mjs`).
- Fixtures under Grok streaming-json if envelope samples are extended.

Out of scope:

- Removing or softening `plan-revision.ack@1`.
- Lyric-utils / consumer product fixes.
- Changing plan-review verdict schema or review rigor.
- Autonomous merge, or broadening durable recovery classification beyond an optional capture-specific recovery path.
- Full multi-harness eval matrix beyond the capture/reconstruction contract.

## Acceptance criteria

- [ ] When a streaming-json + tail-capture adapter (production Grok settings) emits a valid `## Feedback Incorporated` section at the **start** of a large plan-revision response whose raw JSONL exceeds the capture cap, `plan-revision.ack@1` **passes** and the revised plan is eligible to post.
- [ ] Contract validation uses complete reconstructed assistant product text (or an equivalent capture that cannot drop the leading ack while retaining only the plan tail / cost line).
- [ ] Fixture/regression: synthetic large plan-revision stream with `## Feedback Incorporated` only in the first ~20% of the stream **must** pass under production Grok capture settings (`streaming-json`, `captureMode: "tail"`, `MAX_OUTPUT` as in production).
- [ ] Format-repair still runs when the ack is **truly** absent from product text; it does **not** false-trigger when the human-forwarded transcript already contained a valid section that was lost only in capture reconstruction (pre-fix behavior).
- [ ] Truly missing section or header-with-no-tagged-items still fails after the shared format-repair budget with the existing harness-contract terminal reasons.
- [ ] Cost/usage recovery from the terminal telemetry envelope under large streams remains available (tail capture for accounting is not abandoned without an equivalent).
- [ ] Unit/integration tests green for `verifyPlanRevisionOutput` + Grok `parseTelemetry` / capture tail interaction; existing mid-line (#658) and fenced-section tolerances remain green.
- [ ] Optional: durable recovery for this evidence key avoids wasteful full replan when failure is proven capture/reconstruction (prefer re-invoke revision or re-parse full stream artifact) — stretch, not required to close the primary false-negative.
