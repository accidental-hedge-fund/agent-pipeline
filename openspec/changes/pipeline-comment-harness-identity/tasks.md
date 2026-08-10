## 1. Harness label parsing

- [x] 1.1 Widen `getHarnessLabel` to return any non-empty `harness:` suffix (drop claude|codex-only filter); keep null when absent
- [x] 1.2 Update `core/test/gh-parsers.test.ts` (and any type-pinned callers) so `harness:grok` / `opencode` / `pi` parse correctly and non-harness labels still return null

## 2. Label bootstrap

- [x] 2.1 Change `ensurePipelineLabels` to create `harness:<name>` for every `BUILTIN_ADAPTER_NAMES` entry (single-source from harness-adapter registry), not only claude/codex
- [x] 2.2 Extend init / ensurePipelineLabels tests (or add a focused unit test) so the desired set includes grok, opencode, and pi

## 3. Config-sourced comment footers

- [x] 3.1 Remove or stop using the Claude-only `COMMENT_FOOTER` hardcode in `gh.ts`
- [x] 3.2 Thread `marker_footer` (or equivalent) into `buildTransitionComment` / `transition` so the rendered body uses `cfg.marker_footer` with the shared `---` separator style
- [x] 3.3 Use the same config-sourced footer on the blocked-comment body builder that currently appends `COMMENT_FOOTER`
- [x] 3.4 Preserve existing attestation and audit-sentinel append order on transition and blocked comments

## 4. Regression coverage and CI

- [x] 4.1 Add/adjust transition-comment tests: `harness:grok` → `**Harness**: grok`; configured `marker_footer` appears; Claude hardcode is not required
- [x] 4.2 Update attestation / review tests that call `buildTransitionComment` for any new footer argument
- [x] 4.3 Run `node scripts/build.mjs` if `core/` changed and include regenerated `plugin/` in the same commit
- [x] 4.4 Run `npm run ci` from the repo root and fix any failures
