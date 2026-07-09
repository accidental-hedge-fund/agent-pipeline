## Why

The spec-generation harness used by `sweep` (and `intake`) sometimes returns the
model's working narration — including literal, text-shaped tool-call blocks
(`**Tool: bash**`, ```` ```json {"command":…} ```` ) — *before* the final spec
document, all inside its single lean-turn message. The output path forwards that
raw text straight to section validation, which correctly rejects it
("generated spec is missing required sections"), blocking the re-spec for that
issue. In the 2026-07-07 `sweep --apply` run, 2 of 6 thin issues (#398, #390)
failed this way while 4 succeeded — intermittent, but common enough to break
batch flows. The failure is a **transcript-capture mechanic**, not a content
problem: the model did produce a valid spec, but narration ahead of it poisoned
the captured body.

## What Changes

- Add a shared **spec-output sanitization** step between the harness call and
  section validation for both `sweep` and `intake`. It extracts the final spec
  document (the region beginning at the spec title / first required section) and
  discards any leading narration or text-shaped tool-call blocks.
- Classify a harness output as **capture-shaped** when, after extraction, the
  required sections are still absent *and* narration/tool-call markers are
  present (distinguishing a mechanics failure from a genuinely-empty spec).
- On a capture-shaped failure, the spec-generation caller **retries the harness
  once** (bounded) before recording the issue as blocked. A genuine content
  failure (valid-looking but incomplete spec, no capture markers) blocks
  immediately, as today — no extra model call.
- Assert (and drift-guard) that the sweep/intake spec-generation invocation runs
  **tool-free**: the real deps SHALL invoke the harness with the lean contract
  (`--tools ""` + `--strict-mcp-config`), so the model is never actually granted
  tools even though it may still narrate as if it had them.
- Preserve the existing section-validation contract unchanged — it is the
  backstop that already catches bad output; this change only stops well-formed
  specs from being lost to leading narration.

## Capabilities

### New Capabilities
- `spec-generation-output-guard`: Extraction of the final spec document from raw
  spec-generation harness output, capture-shaped-failure detection, the bounded
  single retry, and the tool-free-invocation guarantee — shared by the `sweep`
  and `intake` spec-generation paths.

### Modified Capabilities
<!-- No existing capability's requirements change. The sweep/intake timeout
     capabilities remain as-is; the new guard sits between the harness call and
     the unchanged section-validation contract. -->

## Impact

- `core/scripts/stages/` — new shared helper (e.g. `spec-output.ts`) exporting
  the extraction + capture-shaped detection functions.
- `core/scripts/stages/sweep.ts` — route `harnessResult.output` through the
  guard before `validateSweepSpecBody`; add the bounded retry loop.
- `core/scripts/stages/intake.ts` — route `parseSpec`'s input through the guard
  before `validateSpecBody`; add the bounded retry loop.
- `core/test/` — regression test feeding a narration + tool-block + spec
  transcript through the extraction path and asserting the clean spec reaches
  validation; retry-once tests for both call sites.
- `plugin/` mirror — regenerated after the `core/` change.

## Acceptance Criteria

- [ ] The sweep/intake spec-generation invocation runs tool-free — the real deps
      pass the lean contract (`--tools ""`, `--strict-mcp-config`) to `invoke()`,
      and a drift-guard test asserts it.
- [ ] A spec-output guard extracts the final spec document from raw harness
      output, stripping any leading narration/tool-call blocks, and this extracted
      body — not the raw transcript — is what reaches section validation for both
      `sweep` and `intake`.
- [ ] When extraction still yields no valid spec *and* narration/tool-call markers
      are present, the output is classified capture-shaped and the harness is
      retried exactly once before the issue is blocked; a genuine content failure
      (no capture markers) blocks immediately with no retry.
- [ ] Feeding the 2026-07-07 failure inputs (#398, #390 bodies) transcript-shaped
      output through the extraction path produces valid four-section specs.
- [ ] A regression test feeds a transcript-shaped harness output (narration +
      tool block + final spec) through the extraction path and asserts the final
      spec — with all four required sections — is what reaches validation.
- [ ] The section-validation contract is unchanged; it still rejects a spec that
      is genuinely missing sections after extraction and retry.
- [ ] `npm run ci` passes end-to-end after the change (core tests, mirror in
      sync, openspec validate).
