## Why

Implementer and planner prompts already say “keep changes minimal” and “reuse existing patterns,”
but they do not give a stop-at-first-rung order. Agents still invent a helper, a wrapper, or a
new dependency when the standard library, an existing seam, or a native platform feature would
do. This change puts a 7-rung reuse ladder into the pipeline-owned implement and plan prompts so
unattended stages pick the first rung that holds, after they read the touched code.

## What Changes

- Add a short always-on 7-rung YAGNI ladder (and a no-unrequested-abstractions rule) to
  `core/scripts/prompts/implementing.md`, after a read-the-touched-code instruction and before
  writing.
- Add a one-liner to `core/scripts/prompts/planning.md` and `core/scripts/prompts/planning_openspec.md`
  so the plan or OpenSpec design does not invent a custom layer the implementer then has to build.
- Attribute the ladder (MIT) in a prompt comment. Do not vendor `@dietrichgebert/ponytail`, do
  not install its host plugin, and do not rebrand the pipeline as ponytail.
- Drift-guard the rendered implementing and planning prompt builders so the ladder is present, and
  the fix-round builders so it is absent.
- Keep pipeline completeness, the test bar, trailers, DNR / needs-human markers, design-gate,
  papercuts, and surgical-fix discipline unchanged.
- Intensity is always full. No `lite` / `ultra` / `off` config key. No extra review stage. Review
  tags (`yagni` / `stdlib` / `native` / `shrink`) are out of this change.

## Capabilities

### New Capabilities

- `implement-plan-yagni-ladder`: Implement and plan prompts carry a 7-rung reuse ladder (read
  first, stop at the first holding rung, no unrequested abstractions). Fix-round prompts do not
  receive that ladder. Pipeline test, trailer, and completeness contracts stay in force.

### Modified Capabilities

- (none)

## Acceptance criteria

- [ ] `buildImplementingPrompt` output contains a read-the-touched-code instruction, then the
      7-rung ladder (need / skip, reuse in-repo, stdlib, native platform, already-installed
      dependency, one line, then minimum that works) and the no-unrequested-abstractions rule,
      before writing instructions.
- [ ] `buildPlanningPrompt` output tells the planner to prefer the first holding rung after
      reading in-scope code, so the plan does not invent a custom layer.
- [ ] `buildPlanningOpenspecPrompt` output includes the same first-holding-rung one-liner, so
      OpenSpec proposal/design artifacts do not invent a custom layer.
- [ ] `buildFixPrompt`, `buildTestFixPrompt`, `buildVisualFixPrompt`, and `buildEvalFixPrompt`
      output do not contain the 7-rung ladder.
- [ ] Implementing prompt still requires unit tests for new features and a regression test for
      bug fixes; it does not treat tests as YAGNI.
- [ ] Implementing prompt still requires git trailers, and does not shrink the issue or replace
      the existing completeness / DNR / design-gate / papercut instructions with a 3-line output
      contract.
- [ ] Implementing prompt still forbids shrinking trust-boundary validation, data-loss error
      handling, security, accessibility, or anything the issue or plan explicitly requests.
- [ ] No `@dietrichgebert/ponytail` dependency is added. No host plugin, marketplace install, or
      `/ponytail` command is added. No `off|lite|full|ultra` config key is added.
- [ ] A prompt comment attributes the ladder as MIT, with a pointer to
      https://github.com/DietrichGebert/ponytail, without rebranding the pipeline as ponytail.
- [ ] Unit tests over prompt-builder output assert the implementing and planning ladders are
      present and the fix-round builders omit them; each assertion fails if the corresponding
      instruction is removed or wrongly copied.
- [ ] After any `core/` edit, `node scripts/build.mjs` regenerates `plugin/` in the same change
      and `npm run ci` is green.

## Impact

- `core/scripts/prompts/implementing.md` — read-first instruction + 7-rung ladder +
  no-unrequested-abstractions rule.
- `core/scripts/prompts/planning.md` and `core/scripts/prompts/planning_openspec.md` — one-liner.
- `core/test/prompt-loader.test.ts` — drift assertions on implementing, planning, OpenSpec
  planning, and fix-round builders.
- `plugin/` — regenerated SKILL overlay after the `core/` prompt edits.
- No stage handler, state-machine, review-schema, config-key, or fix-template changes.
- No new npm dependency.
