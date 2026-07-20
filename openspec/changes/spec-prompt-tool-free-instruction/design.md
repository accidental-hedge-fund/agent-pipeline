## Context

The lean spec-generation harness (#220) is already tool-free at the flag layer
(`--tools ""` + `--strict-mcp-config`), and #401/#416 added an output guard that
extracts a spec out of tool-call narration and retries once on capture-shaped
failure. #423 is the residual: the prompt never *tells* the model it is tool-free, so
a description that references real code reliably triggers repo-exploration narration
and burns the whole turn with no spec to extract. The fix is prompt-level only.

## Goals

- Stop the trigger at the source: tell the spec model it has no tools and must write
  from the description in one pass.
- Keep the two spec-generation prompts (`intake.md`, `sweep.md`) from drifting.
- Do not touch the lean-harness flags (#220) or the extraction/retry guard (#416).

## Decisions

### Decision: Add the requirement to `spec-generation-output-guard`, not a new capability

The output-guard capability already owns the tool-free contract for spec generation —
it holds "The spec-generation harness invocation SHALL run tool-free." Telling the
model about that constraint in the prompt is the natural companion requirement, so it
lands as an ADDED requirement in the same capability rather than a new one. This keeps
the flag-level guarantee, the narration-extraction repair, and the prompt-level
prevention described together.

### Decision: Single-source the block as a shared constant, mirroring `SEVERITY_RUBRIC`

`intake.md` and `sweep.md` currently share no blocks — each is loaded independently.
The two review prompts already demonstrate the accepted single-sourcing pattern:
constants (`SEVERITY_RUBRIC`, `CONFIDENCE_CALIBRATION_BLOCK`, `NON_BLOCKING_GUIDANCE_BLOCK`)
defined once in `index.ts` and injected through placeholders, with a byte-for-byte
drift test. The tool-free block follows the same shape: one `SPEC_GENERATION_TOOL_FREE_BLOCK`
constant, a `{{no_tools_instruction}}` placeholder in both templates, and a drift test.
An alternative — hand-copying the same sentences into both `.md` files — was rejected
because it is exactly the drift the review-prompt constants exist to prevent.

### Decision: Prevention at the prompt, not a change to extraction or retry

#416 already handles the case where a spec *does* exist buried in narration. #423 is
the no-spec case. Rather than widening extraction/retry heuristics (more model calls,
more surface area), the prompt states the constraint so the exploration never starts.
Out of scope: re-enabling tools, changing section validation, or altering the retry
policy — all explicitly excluded by the issue.

## Risks / Trade-offs

- **The upstream CLI still emits malformed tool results when tools are disabled.** That
  is a separate CLI concern; removing the trigger (the model no longer attempts tools)
  is sufficient for this issue and is what the #421/PR #422 workaround demonstrated.
- **Prompt bloat.** The block is a few lines injected into two short prompts; negligible
  against the ~15× latency win of the lean harness, which is preserved.
