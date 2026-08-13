## Context

See proposal.md (Why / What Changes). Recovery code for #1020 / #1025 / #1023 / #1021 is out of scope; this design covers how doctrine is stored, pinned into harness prompts, and reflected in outer-supervisor docs.

Existing seams this change reuses:

- Standing prompt blocks in `core/scripts/prompts/index.ts` (`SEVERITY_RUBRIC`, `SPEC_GENERATION_TOOL_FREE_BLOCK`, …) single-sourced as constants and injected via `{{placeholders}}`.
- Module-init `templateSnapshot` / `getTemplateSnapshot()` so mid-run file edits cannot change prompts for that process (#450 / engine identity).
- Surgical fix instructions already lead `fix.md` and are drift-guarded in `prompt-loader.test.ts`.
- Operator docs: lean README → `docs/concepts.md` companions; supervisor contract in `docs/supervisor.md` (today: unconditional wait on `needs-human` / blocked).

## Goals / Non-Goals

**Goals:**

- One short canonical doctrine file operators and agents share.
- One versioned preamble constant injected into every listed plan / implement / fix / authoring builder.
- Engine-dogfood class-vs-site bar present at prompt level on plan and intake paths.
- Supervisor doc distinguishes recoverable engine/workflow vs true human-authority.
- Drift-guard tests and docs links that fail closed if the memory is deleted.

**Non-Goals:**

- Implementing recovery recipes, train∘loop frontiers, or live-sibling filing (other spine issues).
- Runtime LLM classification of human vs engine in the preamble.
- A new pipeline stage, config key, or merge path.
- Expanding every prompt to include full skill / CLAUDE.md text.
- Deterministic plan-quality CI gate beyond prompt/instruction enforcement (stronger gate is optional later).

## Decisions

### D1 — Living doc is source of truth; preamble is a derived constitution

**Choice:** Author `docs/ship-path-autonomy.md` as the full short doctrine (five points + anti-goals). Keep the injected preamble as a tight bullet constitution (≤ ~40 lines) in code, not by reading the markdown file at prompt-build time.

**Why:** Prompt builders must stay deterministic, offline, and pin-friendly. Reading docs at build time couples unit tests to filesystem layout and risks mid-run drift if docs are edited while a long process is up. A constant matches existing shared blocks and is part of the same module graph as `templateSnapshot` (template bodies still pin; constant text is code-versioned with the engine).

**Alternatives considered:**

- Inject by `fs.readFileSync("docs/ship-path-autonomy.md")` each build — rejected: couples docs path, hurts unit isolation, mid-run edit risk.
- Duplicate full essay into every template file — rejected: drift across stages; issue requires single seam.

**Discipline:** When the doctrine version bumps (e.g. v1 → v2), update the doc, the constant (including marker `<!-- pipeline-ship-path-autonomy: vN -->`), and the tests in the same change. Implementation SHOULD add a one-line comment in the constant pointing at `docs/ship-path-autonomy.md`.

### D2 — Injection surface: listed builders only

**Choice:** Inject into:

| Stage family | Builders |
|---|---|
| Plan | `buildPlanningPrompt`, `buildPlanningOpenspecPrompt` |
| Implement | `buildImplementingPrompt` |
| Fix | `buildFixPrompt`, `buildTestFixPrompt`, `buildEvalFixPrompt`, `buildVisualFixPrompt` |
| Authoring | `buildIntakePrompt`, `buildRefineSpecPrompt`, `buildSweepPrompt` |

Do **not** inject into pure review-verdict builders (standard / adversarial / delta / shipcheck / plan_review) unless a later issue asks — those stages must stay verdict-focused and already carry large shared blocks.

**Why:** Issue names plan / implement / fix / intake and related authoring that mint the next engine issue. Review prompts already have severity/confidence discipline; extra autonomy essay there would dilute review contracts.

**Mechanism:** One exported/testable constant (e.g. `SHIP_PATH_AUTONOMY_PREAMBLE_V1`) and a shared placeholder such as `{{ship_path_autonomy_preamble}}` in the listed templates. Add the constant to `_testing` for byte-for-byte drift asserts where useful.

### D3 — Surgical fix coexistence

**Choice:** Place the autonomy preamble **after** conventions and **without** replacing the “Surgical Fix Discipline” section. Wording in the preamble MUST state that for ordinary product review findings, surgical minimal-diff remains in force; factory-class / engine-recovery / self-host work uses class-over-site judgment (shared classifier/recipe/controller) instead of pure path-local moles.

**Why:** Issue and living surgical-fix-rounds spec forbid weakening product review fix discipline. Tests assert both marker **and** surgical keywords still present in fix-family builds.

### D4 — Engine-dogfood planning bar at prompt level

**Choice:** Include in the preamble (or a small adjacent plan/intake-only clause) a requirement that when the issue is clearly engine/pipeline self-host or ship-path recover (labels/theme, body markers, or agent-pipeline domain dogfood), the plan or intake body MUST answer:

1. class vs site,
2. which shared classifier / recipe / gate / controller changes,
3. how the next identical fault does not need a new mole issue.

Spot-fix-only plans are called insufficient for that class.

**Enforcement:** Prompt/instruction level only in this change (smallest enforceable seam already used for plan quality). No new plan-review stage or deterministic checklist parser unless implementation finds a zero-cost existing hook; stronger gates remain follow-up.

### D5 — Supervisor doc alignment only

**Choice:** Edit the failure table in `docs/supervisor.md` so `needs-human` / blocked is conditional:

- Recoverable engine/workflow class → expect loop recovery / re-train after deterministic recipe; do not treat as operator file-delete janitor.
- True human-authority / product judgment → wait / handoff (#647).

Link the living doctrine doc. Do not add merge flags, grant schemas, or a second scheduler.

### D6 — Docs index

**Choice:** Link from `docs/concepts.md` (contents + short section). Optionally one line from README advanced area and from `docs/supervisor.md` related links — no new generator requirement unless `docs:check` already has a pattern for companion presence; if not, a unit/docs existence assert or concepts link test is enough for acceptance.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Preamble bloat degrades every stage | Hard length target; constitution only; version bump requires deliberate edit |
| Autonomy text misread as “always broaden fix” | Explicit coexistence language + surgical drift tests on fix-family |
| Constant drifts from living doc | Version marker + comment pointer; same-PR update rule in tasks |
| Outer supervisors ignore doc update | Keep change localized to the existing failure table (high-visibility); no second playbook fork |
| Over-injection into review prompts | Explicit non-list in D2 |

## Migration Plan

1. Land docs + preamble + tests in one PR; regenerate `plugin/`.
2. No runtime config migration; no label changes; no data migration.
3. Rollback = revert the PR (prompts and docs go together).

## Open Questions

None that block specs or tasks. Optional later: deterministic plan-quality checklist for engine-dogfood class (out of scope for #1030 if prompt bar is present).
