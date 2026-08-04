## 1. Shared probe and fingerprint types

- [x] 1.1 Define the provider-neutral treatment fingerprint type (fields per design decision 2) and a pure builder that takes declaration/probe/request/invocation/telemetry/role/policy inputs without GitHub or eval-executor coupling
- [x] 1.2 Add structured verified-against CLI identity metadata for built-in adapters (machine-readable, test-accessible) alongside existing header comments
- [x] 1.3 Implement or wire a once-per-run (per CLI identity) version/binary probe helper shared with #636; cache results; never spawn per-call solely for version
- [x] 1.4 Unit-test fingerprint purity, null-safe missing fields, and no provider inference from model name

## 2. Fixture corpus and parseTelemetry verification

- [x] 2.1 Choose the shared fixture root (coordinate path with #653) and add recorded envelope fixtures for each candidate machine-readable mode (grok json / streaming-json, pi json mode, opencode format json; keep claude/codex regressions covered)
- [x] 2.2 Implement or upgrade `parseTelemetry` for each adapter only against those fixtures; prove assistant-text recovery and claimed cost/usage/resolvedModel/throttled classes; unparseable → nulls without throw
- [x] 2.3 Add regression tests that `resolvedModel` is never echoed from request and `throttled`/`fallback` are never fabricated false
- [x] 2.4 For each adapter that fails honest verification, leave `telemetry: "none"` and document the disposition in adapter header / verified-against metadata

## 3. Flip verified adapters and thread probe into invoke

- [x] 3.1 For each fixture-green adapter: set `capabilities.telemetry` / declaration to jsonl (or equivalent), enable verified output-mode flags in `buildInvocation`, honor existing telemetry kill-switch pattern where applicable
- [x] 3.2 Update golden-argv (or flag-shape) tests for flipped adapters
- [x] 3.3 Thread cached probe `cliVersion` (and absolute path when available) into `AdapterProbe` in `harness.ts` invoke accounting path; stop hard-coding null when probe succeeded
- [x] 3.4 Emit fail-soft compatibility warning when probed version diverges from verified-against; unit-test warn-without-block

## 4. Stage accounting and coverage honesty

- [x] 4.1 Ensure stage accounting records actual cost from any fixture-verified jsonl adapter (not claude-only branches); tokens-without-cost stay non-actual
- [x] 4.2 Persist `adapter_cli_version`, `resolved_model`, and `throttled` only when known; no zero-fill of unreported numerics
- [x] 4.3 Attach fingerprint / telemetry-coverage metadata to accounting or treatment surfaces additively; readers treat absent as unknown
- [x] 4.4 Unit-test accounting emission with fakes for grok/pi/opencode-style recovered and unrecovered envelopes

## 5. Conformance, extension parity, and evals seam

- [x] 5.1 Extend shared conformance kit expectations for jsonl-declared adapters (fixture/non-throw/no invented resolved model) without vendor name branches
- [x] 5.2 Confirm extension and compatibility adapters use the same fingerprint and probe threading path
- [x] 5.3 Export or document the shared builder + `parseTelemetry` import path for #653; do not implement evals cell capture here

## 6. Docs, mirror, and CI

- [x] 6.1 Document operator-visible coverage behavior, version-drift warning, and that unknown stays unknown (host skill / config reference only if operator-facing)
- [x] 6.2 Regenerate `plugin/` with `node scripts/build.mjs` after any `core/` change; commit mirror with source
- [x] 6.3 Run `npm run ci` and fix failures until green
