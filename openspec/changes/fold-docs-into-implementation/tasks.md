## 1. Remove docs harness from pre_merge.ts

- [x] 1.1 Delete the `DOCS_COMMIT_PREFIX` constant and the `docsAlreadyUpdated` private function from `core/scripts/stages/pre_merge.ts`
- [x] 1.2 Delete `updateDocs`, `enforceDocsOnlyGate`, and `enforceDocsCommitMessageGate` from `core/scripts/stages/pre_merge.ts`
- [x] 1.3 Remove the Step 1 docs block (lines 98–110) from `advance()` in `pre_merge.ts`
- [x] 1.4 Remove the docs-commit branch from `isPipelineInternalCommit` so only the `OPENSPEC_ARCHIVE_PREFIX` branch remains; update the function's JSDoc comment accordingly
- [x] 1.5 Remove the `buildDocsUpdatePrompt` import from `pre_merge.ts`

## 2. Delete the docs prompt template and builder

- [x] 2.1 Delete `core/scripts/prompts/docs_update.md`
- [x] 2.2 Delete `buildDocsUpdatePrompt` and `BuildDocsArgs` from `core/scripts/prompts/index.ts`

## 3. Add docs instruction to the implementing prompt

- [x] 3.1 Add a `{{docs_instruction}}` placeholder to `core/scripts/prompts/implementing.md` at an appropriate position (after the instructions list, before the Important block)
- [x] 3.2 Define the docs instruction text (list the files to check: README, CLAUDE.md, config docs, docstrings in changed files, env/config examples)
- [x] 3.3 Update `BuildImplementingArgs` in `core/scripts/prompts/index.ts` to accept `docsEnabled: boolean`
- [x] 3.4 Update `buildImplementingPrompt` to substitute `{{docs_instruction}}` with the docs paragraph when `docsEnabled` is `true`, or an empty string when `false`
- [x] 3.5 Update the `buildImplementingPrompt` call site in `core/scripts/stages/implementing.ts` to pass `docsEnabled: cfg.steps.docs`

## 4. Update config comment

- [x] 4.1 Update the `docs:` comment in `DEFAULT_CONFIG` / the generated pipeline.yml template in `core/scripts/config.ts` from "docs-update pass in pre-merge" to "include docs update instruction in implementing prompt"

## 5. Replace the pre-merge-docs test file

- [x] 5.1 Delete `core/test/pre-merge-docs.test.ts`
- [x] 5.2 Create `core/test/pre-merge-single-ci-cycle.test.ts` with a test that mocks the pre-merge `advance()` happy path and asserts it never returns `{ status: "waiting", reason: "docs pushed; CI needs to re-run" }`
- [x] 5.3 Add a test to the new file that asserts `isPipelineInternalCommit` matches only the openspec-archive prefix and does NOT match a `docs: update documentation for #N` message

## 6. Regenerate the plugin mirror

- [x] 6.1 Run `node build.mjs` (or the repo's plugin-build command) to regenerate `plugin/` from core
- [x] 6.2 Verify the plugin mirror contains no reference to `buildDocsUpdatePrompt`, `docs_update`, or `DOCS_COMMIT_PREFIX`

## 7. Verify and CI

- [x] 7.1 Run `pnpm typecheck` — no type errors
- [x] 7.2 Run `pnpm test` — all tests pass (pre-merge-docs tests removed, new tests green)
- [x] 7.3 Confirm no remaining references to `buildDocsUpdatePrompt`, `DOCS_COMMIT_PREFIX`, or `docsAlreadyUpdated` in the codebase
