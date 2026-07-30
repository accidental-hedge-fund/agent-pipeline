## Why

Stage inventory is multi-sourced and contradicts itself: code `STAGES` has **16** members (including `needs-human`), README claims a **15-stage** machine, host SKILL diagrams claim **13** and omit `plan-review` / `design-gate` / `visual-gate` / `needs-human`, `openspec/project.md` claims **11**, and the living `pipeline-state-machine` spine both omits `needs-human` from the STAGES-order scenario and declares `TERMINAL_STAGES` as exactly `{ready-to-deploy}` while code has `{ready-to-deploy, needs-human}`. Operators and agents plan the wrong machine; a reimplementation from living OpenSpec alone would fail unit tests that pin code truth (`core/test/state-transitions.test.ts`).

## What Changes

- Treat `core/scripts/types.ts` `STAGES` / `TERMINAL_STAGES` as the **runtime and documentation authority** for stage inventory (code does not change; docs and living OpenSpec catch up).
- Align living `pipeline-state-machine`: STAGES order includes `needs-human`; terminal set is `{ready-to-deploy, needs-human}` with `needs-human` documented as the terminal off-ramp (not the happy-path success terminal).
- Align operator-facing inventory language and diagrams:
  - `README.md` stage-count / stage-list language matches `STAGES`
  - `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` state-machine diagrams include `plan-review`, `design-gate`, `visual-gate`, and `needs-human`, with count language matching `STAGES`
  - regenerate `plugin/` mirror after host SKILL edits (`node scripts/build.mjs`)
  - `openspec/project.md` stage-count language matches `STAGES`
- Add a **deterministic drift guard** so any future divergence among `STAGES`/`TERMINAL_STAGES`, living OpenSpec scenarios, host SKILL diagrams, README stage-count language, and `openspec/project.md` fails CI.

## Acceptance criteria

- [ ] Living `pipeline-state-machine` STAGES-order scenario lists every member of code `STAGES` in the same order, including `needs-human`.
- [ ] Living `pipeline-state-machine` terminal requirement states `TERMINAL_STAGES` is exactly `{ready-to-deploy, needs-human}` (not solely `ready-to-deploy`).
- [ ] `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` state-machine diagrams include `plan-review`, `design-gate`, `visual-gate`, and `needs-human`.
- [ ] Host SKILL stage-count language (e.g. "N-stage") equals `STAGES.length` (16).
- [ ] `README.md` stage-count / inventory language is consistent with code `STAGES` (no contradictory "15-stage" claim).
- [ ] `openspec/project.md` stage-count language is consistent with code `STAGES` (no contradictory "11-stage" claim).
- [ ] A unit test fails if any of the guarded surfaces (living STAGES-order scenario, living terminal requirement, host SKILL diagrams/count language, README stage-count language, `openspec/project.md` stage-count language) diverges from `STAGES` / `TERMINAL_STAGES`.
- [ ] After host SKILL edits, `plugin/` is regenerated and `node scripts/build.mjs --check` passes.
- [ ] `npm run ci` is green.
- [ ] No change to runtime stage-handler behavior, transition table, or `STAGES`/`TERMINAL_STAGES` membership (docs + specs + drift guard only; code constants stay as they are).

## Capabilities

### New Capabilities

- `stage-inventory-docs-ssot`: Deterministic single-sourcing contract for stage inventory across code constants, living OpenSpec spine text, host SKILL diagrams, README, and `openspec/project.md`, enforced by a CI drift-guard test.

### Modified Capabilities

- `pipeline-state-machine`: Living STAGES-order scenario and terminal-stage requirement catch up to code truth (`needs-human` in `STAGES`; dual terminal set).

## Impact

- **Docs / specs only** (plus a new or extended unit test): `openspec/specs/pipeline-state-machine/spec.md` (via archive of this change), `openspec/project.md`, `README.md`, `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, regenerated `plugin/`, and a drift-guard test under `core/test/`.
- **No runtime behavior change**: stage handlers, advance loop, labels, and `STAGES` / `TERMINAL_STAGES` constants remain as code already defines them.
- **Downstream**: unblocks #597 (CLI/config generator epic) with a trustworthy stage inventory SSOT; related to #574; does not ship the full docs site (#598) or full generator epic.
- **CI**: new drift-guard test is part of `npm run ci` / `ci:core`.
