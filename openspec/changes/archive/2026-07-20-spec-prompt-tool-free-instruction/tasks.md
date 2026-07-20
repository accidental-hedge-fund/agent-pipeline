## 1. Shared tool-free instruction constant

- [ ] 1.1 Add a `SPEC_GENERATION_TOOL_FREE_BLOCK` constant to `core/scripts/prompts/index.ts` stating that no tools are available (no file reads, greps, shell, or repo exploration) and that the spec MUST be written in one pass directly from the provided description, in the same single-sourced style as `SEVERITY_RUBRIC` / `CONFIDENCE_CALIBRATION_BLOCK`.
- [ ] 1.2 Inject the constant via a new `{{no_tools_instruction}}` (or equivalently named) placeholder in `buildIntakePrompt` and `buildSweepPrompt`.
- [ ] 1.3 Export the constant on the `_testing` object so the drift-guard test can assert byte-for-byte inclusion.

## 2. Template placeholders

- [ ] 2.1 Insert the shared `{{no_tools_instruction}}` placeholder into `core/scripts/prompts/intake.md` in the instructions region (before the model is told to write the spec).
- [ ] 2.2 Insert the same shared placeholder into `core/scripts/prompts/sweep.md` in the equivalent instructions region.

## 3. Drift-guard test

- [ ] 3.1 Add a test to `core/test/prompt-loader.test.ts` that builds both the intake and sweep prompts and asserts each embeds the shared tool-free block byte-for-byte.
- [ ] 3.2 Add a test asserting the built intake prompt for a concrete-code description (the #421 description verbatim) contains the tool-free instruction, so a code-referencing intake carries the constraint without a caller preamble.
- [ ] 3.3 Prove the test bites: confirm it fails when the placeholder is removed from a template.

## 4. Regression guardrails

- [ ] 4.1 Confirm the lean-harness flags (#220) are unchanged — the existing `realIntakeDeps`/`realSweepDeps` lean-invocation drift test stays green.
- [ ] 4.2 Confirm the output guard (`spec-output.ts`) extraction/classification/retry tests stay green — no change to that path.

## 5. Mirror sync and CI

- [ ] 5.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror and commit it in the same change.
- [ ] 5.2 Run `npm run ci` from repo root; all checks green (including `openspec validate --all`).
