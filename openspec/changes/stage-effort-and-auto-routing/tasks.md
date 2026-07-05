## 1. Schema: effort block, auto sentinel, structured review_harness

- [ ] 1.1 Add `effort: z.object({ planning, implementing, review, fix, intake, sweep }).strict().optional()` to `PartialConfigSchema` (`config.ts`), each key `z.union([z.string(), z.literal("auto")]).optional()`, mirroring the `models` sub-schema shape.
- [ ] 1.2 Change each `models.*` key to `z.union([z.string(), z.literal("auto")]).optional()` so `auto` is accepted for models too.
- [ ] 1.3 Extend `review_harness` to `z.union([z.string(), z.object({ command: z.string(), model: z.union([z.string(), z.literal("auto")]).optional(), effort: z.union([z.string(), z.literal("auto")]).optional() }).strict()])`.
- [ ] 1.4 Add `effort?`, `harnesses.reviewerModel?`, `harnesses.reviewerEffort?` to `PipelineConfig` (`types.ts`).

## 2. Auto routing resolver

- [ ] 2.1 Add a `STAGE_ROUTING` table (`config.ts` or a new `stage-routing.ts`) mapping each of the 8 stages to `{ nature, permanence, harnessRole }`, plus the `(nature, permanence) → (model, effort)` matrix from design.md.
- [ ] 2.2 Implement `resolveAuto(stage, harness, profile)` returning a concrete `{ model, effort }`. Mechanical/Iterative → `gpt-5.5` on codex primary, `sonnet` on claude primary. Adversarial → always `claude-fable-5` (full id). Effort per the table.
- [ ] 2.3 In `resolveConfig()`, compute a resolved per-stage routing map: for each stage take its config value (`models.<key>` / `effort.<key>`, round-aware for review) and expand `auto` via `resolveAuto`. Guarantee no resolved model/effort value equals the literal `"auto"`.

## 3. Harness threading (claude --effort)

- [ ] 3.1 **Verify against the real Claude CLI** whether `claude` accepts `--effort <value>` (golden rule 5 — do not guess). Record the finding; if absent, coordinate on the flag name / flip the inert-effort advisory to claude stages.
- [ ] 3.2 In `harness.ts`, when `harness === "claude"` and `opts.reasoningEffort` is set, append `--effort <value>` to the claude args (parallel to the existing codex `-c model_reasoning_effort` path). Leave codex/custom-CLI paths unchanged.

## 4. Config merge, review_harness unpack, inert-effort warn

- [ ] 4.1 In `resolveConfig()`, merge the resolved `effort` map into `cfg.effort`; unpack structured `review_harness` into `cfg.harnesses.reviewer` / `reviewerModel` / `reviewerEffort` (string shorthand leaves the latter two `undefined`).
- [ ] 4.2 Extend the inert-alias advisory to `effort.*`: warn (non-blocking) when `effort.<key>` is explicitly set for a stage whose backing harness ignores per-stage effort (custom reviewer CLI). Do not mutate resolved config.
- [ ] 4.3 **Decision:** set `DEFAULT_CONFIG.models.review = "claude-fable-5"` (see design.md). If maintainer rejects, keep `"opus"` — no other task depends on this value.

## 5. Stage wiring

- [ ] 5.1 `planning.ts` plan-review call: replace `reasoningEffort: "medium"` with the resolved plan-review effort (from `cfg.effort.planning`, `auto` → `max`). Default-unset resolves to `medium` (behavior preserved).
- [ ] 5.2 Thread resolved per-stage effort into the implementer invokes in `planning.ts` (`planning`, `implementing`) and `fix` stage invokes; absent → no flag.
- [ ] 5.3 `review-routing.ts`: pass `cfg.harnesses.reviewerModel ?? cfg.models.review` and `cfg.harnesses.reviewerEffort ?? cfg.effort?.review` to `invokeReviewer`, round-aware (review-1 Iterative, review-2 Definitive).

## 6. Documentation & template

- [ ] 6.1 Add commented `effort:` and structured `review_harness:` blocks (with the `auto` sentinel) to the generated `.github/pipeline.yml` template (`config.ts` render helpers).
- [ ] 6.2 Document `effort:`, `auto`, and structured `review_harness` in `hosts/claude/SKILL.md` and `README.md` (per-phase model/effort table).

## 7. Tests

- [ ] 7.1 `effort:` block parses under strict schema; an unknown key under `effort:` is rejected.
- [ ] 7.2 Explicit effort value resolves to `cfg.effort.<stage>` and is threaded to invoke (codex `-c model_reasoning_effort`, claude `--effort`) via the harness seam; absent → no flag.
- [ ] 7.3 `auto` accepted for `models.*` and `effort.*`; after `resolveConfig()` no resolved model/effort equals `"auto"`.
- [ ] 7.4 `auto` resolution per stage per profile matches the design.md table (claude vs codex columns); Mechanical/Iterative primary → `sonnet` (claude) / `gpt-5.5` (codex).
- [ ] 7.5 Alternative-harness Adversarial stages resolve model `claude-fable-5` under both profiles; assert no resolved value equals `fable-5`.
- [ ] 7.6 `planning`-key `auto` resolves `planning` stage → `medium` and `plan-review` stage → `max` (per-stage-not-per-key).
- [ ] 7.7 Structured `review_harness: { command, model: auto, effort: auto }` resolves review-1 as Iterative (`claude-fable-5 / high`) and review-2 as Definitive (`claude-fable-5 / max`); string `review_harness: claude` leaves `reviewerModel`/`reviewerEffort` undefined and behaves as today.
- [ ] 7.8 Inert-effort advisory fires when `effort.*` is set for a custom reviewer CLI; is non-blocking; resolved config unchanged. Prove the test bites.
- [ ] 7.9 Regression: `DEFAULT_CONFIG.models.review` equals the ratified default and is the full-id form.

## 8. Mirror + CI

- [ ] 8.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 8.2 Run `npm run ci` from repo root; all checks green (core tests, `build.mjs --check`, install smoke, `openspec validate --all`).
