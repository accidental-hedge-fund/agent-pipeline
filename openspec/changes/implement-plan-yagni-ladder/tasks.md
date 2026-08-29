## 1. Implementing prompt ladder

- [ ] 1.1 Add a read-the-touched-code instruction to `core/scripts/prompts/implementing.md` before writing, and verify the rendered `buildImplementingPrompt` output tells the harness to read touched code first.
- [ ] 1.2 Add the 7-rung ladder (need/skip, in-repo reuse, stdlib, native platform, already-installed dependency, one line, then minimum that works) after that read-first instruction, and verify all seven rungs appear in `buildImplementingPrompt` output in that order.
- [ ] 1.3 Add the no-unrequested-abstractions rule (one-implementation interface, factory for one product, config for a constant) and the shared-function bug-fix rule, and verify both appear in `buildImplementingPrompt` output.
- [ ] 1.4 Add keep-rules so tests, trailers, completeness, and trust-boundary / data-loss / security / accessibility / explicitly requested work are not treated as YAGNI, and verify `buildImplementingPrompt` still matches the existing trailer and test-instruction assertions and names those never-simplify-away surfaces.
- [ ] 1.5 Add an HTML comment attributing the ladder to Ponytail (https://github.com/DietrichGebert/ponytail, MIT) without rebranding the pipeline, and verify the implementing template contains that comment.

## 2. Planning one-liners

- [ ] 2.1 Add a first-holding-rung one-liner to `core/scripts/prompts/planning.md` after the existing “Research first” block, and verify `buildPlanningPrompt` output tells the planner not to invent a custom layer.
- [ ] 2.2 Add the same one-liner to `core/scripts/prompts/planning_openspec.md` in the Task / Important instructions, and verify `buildPlanningOpenspecPrompt` output includes it.

## 3. Drift tests

- [ ] 3.1 Add `prompt-loader.test.ts` assertions that `buildImplementingPrompt` contains read-first, all seven rungs, no-unrequested-abstractions, never-simplify-away, and MIT attribution, and verify each assertion fails if the matching text is removed.
- [ ] 3.2 Add assertions that `buildPlanningPrompt` and `buildPlanningOpenspecPrompt` contain the first-holding-rung one-liner, and verify each assertion fails if that one-liner is removed.
- [ ] 3.3 Add assertions that `buildFixPrompt`, `buildTestFixPrompt`, `buildEvalFixPrompt`, and `buildVisualFixPrompt` do not contain the 7-rung ladder, and verify each assertion fails if the ladder is copied into that template.
- [ ] 3.4 Confirm `fix.md`, `test_fix.md`, `visual_fix.md`, and `eval_fix.md` are unchanged by this change (`git diff` empty on those files).

## 4. Packaging guard and CI

- [ ] 4.1 Confirm `package.json` / lockfiles do not add `@dietrichgebert/ponytail`, and that no `/ponytail` command or intensity config key (`off|lite|full|ultra`) is introduced.
- [ ] 4.2 After the `core/` prompt edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change; verify `node scripts/build.mjs --check` passes.
- [ ] 4.3 Run `openspec validate implement-plan-yagni-ladder` then `npm run ci` from the repo root, and verify both are green.
