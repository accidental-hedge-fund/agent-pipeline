## 1. Living doctrine document

- [x] 1.1 Add short `docs/ship-path-autonomy.md` covering ship path, recovery ladder, false vs real human, class over site, and anti-goals (constitution length; no epic essay).
- [x] 1.2 Link the doc from `docs/concepts.md` (contents entry + short advanced section).
- [x] 1.3 Cross-link from `docs/supervisor.md` related links (and README advanced index only if a natural one-liner already exists).

## 2. Pinned preamble seam

- [x] 2.1 Add a single versioned constant in `core/scripts/prompts/index.ts` (e.g. `SHIP_PATH_AUTONOMY_PREAMBLE_V1`) with marker `<!-- pipeline-ship-path-autonomy: v1 -->`, tight bullets for recovery ladder / false-vs-real human / class-over-site / anti-goals, coexistence note for surgical fix, and engine-dogfood class-vs-site bar.
- [x] 2.2 Export the constant on `_testing` (or equivalent) for drift asserts.
- [x] 2.3 Inject via `{{ship_path_autonomy_preamble}}` (or equivalent) into templates/builders: planning, planning_openspec, implementing, fix, test_fix, eval_fix, visual_fix, intake, refine-spec, sweep.
- [x] 2.4 Confirm surgical-fix sections remain intact and leading for ordinary findings; preamble does not replace them.

## 3. Supervisor alignment

- [x] 3.1 Update `docs/supervisor.md` failure table so `needs-human` / blocked is conditional: recoverable engine/workflow → expect loop recovery / re-train after recipe; true human-authority → wait / handoff.
- [x] 3.2 Keep non-goals: no supervisor merge authority, no second control plane, no auto_merge.

## 4. Tests and mirror

- [x] 4.1 Add unit tests in `core/test/prompt-loader.test.ts` (or adjacent) asserting every listed builder emits the version marker and critical invariant phrases.
- [x] 4.2 Assert fix-family prompts still contain surgical minimal-diff + destructive guard + self-check when autonomy preamble is present.
- [x] 4.3 Assert planning/intake (or refine-spec/sweep) carry the engine-dogfood class-vs-site bar text.
- [x] 4.4 Assert `docs/ship-path-autonomy.md` exists and is linked from `docs/concepts.md` (lightweight file/link check if no docs-generator pattern covers it).
- [x] 4.5 Run `node scripts/build.mjs` and commit regenerated `plugin/` with any `core/` edits.
- [x] 4.6 Run `openspec validate pin-ship-path-autonomy-doctrine` and `npm run ci`; fix until green.
