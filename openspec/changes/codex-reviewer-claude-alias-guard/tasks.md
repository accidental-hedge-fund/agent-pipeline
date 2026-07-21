## 1. Parse-time guard

- [ ] 1.1 Add a `validateReviewerModelAlias`-style post-parse check in `core/scripts/config.ts` that, given the file config and the effective reviewer command, rejects a `isClaudeOnlyModelAlias` value on `models.review` and on `review_harness.model`.
- [ ] 1.2 Compose the error message: key path, rejected value, reviewer harness, and the valid alternatives (codex-supported OpenAI model id, or `auto` as the safe default).
- [ ] 1.3 Call it from `resolveConfig()` after the reviewer command is resolved, throwing `Invalid <configPath>: <message>` like the stage-executor check; honor `tolerateInvalidConfig` (warn + fall back) and `quiet`.

## 2. Validate/diagnostics surface

- [ ] 2.1 Mirror the check in `validateConfig()` as a severity `error` diagnostic on the offending key path (with a line number when resolvable), so `pipeline config validate` exits 1.
- [ ] 2.2 Ensure the existing inert-alias `warning` no longer fires for the same key/value when the error already covers it (no duplicate contradictory diagnostics).

## 3. Scaffold comment

- [ ] 3.1 Update the `models:` comment in `renderModelLines()` to the post-#441 contract: the reviewer alias is honored by both built-in reviewer harnesses, and a Claude alias with a codex reviewer is rejected at parse time.
- [ ] 3.2 Confirm `config sync` preview/apply refreshes an existing file to the corrected comment while preserving overrides.

## 4. Tests

- [ ] 4.1 `models.review: sonnet` + codex reviewer → `resolveConfig()` throws, message names key, value, harness, and both valid alternatives.
- [ ] 4.2 `review_harness: { command: codex, model: opus }` → throws, names `review_harness.model`.
- [ ] 4.3 `models.review: auto` and absent `models:` → resolve cleanly (no throw, no warning).
- [ ] 4.4 Explicit codex-plausible model (`gpt-5.6-terra`) → resolves unchanged and is preserved in `config.models.review`.
- [ ] 4.5 `models.review: sonnet` with a `claude` reviewer harness → resolves unchanged.
- [ ] 4.6 `validateConfig()` emits a severity `error` diagnostic on `models.review` for the codex/Claude-alias combination.
- [ ] 4.7 Scaffold-comment assertion covering the corrected `models:` text.
- [ ] 4.8 Verify each regression test fails without the guard.

## 5. Ship

- [ ] 5.1 Regenerate the plugin mirror (`node scripts/build.mjs`) and commit it.
- [ ] 5.2 `openspec validate --all` and `npm run ci` green from the repo root.
