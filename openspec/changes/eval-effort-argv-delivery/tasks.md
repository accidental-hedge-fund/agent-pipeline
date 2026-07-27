# Tasks — eval-effort-argv-delivery (#621)

## 1. Prove the defect first

- [ ] 1.1 Add a failing argv-level test in `core/test/harness.test.ts` that drives the **eval**
  invocation path (not `invoke()` directly) with a treatment effort of `high` against a fake
  `codex` CLI on `PATH` that echoes its arguments, and asserts `-c model_reasoning_effort=high`
  appears. Run it and record that it fails on unmodified `main` — this is the bite proof required
  by the acceptance criteria.
- [ ] 1.2 Add the sibling `claude` case asserting `--effort high`, and a no-effort case asserting
  no effort flag appears (the byte-identical baseline).

## 2. Map the coordinate at the seam

- [ ] 2.1 In `core/scripts/evals/executor.ts`, `realInvokeHarness`: pass
  `reasoningEffort: args.effort` to `harnessInvoke` instead of the dead `effort:` key. Add a short
  comment naming the two vocabularies (eval `effort` axis vs `InvokeOptions.reasoningEffort`) and
  pointing at the argv test, so a future edit cannot silently re-diverge.
- [ ] 2.2 Export the entry the argv test drives (`realInvokeHarness`, or an equivalently thin
  exported function over `HarnessInvokeArgs`) so the test exercises the real mapping rather than a
  copy of it.
- [ ] 2.3 Re-run the tests from 1.1/1.2 — they now pass. Confirm the no-effort case's argv is
  unchanged from the pre-fix baseline.

## 3. Never claim an undeliverable effort

- [ ] 3.1 In `runCell`'s local-CLI harness branch (`core/scripts/evals/executor.ts`), before the
  preflight/first invocation: if `cell.treatment.effort` is set and the resolved harness has no
  effort capability (no registered adapter, or `capabilities.effort === false`), finish the cell as
  `infra_error` with a message naming the harness and the requested effort. A cell with no declared
  effort is unaffected.
- [ ] 3.2 Test in `core/test/evals-executor.test.ts` (injected fakes only — no subprocess): a
  treatment declaring an effort against a harness with no effort capability yields `infra_error`,
  the message names the harness and the effort, and `invokeHarnessFn` is never called.
- [ ] 3.3 Test that a treatment declaring **no** effort against the same harness still executes
  normally.

## 4. Guard the recorded coordinate

- [ ] 4.1 Test that two cells differing only in declared effort produce different harness argv —
  the property that was false before this change and is the honest form of "the recorded
  `treatment_id` matches what ran".
- [ ] 4.2 Confirm no `model-endpoint` executor behavior changed: the existing
  `deriveModelEndpointOverride` / `encodeEffort` / `requested_effort`+`resolved_effort` tests pass
  untouched.

## 5. Non-regression of the ordinary pipeline

- [ ] 5.1 Confirm the six non-eval `invoke()` call sites (`planning.ts`, `fix.ts`,
  `review-routing.ts`, `intake.ts`, `sweep.ts`, `design_gate.ts`) are untouched and their argv is
  byte-identical — they already pass `reasoningEffort`.

## 6. Spec, mirror, gate

- [ ] 6.1 Regenerate the plugin mirror: `node scripts/build.mjs`, commit `plugin/` in the same
  change.
- [ ] 6.2 `npm run ci` green from the repo root (`ci:core` → `build.mjs --check` →
  `ci:install-smoke` → `ci:openspec`).
- [ ] 6.3 Note in the PR body, for the eval campaign issues (#600–#604), that any local-harness
  experiment recorded before this fix has an invalid effort axis: every effort cell ran at CLI
  default. Those artifacts are not retro-corrected by this change.
