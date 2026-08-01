## Why

Stage inventory is multi-sourced and contradicts itself across code, README, host
SKILL surfaces, `openspec/project.md`, and the living `pipeline-state-machine`
spine. Operators and agents plan the wrong machine; living OpenSpec text can be
read as requiring a machine the unit tests would fail if reimplemented from that
text alone. Code is the truth (`STAGES` has 16 entries including `needs-human`;
`TERMINAL_STAGES` is `{ready-to-deploy, needs-human}`), but docs and the living
spine lag. This change single-sources that inventory and drift-guards it so the
divergence cannot recur silently.

## What Changes

- Align **living** `pipeline-state-machine` requirements with code truth:
  - Canonical `STAGES` order includes `needs-human` (after `ready-to-deploy` in
    the constant, as the terminal off-ramp).
  - `TERMINAL_STAGES` is the set `{ready-to-deploy, needs-human}` — not a
    singleton of only `ready-to-deploy`.
- Align **operator/agent surfaces** so each lists or diagrams the same stage
  inventory code owns:
  - `README.md` stage-count language (today “15-stage”).
  - `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` (today “13-stage” diagrams
    omitting `plan-review`, `design-gate`, `visual-gate`, `needs-human`).
  - `openspec/project.md` (today “11-stage”).
  - Regenerated `plugin/` mirror of the Claude host skill.
- Add a **deterministic drift guard** (prefer a co-located test under
  `core/test/`) that fails when any of those surfaces diverge from
  `STAGES` / `TERMINAL_STAGES` in `core/scripts/types.ts`. Optional generation
  of doc fragments from `STAGES` is allowed if it reduces hand-maintenance, but
  is not required if a drift test alone keeps surfaces honest.
- **No runtime stage-machine behavior change.** Code already has the correct
  inventory; this change does not remove, rename, or reorder runtime stages,
  does not add auto-merge, and does not wait on the full docs-site (#598) or
  CLI/config generator epic (#597).

## Capabilities

### New Capabilities

- `stage-inventory-ssot`: Single source of truth for the pipeline stage list and
  terminal set across code, host SKILL docs, README, `openspec/project.md`, and
  the living `pipeline-state-machine` spine, plus the drift guard that keeps
  those surfaces from diverging.

### Modified Capabilities

- `pipeline-state-machine`: Update the canonical `STAGES` order scenario to
  include `needs-human`, and re-spec the terminal requirement so
  `TERMINAL_STAGES` is exactly `{ready-to-deploy, needs-human}` (matching code
  and `state-transitions.test.ts`), without changing advance-loop never-merge
  or happy-path finalize-at-`ready-to-deploy` behavior.

## Impact

- **Docs / specs:** `README.md`, `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`,
  `openspec/project.md`, living `openspec/specs/pipeline-state-machine/spec.md`
  (via archive of this change’s deltas).
- **Generated mirror:** `plugin/` via `node scripts/build.mjs` after host skill
  edits.
- **Tests:** new drift-guard test(s) under `core/test/`; existing
  `state-transitions.test.ts` remains the runtime pin and is not weakened.
- **Out of scope:** full docs site (#598); full CLI/config generator epic (#597)
  — this change blocks/feeds #597 but ships standalone; no runtime stage
  handler changes; no merge/auto-merge path.

## Acceptance Criteria

- [ ] Living `pipeline-state-machine` STAGES-order requirement lists every
      member of code `STAGES` in the same order, including `needs-human`.
- [ ] Living `pipeline-state-machine` terminal requirement states
      `TERMINAL_STAGES` is exactly `{ready-to-deploy, needs-human}` (not a
      singleton of only `ready-to-deploy`).
- [ ] `README.md` stage-count (or equivalent inventory language) matches the
      length and membership of code `STAGES` (or an explicit, drift-guarded
      wording that does not under-count stages).
- [ ] `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` state-machine diagrams
      (or equivalent stage lists) include `plan-review`, `design-gate`,
      `visual-gate`, and `needs-human` and do not claim a stage count that
      contradicts code `STAGES`.
- [ ] `openspec/project.md` no longer claims an “11-stage” machine; its stage
      inventory language matches code truth.
- [ ] A co-located drift-guard test under `core/test/` fails if any of
      README / host SKILL / `openspec/project.md` / the living spine’s pinned
      stage-order or terminal-set text diverges from `STAGES` /
      `TERMINAL_STAGES`; the test bites (fails before the surfaces are fixed).
- [ ] `node scripts/build.mjs --check` passes (plugin mirror carries Claude
      host skill updates) and `npm run ci` is green.
- [ ] No runtime change to stage handlers, `STAGES` membership, or
      `TERMINAL_STAGES` set relative to current code truth; no auto-merge path
      introduced.
