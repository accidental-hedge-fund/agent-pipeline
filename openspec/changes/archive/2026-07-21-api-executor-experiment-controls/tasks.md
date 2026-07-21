## 1. Config schema and types

- [x] 1.1 Extend `ModelEndpointExecutorDefinition` in `core/scripts/types.ts` with optional
      `dialect`, `params`, `headers`, `reasoning`, and `structured_output`, plus the closed
      dialect enum as a runtime-visible const array (type-stripping means a type-only enum is
      not enforced at runtime).
- [x] 1.2 Add strict parse-time validation in `core/scripts/config.ts`: unknown dialect,
      unknown/mistyped param key, routing option on an unsupporting dialect, `authorization`
      or `content-type` in `headers`, and structured output on an unsupporting dialect — each
      erroring with the offending value named.
- [x] 1.3 Tests in `core/test/config.test.ts` for every rejection above, and for a minimal
      definition still parsing unchanged.

## 2. Request construction

- [x] 2.1 Build the dialect-aware request body in `core/scripts/executors.ts`: base
      `{model, messages}` plus allowlisted params in the dialect's field names; assert the
      no-`params` case is byte-identical to today's payload.
- [x] 2.2 Implement the effort adapter with its three outcomes (encoded / preflight failure /
      recorded unsupported), including the explicit `on_unsupported` opt-in.
- [x] 2.3 Resolve headers (literal vs. `env:` reference) at invocation time; fail preflight on
      a missing referenced variable, naming stage, executor, header, and variable.
- [x] 2.4 Add the structured-output response-format field for review stages on supporting
      dialects, constrained to the single-sourced verdict schema.
- [x] 2.5 Tests: constructed request per dialect, effort outcomes, header resolution and
      preflight failure, structured-output field presence — all through the injected
      `fetchImpl` seam.

## 3. Per-invocation override seam

- [x] 3.1 Add an optional override argument to `invokeStageExecutor` /
      `invokeExternalExecutor` covering model, params, and effort; merge in memory over the
      committed definition.
- [x] 3.2 Validate overrides through the same allowlist/dialect rules and fail before any HTTP
      request is issued.
- [x] 3.3 Tests: override applied, no-override parity with today, invalid override rejected
      with no request issued, two concurrent invocations not interfering.

## 4. Response provenance capture

- [x] 4.1 Verify the real OpenRouter response and header shapes from documentation/captured
      samples before coding against them (golden rule 5); record the confirmed field names in
      the implementation comments.
- [x] 4.2 Extract per-dialect provenance: resolved model, upstream provider, request id,
      finish reason, usage (including cached and reasoning tokens), reported cost, retry and
      rate-limit observations, timing — each nulling out when absent, never derived from
      another field.
- [x] 4.3 Record the sent payload with credential and `env:`-header values redacted, reusing
      the existing `artifact-sanitize` redaction path.
- [x] 4.4 Tests: OpenRouter-shaped response, generic OpenAI-compatible response, response with
      no provider/usage/cost (assert `null`, and assert the provider is not derived from a
      slug prefix), and a redaction test asserting no secret reaches evidence.

## 5. Accounting and execution class

- [x] 5.1 Add the additive optional provenance and execution-class fields to
      `BuildStageAccountingRecordInput` / `StageAccountingRecord`; bump
      `STAGE_ACCOUNTING_SCHEMA_VERSION` with the additive-evolution comment.
- [x] 5.2 Map a provider-reported cost onto the existing `cost_source: actual` classifier; add
      no second cost field or API-only total.
- [x] 5.3 Set the API execution class for `model-endpoint` invocations and the CLI class for
      local-CLI harness invocations.
- [x] 5.4 Tests: reported cost is `actual`, absent cost falls through to the existing
      classification, older records remain readable, absent provenance is omitted rather than
      defaulted.

## 6. Eval runner integration

- [x] 6.1 Bind an API treatment to a named `model-endpoint` executor and derive per-cell
      overrides deterministically from the treatment coordinates.
- [x] 6.2 Classify an invalid-override failure as infra/config, not as a completed treatment
      outcome.
- [x] 6.3 Carry the execution class and endpoint provenance onto the cell record.
- [x] 6.4 Tests: override reaches the request, replay determinism, invalid override
      classification, cell-record class separation.

## 7. Documentation and gate

- [x] 7.1 Add the OpenRouter executor example and the prompt-contained-stage restriction with
      its rationale to the user-facing docs and the SKILL variants under `hosts/`.
- [x] 7.2 Regenerate the mirror: `node scripts/build.mjs`, and commit `plugin/` in the same
      change.
- [x] 7.3 Run `npm run ci` from the repo root and confirm it is green, including
      `openspec validate --all`.
