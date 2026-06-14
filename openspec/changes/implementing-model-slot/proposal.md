## Why

The pipeline's `models:` config block lets repos override the Claude alias for `planning`, `review`, and `fix` — but not for `implementing`. Both implementer harness calls in `planning.ts` (lines 226 and 621) pass a bare `model: opts.model`, bypassing the `opts.model ?? cfg.models.<slot>` pattern every other harness call uses. A repo that wants to run the implementer on a different Claude alias has no per-repo way to express that, even though the wiring pattern already exists for every other step.

## What Changes

- Add `implementing: z.string().optional()` to the `models` sub-schema in `PartialConfigSchema` (`config.ts:25–31`).
- Add `implementing: string` to `PipelineConfig.models` and `DEFAULT_CONFIG.models` (`types.ts`), defaulting to `"sonnet"` (the current implicit alias, preserving existing behavior unchanged).
- Wire `model: opts.model ?? cfg.models.implementing` at both implementer call sites (`planning.ts:226` and `planning.ts:621`), matching the pattern used for all other steps.
- Add `{ key: "implementing", role: "implementer" }` to `MODEL_ALIAS_ROLES` (`config.ts:253–257`) so a `models.implementing` set while the implementer harness is `codex` emits the same advisory warning as `planning` and `fix`.
- Document the slot in the generated `.github/pipeline.yml` template comment and in `hosts/claude/SKILL.md` (and `README.md` if it lists slots), making the full four-slot set (`planning`, `implementing`, `review`, `fix`) discoverable.

## Capabilities

### New Capabilities
- (none — this fills a gap in an existing capability without introducing a new behavioral surface)

### Modified Capabilities
- `pipeline-configuration`: The `models:` block gains a fourth slot `implementing`; `resolveConfig()` wires it through to both implementer invocations.
- `config-inert-models-warn`: The inert-alias warning requirement gains a `models.implementing` scenario for when the implementer harness is `codex`.

## Impact

- `core/scripts/config.ts` — `PartialConfigSchema.models`, `MODEL_ALIAS_ROLES`, merge block, YAML template comment.
- `core/scripts/types.ts` — `PipelineConfig.models` type field and `DEFAULT_CONFIG.models` default value.
- `core/scripts/stages/planning.ts` — two implementer invocation sites (lines 226 and 621).
- `hosts/claude/SKILL.md` — per-phase model documentation table.
- `README.md` (if it lists model slots).
- `plugin/` mirror (regenerated; no hand-edits).
- Co-located unit tests in `core/test/`.

## Acceptance Criteria

- [ ] `models: { implementing: "<alias>" }` is accepted by `PartialConfigSchema` and resolves to `config.models.implementing` in the merged `PipelineConfig`.
- [ ] A repo that omits `models` entirely (or omits only `implementing`) gets `config.models.implementing === "sonnet"` — behavior identical to today.
- [ ] Both implementer invocations (`planning.ts:226` and `:621`) use `opts.model ?? cfg.models.implementing`, not a bare `opts.model`.
- [ ] `models.implementing` set while `harnesses.implementer === "codex"` triggers a non-blocking `console.warn` via `warnInertModelAliases`.
- [ ] An unknown key in the `models:` block is still rejected by `.strict()` schema validation (no regression on the existing guard).
- [ ] The `implementing` slot is documented in the generated `pipeline.yml` template comment and in `SKILL.md`.
- [ ] `npm run ci` passes end-to-end after the change.
