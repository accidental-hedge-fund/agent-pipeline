## Why

The lean spec-generation harness (#220) runs the reviewer CLI with `--tools ""` +
`--strict-mcp-config` — no tools, no repo exploration — and #401/#416 added an
output guard that extracts a final spec out of the model's tool-call narration and
retries once when the failure is capture-shaped. But the `intake` and `sweep`
spec-generation prompt templates (`intake.md`, `sweep.md`) never *tell* the model it
is tool-free. When an intake description references concrete code (file paths,
function names) — the most decision-complete kind of description — the model tries to
ground the spec by exploring the repo, emits tool-call JSON as narration, and never
writes a spec at all. This is the residual failure mode #416 cannot repair: there is
no spec to extract because the model spent its entire turn attempting tools.

Observed 2026-07-10 filing #421 (engine at 5cbc43c, which already includes #416), two
consecutive failures with distinct signatures: (1) the model attempted `Read`/`Bash`
on a real source path, treated the malformed tool results as a prompt-injection
attempt, and refused; (2) output began "I'll check the existing `improve` stage
code…" followed by a raw Grep tool-call JSON object, and section validation failed
with no required sections. Prepending "you have no tools; do NOT explore the
repository; write the spec directly from this description" to the same description
made the intake succeed first try (#421 / PR #422) — proving the fix is prompt-level.

## What Changes

- Add a single-sourced instruction block stating the spec-generation harness is
  tool-free: no file reads, greps, shell, or repo exploration are available, and the
  spec MUST be written in one pass directly from the provided description. The block
  is defined once as a shared constant in `core/scripts/prompts/index.ts` (mirroring
  the `SEVERITY_RUBRIC` / `CONFIDENCE_CALIBRATION_BLOCK` single-sourcing pattern) and
  injected into both `intake.md` and `sweep.md` via a shared `{{placeholder}}`.
- Add a drift-guard test in prompt-loader coverage asserting the built intake and
  sweep prompts both embed the shared instruction byte-for-byte.
- No change to the lean-harness flags (#220) or to the narration-extraction /
  retry guard (#416): this only adds an up-front constraint to the prompt so the
  trigger never fires.

## Capabilities

### Modified Capabilities

- `spec-generation-output-guard`: gains a requirement that the `intake` and `sweep`
  spec-generation prompts explicitly declare the harness is tool-free and instruct
  the model to write the spec in one pass from the description, single-sourced across
  both prompts and drift-guarded by a test. No change to the existing extraction,
  classification, retry, or lean-invocation requirements.

## Acceptance criteria

- [ ] The `intake` and `sweep` spec-generation prompt templates state explicitly that
  no tools are available (no file reads, greps, shell, or repo exploration) and that
  the spec must be written in one pass directly from the provided description.
- [ ] The instruction is single-sourced — one shared constant/block used by both
  templates — consistent with how other standing prompt blocks (`SEVERITY_RUBRIC`,
  `CONFIDENCE_CALIBRATION_BLOCK`) are shared.
- [ ] A drift-guard test in prompt-loader coverage asserts the built intake and sweep
  prompts each contain the instruction byte-for-byte.
- [ ] A description that names concrete file paths/functions (e.g. the #421
  description verbatim) produces a spec passing section validation without any
  caller-side preamble workaround.
- [ ] The lean-harness flags (#220) are unchanged (`--tools ""` + `--strict-mcp-config`
  still applied) and the narration-extraction / retry guard (#416) is unchanged.

## Impact

- `core/scripts/prompts/index.ts` — new shared constant + `{{placeholder}}` injection
  in `buildIntakePrompt` and `buildSweepPrompt`; constant exported on `_testing` for
  the drift test.
- `core/scripts/prompts/intake.md`, `core/scripts/prompts/sweep.md` — the shared
  placeholder is inserted into each template.
- `core/test/prompt-loader.test.ts` — drift-guard test added.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`) committed in the same change.
- No changes to the lean-harness flags, the output guard (`spec-output.ts`), section
  validation, or the retry policy.
