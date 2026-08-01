## 1. Align living pipeline-state-machine spine

- [x] 1.1 Apply the change delta so living `openspec/specs/pipeline-state-machine/spec.md` STAGES-order scenario lists all 16 code stages including `needs-human` (after `ready-to-deploy` in constant order).
- [x] 1.2 Apply the renamed/modified terminal requirement so living text states `TERMINAL_STAGES` is exactly `{ready-to-deploy, needs-human}` with scenarios for both terminals and never-merge.
- [x] 1.3 Confirm no other living requirement in this capability still claims a singleton terminal of only `ready-to-deploy` without the off-ramp (update or cross-reference if found).

## 2. Align operator and agent surfaces

- [x] 2.1 Update `README.md` stage-count / inventory language so any numeric count equals `STAGES.length` and terminal/park outcomes mention `needs-human` where terminal outcomes are described.
- [x] 2.2 Update `hosts/claude/SKILL.md` state-machine diagram (or equivalent inventory) to include `plan-review`, `design-gate`, `visual-gate`, and `needs-human`; fix “13-stage” (or other under-count) language.
- [x] 2.3 Update `hosts/codex/SKILL.md` symmetrically with the same stage inventory and off-ramp meaning (host command tokens only may differ).
- [x] 2.4 Update `openspec/project.md` so it no longer claims an “11-stage” machine; align inventory language with code truth.

## 3. Drift-guard test

- [x] 3.1 Add a co-located test under `core/test/` that imports `STAGES` and `TERMINAL_STAGES` from `types.ts` and reads the local surfaces (README, both host SKILLs, `openspec/project.md`, living `pipeline-state-machine` spine).
- [x] 3.2 Assert required stage names appear on both host SKILLs (`plan-review`, `design-gate`, `visual-gate`, `needs-human`); assert any stated numeric stage count equals `STAGES.length`; assert living STAGES-order text includes every `STAGES` member; assert living terminal text includes both terminals.
- [x] 3.3 Ensure the test performs no network, git, or subprocess calls.
- [x] 3.4 Prove the test bites: temporarily break one surface (or run before fixes) and confirm failure, then restore/fix so the suite passes.

## 4. Mirror and full gate

- [x] 4.1 Run `node scripts/build.mjs` from the repo root and include the regenerated `plugin/` mirror in the same change as the Claude host SKILL update.
- [x] 4.2 Run `npm run ci` from the repo root and confirm green (`ci:core`, `build.mjs --check`, install-smoke, `openspec validate --all`, conditional docs, scripts).

## 5. Validate OpenSpec change

- [x] 5.1 Run `openspec validate single-source-stages-inventory` and fix any structural errors until it passes.
