## Why

Before v1.15.2, an explicit `models.review` alias was documented as **inert** for a codex
reviewer ("codex ignores it — setting an inert one prints a warning"), so repos harmlessly
carried Claude aliases such as `review: sonnet`. #441 (v1.15.2) changed the semantic: the
reviewer model is now passed through to `codex exec -m <model>`. Explicit (non-`auto`) values
are forwarded verbatim by design, so those pre-existing configs now hard-fail every
review / plan-review stage **mid-run** with a codex 400
(`The 'sonnet' model is not supported when using Codex with a ChatGPT account`) — observed on
run `452-2026-07-21T02-41-01-083Z` (2026-07-21).

This is an upgrade-path regression: a previously-working config becomes a factory-stopping
failure, discovered only after a planning stage's tokens have been burned, and the config
scaffold comment still documents the pre-#441 contract. The engine already knows the value is
impossible (`isClaudeOnlyModelAlias` in `stage-routing.ts`) — it just doesn't check it where
every other impossible-configuration is caught: at config-parse time.

## What Changes

- Reject a Claude-only reviewer model alias (`sonnet`, `opus`, `haiku`, or any `claude-*` id)
  at **config-parse time** when the effective reviewer harness is `codex`, using the existing
  `isClaudeOnlyModelAlias` predicate as the single source of truth. This covers both reviewer
  model sources: `models.review` and the structured `review_harness: { model: … }`.
- The error names the key, the offending value, the reviewer harness, and what *is* valid for
  a codex reviewer: an OpenAI model id the account supports (e.g. `gpt-5.6-terra`, the
  `gpt-5.x-codex` family) or `auto` (round-aware resolution that falls back to the operator's
  `~/.codex/config.toml` default).
- `auto`, an absent key, and any non-Claude (codex-plausible) model id are unchanged.
  A reviewer whose harness is `claude` (or a custom reviewer CLI) is unaffected.
- `pipeline config validate` surfaces the same condition as a severity `error` diagnostic
  (exit 1) rather than the current inert-alias `warning`, so the misconfig is catchable
  without starting a run.
- The `models:` scaffold comment written by `init` / refreshed by `config sync` is corrected
  to the post-#441 contract: the reviewer alias is passed through to both built-in reviewer
  harnesses, and a Claude alias with a codex reviewer is a config error, not an inert setting.

Out of scope: implementer-role aliases (`models.planning` / `implementing` / `fix`), which
remain genuinely inert on codex and keep their advisory warning; any change to how an accepted
model is forwarded to the reviewer CLI.

## Acceptance Criteria

- [ ] `resolveConfig()` throws a config error for `.github/pipeline.yml` containing
      `models: { review: sonnet }` when the effective reviewer harness is `codex`, before any
      stage runs.
- [ ] The error message contains the key path (`models.review`), the rejected value, the
      reviewer harness (`codex`), and names both valid alternatives: a codex-supported OpenAI
      model id and `auto`.
- [ ] The same rejection applies to `review_harness: { command: codex, model: opus }`, naming
      `review_harness.model`.
- [ ] `models: { review: auto }` (this repo's current config, per PR #453) resolves without
      error or warning.
- [ ] An explicit codex-plausible reviewer model (e.g. `gpt-5.6-terra`) resolves unchanged and
      is still forwarded to the reviewer.
- [ ] `models: { review: sonnet }` with a `claude` reviewer harness resolves unchanged — no
      error, no warning.
- [ ] `pipeline config validate` reports the codex/Claude-alias combination as a `severity:
      "error"` diagnostic on path `models.review` and exits 1.
- [ ] The `models:` line in a freshly `init`-scaffolded `.github/pipeline.yml` no longer claims
      the reviewer alias is ignored by codex, and states that a Claude alias with a codex
      reviewer is rejected at parse time; `config sync` refreshes an existing file to that text.
- [ ] Regression tests exist for each of the above and fail without the guard.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `pipeline-configuration`: reject a Claude-only reviewer model alias against a codex reviewer
  at parse time instead of resolving it into a mid-run reviewer invocation.
- `config-validate-command`: classify that combination as an `error` diagnostic rather than an
  inert-setting `warning`.
- `init-command`: correct the scaffolded `models:` comment to the post-#441 contract.

## Impact

- `core/scripts/config.ts` (parse-time validation, `validateConfig` diagnostics, scaffold
  comment rendering), reusing `isClaudeOnlyModelAlias` from `core/scripts/stage-routing.ts`.
- `core/test/config*.test.ts` regression coverage.
- Regenerated `plugin/` mirror.
- Operators upgrading from ≤1.15.1 with an explicit Claude reviewer alias now get a
  parse-time error naming the fix (`auto`) instead of a mid-run codex 400.
