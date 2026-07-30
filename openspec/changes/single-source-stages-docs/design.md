## Context

Code already has a single runtime authority:

```ts
// core/scripts/types.ts
export const STAGES = [
  "backlog", "ready", "planning", "plan-review", "implementing",
  "design-gate", "review-1", "fix-1", "review-2", "fix-2",
  "pre-merge", "visual-gate", "eval-gate", "shipcheck-gate",
  "ready-to-deploy", "needs-human",
] as const;
export const TERMINAL_STAGES = new Set<Stage>(["ready-to-deploy", "needs-human"]);
```

Unit tests pin this (`core/test/state-transitions.test.ts`). Living OpenSpec and operator docs drifted as stages were added (`plan-review`, `design-gate`, `visual-gate`, `needs-human`, …) without a CI check that prose inventory matches the constant.

| Surface | Current claim | Truth |
|---------|---------------|-------|
| `STAGES` | 16 incl. `needs-human` | authority |
| README | "15-stage" | stale |
| hosts SKILL diagrams | "13-stage"; omits plan-review, design-gate, visual-gate, needs-human | stale |
| `openspec/project.md` | "11-stage" | stale |
| Living STAGES order scenario | stops at `ready-to-deploy` | missing `needs-human` |
| Living TERMINAL requirement | exactly `ready-to-deploy` | missing `needs-human` |

This change is documentation + living-spec alignment + a drift guard. Runtime code constants stay put.

## Goals / Non-Goals

**Goals:**
- Living OpenSpec spine describes the same machine the tests enforce.
- Host SKILL diagrams and count language, README inventory language, and `openspec/project.md` count language match `STAGES` / `TERMINAL_STAGES`.
- A deterministic test fails when any guarded surface diverges again.
- `plugin/` mirror regenerated after host SKILL edits.

**Non-Goals:**
- Changing `STAGES` membership, order, or `TERMINAL_STAGES` (code is already correct).
- Changing stage-handler behavior, transition outcomes, or `needs-human` resume/`--override` semantics (already specified elsewhere).
- Full docs site split (#598) or the full CLI/config generator epic (#597) — this only establishes stage-inventory SSOT so those can consume it later.
- Generating entire SKILL.md / README from templates (too large; out of scope for a focused SSOT fix).
- Auto-generating living OpenSpec files from TypeScript (OpenSpec remains human-authored; the drift test keeps them honest).

## Decisions

### Decision 1: Code constants are the SSOT; docs/specs are consumers

**Chosen**: `STAGES` and `TERMINAL_STAGES` in `core/scripts/types.ts` remain the single authored source of stage inventory. Living OpenSpec, host SKILLs, README, and `project.md` are aligned to them and guarded by tests.

**Alternative considered**: Invert authority so living OpenSpec drives code. Rejected — runtime behavior and existing unit tests already treat TypeScript constants as truth; re-speccing code would expand scope and risk behavior change the issue forbids.

### Decision 2: Drift-guard test over full document generation

**Chosen**: A unit test (or small suite) under `core/test/` that:

1. Imports `STAGES` and `TERMINAL_STAGES` from `types.ts`.
2. Reads living `openspec/specs/pipeline-state-machine/spec.md` and asserts the STAGES-order scenario's listed stages equal `[...STAGES]`, and the terminal requirement names both members of `TERMINAL_STAGES`.
3. Reads `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` and asserts (a) stage-count language matches `STAGES.length`, and (b) the state-machine diagram block contains every stage name from `STAGES` (at least as a required-member check — diagram layout may still use multi-line arrows).
4. Reads `README.md` and `openspec/project.md` and asserts any stage-count claim (`N-stage` / `N-stage state machine`) matches `STAGES.length`, or that no contradictory count remains.

Failure messages name the surface and the missing/extra stage or wrong count so a future stage add is an obvious one-line docs fix.

**Alternative considered**: Generate SKILL diagram / README count snippets from `STAGES` at build time (`build.mjs`). Deferred — desirable feed into #597, but generating prose fragments into hand-maintained SKILL.md is higher churn than a drift test for this issue's "ship without waiting on #597" constraint. The test is the SSOT enforcement mechanism; generation can replace hand prose later without changing requirements.

**Alternative considered**: Only fix docs once, no test. Rejected — this exact class of drift already happened multiple times; without a guard it will recur.

### Decision 3: Diagram shape — full inventory including the off-ramp

**Chosen**: Host SKILL diagrams list the happy-path order through `ready-to-deploy`, and also surface `needs-human` as a terminal off-ramp (e.g. annotated branch or trailing entry consistent with `STAGES` order). Count language uses `STAGES.length` (16), not "happy-path-only" counts.

**Rationale**: Operators need to know `needs-human` exists as a park terminal; agents planning from SKILL.md currently invent a machine missing four real stages. Including every `STAGES` member in the diagram (or an explicit adjacent off-ramp line that still names `needs-human`) satisfies the drift check without implying the advance loop auto-walks into `needs-human` after `ready-to-deploy`.

### Decision 4: Living terminal requirement — dual terminals, dual scenarios

**Chosen**: Replace "Terminal stage is ready-to-deploy" / "exactly `ready-to-deploy`" with a requirement that `TERMINAL_STAGES` is exactly `{ready-to-deploy, needs-human}`:

- `ready-to-deploy` remains the successful autonomous-loop terminal (finalize + stop; human owns merge).
- `needs-human` remains the terminal off-ramp when adversarial rounds exhaust with blocking findings (or other documented park paths); the advance loop stops without promoting to `ready-to-deploy`.

Existing living requirements that already describe `needs-human` resume via `--override` stay; this change only fixes the contradictory "exactly one terminal" spine text.

### Decision 5: Surgical docs edits only

**Chosen**: Edit only the contradictory stage-count strings and state-machine diagrams (plus minimal adjacent prose if a sentence becomes false). Do not restructure README, rewrite host SKILL run-flow sections, or chase every informal stage mention outside the inventory surfaces named in the issue.

## Risks / Trade-offs

- **Diagram layout vs. strict order assertion**: Multi-line ASCII diagrams may not encode a single linear order. Mitigation: require every stage name present; optionally assert relative order of known anchors (`plan-review` after `planning`, `design-gate` after `implementing`, `visual-gate` between `pre-merge` and `eval-gate`, `needs-human` present). Full linear parse is optional if presence + count is robust.
- **False positives on unrelated "N-stage" prose**: Mitigation: scope regex to known inventory sentences (intro blurb, project.md purpose) rather than scanning the entire README for every `N-stage` substring in historical notes.
- **Living-spec archive hygiene**: Pre-merge archives this delta into living specs; the drift test must target living paths so after archive CI still guards the spine.
- **plugin/ forgetfulness**: Host SKILL edits require `node scripts/build.mjs` in the same change; `build.mjs --check` already enforces this for the Claude mirror path.

## Migration plan

1. Update living-spec delta (this change) → implement → archive at pre-merge as usual.
2. One-shot docs alignment + drift test land together so main never has "fixed docs, no guard" or "guard fails on main".
3. No operator migration; no config or label changes.

## Open questions

None blocking. Preferred enforcement is a drift-guard test; if implementers discover a cheap, local snippet generator that fits existing `build.mjs` without expanding into #597, that is an acceptable implementation detail as long as the same surfaces stay consistent and the test still fails on divergence.
