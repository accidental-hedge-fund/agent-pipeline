## 1. Living OpenSpec spine alignment

- [ ] 1.1 Update living `openspec/specs/pipeline-state-machine/spec.md` STAGES-order scenario to list all 16 `STAGES` members in code order, including trailing `needs-human`
- [ ] 1.2 Replace the living terminal requirement so `TERMINAL_STAGES` is exactly `{ready-to-deploy, needs-human}`, with scenarios for both terminals (keep existing `needs-human` resume/override requirements elsewhere intact)
- [ ] 1.3 Confirm no remaining living-spec claim that the machine is single-terminal at only `ready-to-deploy` (search living specs for contradictory stage counts if needed)

## 2. Operator-facing inventory docs

- [ ] 2.1 Update `README.md` primary stage-count / inventory language to match `STAGES.length` and include the real stage set (including `needs-human` as terminal off-ramp where the blurb lists stages)
- [ ] 2.2 Update `openspec/project.md` purpose blurb stage count from "11-stage" to match `STAGES.length`
- [ ] 2.3 Update `hosts/claude/SKILL.md` state-machine diagram + "N-stage" language to include `plan-review`, `design-gate`, `visual-gate`, and `needs-human` (full `STAGES` coverage)
- [ ] 2.4 Update `hosts/codex/SKILL.md` the same way (symmetric inventory; host command tokens unchanged)
- [ ] 2.5 Run `node scripts/build.mjs` and include regenerated `plugin/` after Claude host SKILL edits

## 3. Drift-guard test

- [ ] 3.1 Add a core unit test (e.g. `core/test/stage-inventory-docs-ssot.test.ts`) that imports `STAGES` / `TERMINAL_STAGES` and asserts living STAGES-order + terminal membership, host SKILL stage coverage + count language, README count language, and `openspec/project.md` count language
- [ ] 3.2 Prove the test bites: temporarily break one surface (or use a focused assertion) so the failure message names the surface; restore alignment
- [ ] 3.3 Keep the test free of real network/git/subprocess I/O (read files from repo paths only)

## 4. Verification

- [ ] 4.1 Run `cd core && npm test` (or the focused test file) and confirm green
- [ ] 4.2 Run `node scripts/build.mjs --check`
- [ ] 4.3 Run `npm run ci` from repo root and confirm green
- [ ] 4.4 Spot-check: no runtime edits to `STAGES` / `TERMINAL_STAGES` membership or stage-handler behavior
