## 1. Shared probe and fingerprint types

- [ ] 1.1 Define the provider-neutral treatment fingerprint type (fields per design decision 2) and a pure builder that takes declaration/probe/request/invocation/telemetry/role/policy inputs without GitHub or eval-executor coupling
- [ ] 1.2 Add structured verified-against CLI identity metadata for built-in adapters (machine-readable, test-accessible) alongside existing header comments
- [ ] 1.3 Implement or wire a once-per-run (per CLI identity) version/binary probe helper shared with #636; cache results; never spawn per-call solely for version
- [ ] 1.4 Unit-test fingerprint purity, null-safe missing fields, and no provider inference from model name

## 2. Fixture corpus and parseTelemetry verification

- [ ] 2.1 Choose the shared fixture root (coordinate path with #653) and add recorded envelope fixtures for each candidate machine-readable mode (grok json / streaming-json, pi json mode, opencode format json; keep claude/codex regressions covered)
- [ ] 2.2 Implement or upgrade `parseTelemetry` for each adapter only against those fixtures; prove assistant-text recovery and claimed cost/usage/resolvedModel/throttled classes; unparseable → nulls without throw
- [ ] 2.3 Add regression tests that `resolvedModel` is never echoed from request and `throttled`/`fallback` are never fabricated false
- [ ] 2.4 For each adapter that fails honest verification, leave `telemetry: "none"` and document the disposition in adapter header / verified-against metadata

## 3. Flip verified adapters and thread probe into invoke

- [ ] 3.1 For each fixture-green adapter: set `capabilities.telemetry` / declaration to jsonl (or equivalent), enable verified output-mode flags in `buildInvocation`, honor existing telemetry kill-switch pattern where applicable
- [ ] 3.2 Update golden-argv (or flag-shape) tests for flipped adapters
- [ ] 3.3 Thread cached probe `cliVersion` (and absolute path when available) into `AdapterProbe` in `harness.ts` invoke accounting path; stop hard-coding null when probe succeeded
- [ ] 3.4 Emit fail-soft compatibility warning when probed version diverges from verified-against; unit-test warn-without-block

## 4. Stage accounting and coverage honesty

- [ ] 4.1 Ensure stage accounting records actual cost from any fixture-verified jsonl adapter (not claude-only branches); tokens-without-cost stay non-actual
- [ ] 4.2 Persist `adapter_cli_version`, `resolved_model`, and `throttled` only when known; no zero-fill of unreported numerics
- [ ] 4.3 Attach fingerprint / telemetry-coverage metadata to accounting or treatment surfaces additively; readers treat absent as unknown
- [ ] 4.4 Unit-test accounting emission with fakes for grok/pi/opencode-style recovered and unrecovered envelopes

## 5. Conformance, extension parity, and evals seam

- [ ] 5.1 Extend shared conformance kit expectations for jsonl-declared adapters (fixture/non-throw/no invented resolved model) without vendor name branches
- [ ] 5.2 Confirm extension and compatibility adapters use the same fingerprint and probe threading path
- [ ] 5.3 Export or document the shared builder + `parseTelemetry` import path for #653; do not implement evals cell capture here

## 6. Docs, mirror, and CI

- [ ] 6.1 Document operator-visible coverage behavior, version-drift warning, and that unknown stays unknown (host skill / config reference only if operator-facing)
- [ ] 6.2 Regenerate `plugin/` with `node scripts/build.mjs` after any `core/` change; commit mirror with source
- [ ] 6.3 Run `npm run ci` and fix failures until green
