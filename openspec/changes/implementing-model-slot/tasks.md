## 1. Schema, types, and config merge

- [x] 1.1 Add `implementing: z.string().optional()` to the `models` sub-schema in `PartialConfigSchema` (`config.ts:25–31`), inside the existing `.strict()` block.
- [x] 1.2 Add `implementing: string` to `PipelineConfig.models` (`types.ts:171`) and set `implementing: "sonnet"` in `DEFAULT_CONFIG.models` (`types.ts:270`).
- [x] 1.3 Wire `implementing: fileConfig.models?.implementing ?? DEFAULT_CONFIG.models.implementing` in the `resolveConfig()` merge block (`config.ts:198–202`).

## 2. Inert-alias warning

- [x] 2.1 Add `{ key: "implementing", role: "implementer" }` to `MODEL_ALIAS_ROLES` (`config.ts:253–257`).

## 3. Implementer invocation sites

- [x] 3.1 Change `model: opts.model` → `model: opts.model ?? cfg.models.implementing` at the standard implementer call (`planning.ts:226`).
- [x] 3.2 Change `model: opts.model` → `model: opts.model ?? cfg.models.implementing` at the OpenSpec implementer call (`planning.ts:621`).

## 4. Documentation

- [x] 4.1 Add `#   implementing: ${d.models.implementing} # implementer harness` to the commented `models:` block in the generated `pipeline.yml` template (`config.ts:437–440`), making the full four-slot set explicit.
- [x] 4.2 Add `implementing` to the per-phase model documentation in `hosts/claude/SKILL.md` and in `README.md` if it lists the model slots.

## 5. Tests

- [x] 5.1 Unit test: `models: { implementing: "opus" }` parses under the `.strict()` schema and `resolveConfig()` returns `config.models.implementing === "opus"`.
- [x] 5.2 Unit test: a config that omits `models.implementing` returns `config.models.implementing === "sonnet"` (default preserved).
- [x] 5.3 Unit test: via the harness seam, the standard implementer path (non-OpenSpec) receives `cfg.models.implementing` when `opts.model` is absent.
- [x] 5.4 Unit test: via the harness seam, the OpenSpec implementer path receives `cfg.models.implementing` when `opts.model` is absent.
- [x] 5.5 Regression test: `models.implementing` set while `harnesses.implementer === "codex"` triggers `warnInertModelAliases`, alongside the existing `planning` / `fix` cases. Prove the test bites (fails without the `MODEL_ALIAS_ROLES` entry).

## 6. Mirror + CI

- [x] 6.1 Run `node scripts/build.mjs` to regenerate `plugin/` mirror.
- [x] 6.2 Run `npm run ci` from repo root; all checks green.
