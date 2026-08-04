## Why

Three of five built-in adapters (`grok`, `pi`, `opencode`) still declare `telemetry: "none"`, so every primary-implementer call on those adapters records `cost_source: "unknown"`, `resolvedModel: null`, and `throttled: null`. Machine-readable CLI modes exist but were never schema-verified against fixtures (golden rule 5), so adapters stay on plain text. Separately, production invoke hard-codes `cliVersion: null` and never probes `<cli> --version`, so CLI version drift (e.g. grok 0.2.93 → 0.2.114) is invisible in run evidence. Promotion-gate cost ceilings and multi-harness comparison stay uncomputable without honest, provider-neutral production telemetry and treatment identity.

## What Changes

- **Fixture-verified telemetry for adapters that can support it.** Verify each built-in and extension adapter's machine-readable output mode against **recorded fixtures** (not live CLI guessing). Where a schema is verified, declare `telemetry: "jsonl"` (or the contract-equivalent mode), enable the verified output flags, and implement `parseTelemetry` so recovered cost, usage, `resolvedModel`, and `throttled` thread into stage accounting and treatment identity. Where verification fails or the CLI has no documented machine-readable mode, keep `telemetry: "none"` and leave unknowns as unknown — never invent values.
- **Provider-neutral production treatment fingerprint.** Every production harness invocation (built-in or externally registered) records an immutable treatment fingerprint covering: adapter ID and contract version, CLI absolute path and probed version, capability hash, role, requested/resolved model and effort, sandbox/tool policy, prompt- and output-contract versions, fallback state, and failure reason. Provider is recorded only when the CLI actually reports it. No named provider gets a separate telemetry architecture.
- **Telemetry coverage metadata without zero-fill.** Run/stage records expose telemetry coverage class, `cost_source`, usage field classes, and throttling as reported or null/unknown — never zero-filled or fabricated from requested settings.
- **Once-per-run CLI version probe.** Consume the once-per-run binary/version probe surface owned by preflight-on-invoke (#636) rather than adding a second per-call probe. Thread the cached result into `AdapterProbe.cliVersion` (and the fingerprint). Emit a fail-soft compatibility warning when the probed version diverges from the adapter's recorded verified-against version; do not block the stage solely for version drift.
- **Shared surface with evals.** Keep the immutable treatment fingerprint shape and adapter `parseTelemetry` implementations shareable with eval provenance capture (#653). Do not own evals-side per-stage usage/cost fixtures here. Engine/discovery version stamping remains #763.
- **Docs / mirror / CI.** Document operator-visible coverage behavior; regenerate `plugin/` when `core/` changes; `npm run ci` green.

**Non-goals (explicit):**

- Evals-side per-stage usage/cost/provenance capture and its response-shape fixtures (#653 owns; coordinate on shared fixtures, do not duplicate).
- Engine version stamping of artifacts (#763 — engine SHA / discovery attribution, not harness CLI version).
- Eval campaign adapter/provider version freezes (#602 — campaign counterpart; this issue is the production path).
- Expanding production preflight beyond the version/fingerprint probe contract consumed from #636 (full exact-treatment preflight remains #636).
- Autonomous merge, review-policy weakening, or a privileged vendor telemetry path.

## Capabilities

### New Capabilities

- `production-treatment-fingerprint`: Provider-neutral immutable treatment fingerprint for every production harness invocation; once-per-run CLI version probe consumption; telemetry coverage / cost-source / usage-class / throttle honesty without zero-fill; fail-soft verified-against version drift warning; shared fingerprint and parser contract with evals (#653) without owning evals capture.

### Modified Capabilities

- `cli-harness-adapters`: Fixture-verified machine-readable telemetry modes for adapters that declare them; `parseTelemetry` recovers cost/usage/`resolvedModel`/`throttled` only from verified envelopes; treatment description and probe threading of `cliVersion`; no silent fabrication; extension adapters share the same telemetry and fingerprint contract as built-ins.
- `stage-cost-accounting`: Stage accounting records carry threaded `resolved_model`, cost, throttle, adapter CLI version, and telemetry-coverage/cost-source honesty for every adapter that recovers them; unknown stays unknown; no zero-fill of unreported fields.

## Impact

- `core/scripts/harness-adapters/` — grok/pi/opencode (and any other `telemetry: "none"` adapters) telemetry capability, argv mode flags, `parseTelemetry`, verified-against metadata; shared fixtures for envelope schemas; conformance kit expectations for jsonl adapters
- `core/scripts/harness.ts` — stop hard-coding `cliVersion: null`; thread once-per-run probe into `AdapterProbe` and treatment/accounting
- Stage accounting / treatment types and emission paths — fingerprint fields and coverage metadata (additive, unknown-safe)
- Tests: fixture-backed telemetry parsers, version-probe threading, no zero-fill regressions, conformance for flipped adapters
- Coordination seams with #636 (probe producer), #653 (shared fingerprint + parsers), #763 (non-overlap with engine SHA)
- `plugin/` mirror regeneration when `core/` changes; host/docs only if operator-facing coverage behavior is described
- No change to stage state machine, review policy, or merge authority

## Acceptance criteria

Observable, falsifiable outcomes that make #778 done:

- [ ] Recorded fixtures exist for each built-in adapter whose machine-readable mode is claimed; `parseTelemetry` is proven against those fixtures (not against live CLI output alone).
- [ ] Every built-in adapter that passes fixture verification declares telemetry mode enabling machine-readable capture (not `"none"`) and recovers at least the fields the fixture actually contains (cost and/or usage and/or `resolvedModel` and/or `throttled`); fields absent from the fixture remain null/unknown.
- [ ] Built-in adapters that fail verification or lack a documented machine-readable mode remain `telemetry: "none"` with `cost_source: "unknown"` and null resolved/throttle fields — never fabricated from the requested model.
- [ ] A production harness invocation with accounting enabled records non-null `adapter_cli_version` (or equivalent) when the once-per-run version probe succeeds, instead of always recording null.
- [ ] When the probed CLI version diverges from the adapter's recorded verified-against version, a fail-soft compatibility warning is emitted and the stage is not blocked solely for that drift.
- [ ] Stage accounting / treatment records for a fixture-backed jsonl adapter with cost in the envelope use `cost_source: "actual"` (or the existing actual-cost path) and thread `resolved_model` / `throttled` when present in the envelope.
- [ ] Treatment fingerprint fields are recorded for every registered adapter path (built-in and extension/compatibility) without a named-provider-specific telemetry architecture; provider is absent/unknown unless the CLI reports it.
- [ ] Unreported numeric fields are null/omitted — never zero-filled to imply measured zeros.
- [ ] Shared fingerprint shape and adapter parsers are structured so #653 can consume them without a second production parser implementation.
- [ ] `npm run ci` is green; `plugin/` is regenerated and committed with any `core/` change.
