## 1. Capability surface and declaration lockstep

- [x] 1.1 Add `maxPromptBytes` to `AdapterCapabilities` in `core/scripts/harness-adapters/types.ts` with a single documented encoding for finite | unlimited | unknown (JSON-friendly for doctor `--json` and extension manifests).
- [x] 1.2 Single-source the finite argv ceiling next to `MAX_ARG_STRLEN` (NUL-aware comparison rule matching the #492 `runCapped` guard) and document whether refusal is `>` or `>=` the declared limit.
- [x] 1.3 Update `buildAdapterDeclaration` so `declaration.prompt.sizeLimit` stays lockstep with `maxPromptBytes` + delivery channel (one source of truth; no dual enum that can disagree).
- [x] 1.4 Extend the shared conformance kit to fail missing `maxPromptBytes`, unknown-required cases as specified, and incoherent channel/limit pairs by naming the field.

## 2. Built-in and compatibility adapter declarations

- [x] 2.1 Declare unlimited `maxPromptBytes` on `claude`, `codex`, and `grok` (stdin/file channels).
- [x] 2.2 Declare finite `maxPromptBytes` on `pi` and `opencode` (argv); re-verify each CLI’s help/docs for message-replacing stdin/prompt-file and record the finding in the adapter header comment without inventing a channel.
- [x] 2.3 Declare finite-by-default `maxPromptBytes` on the custom-reviewer compatibility adapter; when `promptDelivery: "stdin"` is configured, declare unlimited coherent with that channel.
- [x] 2.4 Update any golden-argv / capability fixtures that assert declaration shape so they include `maxPromptBytes`.

## 3. Stage preflight-before-invoke enforcement

- [x] 3.1 Implement a shared helper that measures UTF-8 byte length of the fully materialized prompt and compares it to the assigned adapter’s `maxPromptBytes`.
- [x] 3.2 Wire the helper at the production invoke / preflight-before-invoke choke point so every local-CLI prompt-bearing path is covered (prefer `invoke()` or immediately above it).
- [x] 3.3 On finite oversize or unknown limit: refuse before spawn with a typed capability failure naming adapter, declared limit, measured size, and remedy; do not set bare `spawn_error` as the primary classification.
- [x] 3.4 Confirm unlimited adapters are not refused by this check for length alone; leave prompt content and non-size behavior unchanged.
- [x] 3.5 Keep the existing #492 `runCapped` per-argv-element oversize guard intact as residual safety.

## 4. Doctor reporting and coherence

- [x] 4.1 Add a doctor check that reports assigned adapters’ prompt-delivery channel and `maxPromptBytes` in human summary and `--json`.
- [x] 4.2 Fail the check on missing, unknown (when assigned), or incoherent channel/limit declarations with named remediation.
- [x] 4.3 For finite argv-bound assigned adapters, include remediation that production review/fix prompts commonly exceed ~128 KiB.
- [x] 4.4 Ensure run-start preflight (when enabled) aborts on this check failure without substituting another harness.

## 5. Tests

- [x] 5.1 Unit tests: conformance requires `maxPromptBytes`; argv+unlimited and missing field fail the kit (prove the test fails without the implementation).
- [x] 5.2 Unit tests: finite oversize refuses before spawn with measured size and typed failure; under-limit does not; unlimited large prompt is not size-refused by the new check.
- [x] 5.3 Unit tests: unknown limit fails closed at dispatch.
- [x] 5.4 Unit tests: doctor coherence pass/fail and JSON field presence via injected deps (no real network/git/subprocess).
- [x] 5.5 Boundary tests at limit−1 / limit / limit+1 aligned with the shared `MAX_ARG_STRLEN` comparison rule and residual `runCapped` guard.

## 6. Mirror, CI, and docs touchpoints

- [x] 6.1 Run `node scripts/build.mjs` and commit regenerated `plugin/` with any `core/` edits.
- [x] 6.2 Run `npm run ci` from repo root and fix failures until green.
- [x] 6.3 If host skill or config schema docs enumerate adapter capabilities, add a one-line note that adapters declare `maxPromptBytes` (only where such docs already list capabilities — do not expand scope into full docs rewrite).
