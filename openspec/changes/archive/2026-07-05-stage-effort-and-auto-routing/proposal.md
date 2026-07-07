## Why

The pipeline can already set a per-stage Claude **model** alias (`models:` in `.github/pipeline.yml`), but it has no equivalent control for reasoning **effort**, and no way to let the config derive good routing automatically. Three concrete gaps (issue #366):

1. **No per-stage effort setting.** Effort is hardcoded in exactly one place — `planning.ts` passes `reasoningEffort: "medium"` for plan-review — and nowhere else. Every other stage runs at the harness operator's global effort with no per-stage override. `harness.ts` already threads `reasoningEffort` for codex (`-c model_reasoning_effort=<v>`); there is no parallel `effort:` config block and no `--effort` path for claude.

2. **`review_harness` has no model or effort control.** `review_harness` overrides the reviewer CLI, but the model still comes from `cfg.models.review` and there is no effort override at all — the alternative reviewer cannot be pointed at a different model/effort than the primary review slot.

3. **No intelligent defaults.** Both `models:` and the proposed `effort:` block accept only explicit strings. There is no `auto` sentinel that derives model + effort from each stage's known task-nature, output-permanence, and harness assignment.

## What Changes

- Add an optional `effort:` block to `PartialConfigSchema`, parallel to `models:`, with the same per-stage key set (`planning`, `implementing`, `review`, `fix`, `intake`, `sweep`). Each key is optional; absent keys emit no effort flag (operator's global setting applies).
- Accept the string sentinel `"auto"` as a valid value for every `models.*` and `effort.*` key. `auto` is resolved to a concrete `(model, effort)` at **config-load time** via a stage routing matrix; no stage code ever sees the literal string `"auto"`.
- Resolve `auto` per a fixed routing matrix keyed on **task nature** (Mechanical / Analytical / Adversarial) × **output permanence** (Ephemeral / Iterative / Definitive), with the resolved model constrained by the stage's **harness assignment** (a claude-only alias is never emitted for a codex-backed stage, and vice versa).
- Thread the resolved per-stage effort through the existing `harness.ts` invoke path: codex via `-c model_reasoning_effort=<v>` (already present), claude via a new `--effort <v>` flag.
- Extend `review_harness` to accept a structured form `{ command, model?, effort? }` alongside the existing string shorthand, unpacking into `cfg.harnesses.reviewer` / `reviewerModel` / `reviewerEffort`. The alternative reviewer resolves `auto` **round-aware**: review-1 as Iterative, review-2 and plan-review as Definitive.
- Migrate the hardcoded `reasoningEffort: "medium"` at the plan-review call site to the resolved `cfg.effort.planning` value (this supersedes the current non-overridable medium cap — see **Conflicts**).
- Extend the inert-alias advisory to `effort.*`: warn when an `effort.*` value is set for a stage whose backing harness ignores per-stage effort.
- **Decision:** update `DEFAULT_CONFIG.models.review` from `"opus"` to `"claude-fable-5"` (see design.md — this is the one behavior-changing default and needs explicit maintainer ratification).

## Conflicts (must be resolved, sources cited)

1. **Existing `plan-review-effort-controls` spec forbids making the plan-review effort configurable.** Its requirement *"Plan-review codex invocation SHALL cap reasoning effort to medium … SHALL NOT be overridable via `pipeline.yml`"* directly contradicts acceptance criterion "plan-review effort migrated to `cfg.effort.planning`". This change **supersedes** that requirement (REMOVED + replaced). The cap is replaced by an operator-controllable value that still defaults to `medium` when unset.

2. **The issue's "the reviewer always runs claude" premise vs. the shipped profiles.** Under `profiles/claude.json` the reviewer harness is `codex` (cross-harness review); under `profiles/codex.json` it is `claude`. So an `auto`-resolved `claude-fable-5` reviewer model is only *honored* when the reviewer harness is claude; when it is codex it is inert and warned (existing `warnInertModelAliases` behavior). The resolution is still profile-independent (the resolved string is always `claude-fable-5`); whether it takes effect is an operator concern governed by the existing inert-model advisory. This is documented, not averaged away.

3. **The "warn when effort is set for a codex stage" criterion rests on a false premise.** codex *honors* per-stage effort today (`harness.ts:128`, `-c model_reasoning_effort`); claude currently *ignores* it (`harness.ts:77`) and only starts honoring it once this change adds `--effort`. The genuinely inert case for `effort.*` is a **custom reviewer CLI** (which honors neither `--model` nor `--effort`), not codex. The spec encodes the honest inert case and design.md flags the discrepancy for maintainer confirmation.

## Impact

- `core/scripts/config.ts` — `PartialConfigSchema` (`effort:` block, `auto` sentinel, structured `review_harness`), `resolveConfig()` merge + auto-resolution, `warnInertModelAliases` extension, generated `pipeline.yml` template comments.
- `core/scripts/types.ts` — `PipelineConfig` (`effort`, `harnesses.reviewerModel`, `harnesses.reviewerEffort`), `DEFAULT_CONFIG.models.review`.
- `core/scripts/harness.ts` — claude `--effort <value>` flag in the invoke path.
- `core/scripts/stages/planning.ts` — plan-review effort from `cfg.effort.planning` (was hardcoded `"medium"`); thread resolved effort into implementer invokes.
- `core/scripts/stages/review-routing.ts` — pass `reviewerModel`/`reviewerEffort` (round-aware) to `invokeReviewer`.
- `hosts/claude/SKILL.md`, `README.md` — document `effort:`, `auto`, and structured `review_harness`.
- `plugin/` mirror (regenerated via `node scripts/build.mjs`; no hand-edits).
- Co-located unit tests in `core/test/`.

## Acceptance Criteria

- [ ] The `effort:` block is accepted in `.github/pipeline.yml`; an unknown key under `effort:` is rejected by strict schema validation.
- [ ] A per-stage explicit effort value is threaded to the harness invoke (codex `-c model_reasoning_effort=<v>`, claude `--effort <v>`); an absent key emits no effort flag.
- [ ] `"auto"` is accepted for any `models.*` or `effort.*` key and passes strict validation.
- [ ] `auto` is resolved at config-load time; no stage code ever receives the literal string `"auto"` for a model or effort value.
- [ ] `auto` resolution respects harness assignment: a Mechanical/Iterative stage on the **claude** primary harness resolves to `sonnet / low` (not `gpt-5.5 / low`); on the **codex** primary harness it resolves to `gpt-5.5 / low`.
- [ ] `auto` resolution for the alternative (reviewer) harness is profile-independent: Adversarial stages always resolve model to `claude-fable-5` regardless of `--profile`.
- [ ] Every resolved `auto` value for an Adversarial stage uses the full model id `claude-fable-5` (never the unrecognized short alias `fable-5`).
- [ ] `review_harness: claude` (string shorthand) resolves exactly as today — no behavior change.
- [ ] `review_harness: { command, model: auto, effort: auto }` resolves round-aware: review-1 as Iterative (`claude-fable-5 / high`) and review-2 as Definitive (`claude-fable-5 / max`).
- [ ] `planning.ts` plan-review effort is sourced from resolved `cfg.effort.planning` (defaulting to `medium` when unset), replacing the hardcoded `"medium"`.
- [ ] Unit tests cover: explicit values; `auto` resolution per stage per profile; structured `review_harness`; round-aware reviewer resolution; the `fable-5` → `claude-fable-5` guard.
- [ ] A config advisory is emitted when `effort.*` is set for a stage whose backing harness ignores per-stage effort (a custom reviewer CLI); the advisory is non-blocking and does not mutate resolved config.
- [ ] The `DEFAULT_CONFIG.models.review` decision is documented in design.md; a regression test pins the chosen default and asserts the full-id form.
- [ ] `npm run ci` passes end-to-end (core tests, `build.mjs --check` mirror sync, install smoke, `openspec validate --all`).
