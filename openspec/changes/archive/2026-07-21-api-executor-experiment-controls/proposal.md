## Why

The `model-endpoint` executor (#314) sends the smallest possible OpenAI-compatible
request — `{model, messages}` — and keeps nothing from the response but
`choices[0].message.content`. That is fine as a "point a review stage at a local
Ollama" escape hatch, but it is not usable as an **experiment treatment**. With
#432 the pipeline can now hold everything but the treatment constant across cells;
an API treatment executed through the current executor still cannot say which
sampling parameters were used, cannot request a reasoning effort in a way that
OpenRouter or an OpenAI-compatible endpoint actually honors, and cannot report
which upstream provider ultimately served the request, what it cost, or how many
tokens it consumed. An API cell and a subscription-CLI cell therefore land in the
same artifacts looking superficially comparable while being uncontrolled and
unattributable.

This change makes the API executor a controllable, attributable treatment surface,
without changing the default request for anyone who is happy with today's behavior.

## What Changes

- **Per-invocation model override.** `model-endpoint` invocation accepts an
  optional override of the configured `model` (and the new request controls), so
  an experiment cell can vary the model without editing committed
  `.github/pipeline.yml`. The committed configuration remains the default.
- **Allowlisted request parameters.** A `model-endpoint` definition may declare a
  strict, allowlisted `params` block (`temperature`, `top_p`, `seed`,
  `max_output_tokens`, `stop`, plus provider/model routing options such as
  OpenRouter's `provider` routing preferences and `models` fallback list).
  Unknown keys are rejected at config-parse time.
- **Provider-aware reasoning/effort adapter.** A definition declares its wire
  dialect explicitly (e.g. `openrouter` vs. `openai` vs. `none`); the declared
  dialect — never the model name — decides how a requested effort is encoded
  (`reasoning: {effort}` vs. `reasoning_effort` vs. unsupported). An effort
  requested against a dialect that cannot express it fails preflight, or, when
  the operator explicitly opts in, is recorded as `unsupported` — never dropped
  silently.
- **Controlled extra headers.** A definition may declare additional headers whose
  values are either a non-secret literal or an `env:` reference. Resolved values
  of `env:` headers, and the credential, never reach evidence.
- **Optional structured output for review stages.** A `model-endpoint` executor
  serving a prompt-contained review stage may request JSON/schema-constrained
  output where the endpoint supports it. This is a transport hint only: the
  existing single-sourced verdict schema and `review-policy` gating remain the
  authoritative contract, unchanged.
- **Request and response provenance.** The exact payload sent (after secret
  redaction) is recorded, along with requested vs. resolved model, upstream
  provider, request id, finish reason, token/cache usage, reported cost,
  retry/rate-limit observations, and timing. Anything the endpoint does not
  expose stays `null`/unknown and is never inferred.
- **API vs. OAuth-CLI treatment separation.** Run and experiment artifacts carry
  an explicit auth/execution class so `model-endpoint` (API-key) treatments are
  never conflated with `local-cli` subscription/OAuth harness treatments.
- Cost keeps the existing `actual | estimated | unknown` semantics from
  `stage-cost-accounting` (#429) — a reported provider cost is `actual`; no second
  cost model is introduced.
- Documentation gains an OpenRouter example and restates why `model-endpoint`
  executors remain restricted to prompt-contained stages.

Unchanged by design: the prompt-contained-stage restriction, verdict validation
strictness, the no-silent-fallback preflight rule, and the never-auto-merge stop.

## Capabilities

### New Capabilities
- `api-executor-request-controls`: declaring, validating, and transmitting
  controlled request parameters, provider-aware reasoning/effort, extra headers,
  and structured-output hints for `model-endpoint` executors, plus the
  per-invocation override seam experiments use.
- `api-executor-response-provenance`: capturing and recording redacted request
  payloads and response provenance (resolved model/provider, request id, finish
  reason, usage, cost, retry/rate-limit, timing) with an explicit unknown
  representation.

### Modified Capabilities
- `external-stage-executors`: adds requirements that the new controls do not widen
  `model-endpoint` stage eligibility, that documentation carries an OpenRouter
  example and the restriction rationale, and that the new paths are verified
  against provider-shaped responses with no live API calls.
- `stage-eval-runner`: adds requirements that an experiment cell may bind an API
  treatment to a `model-endpoint` executor with deterministic per-cell overrides,
  and that cell records distinguish API treatments from CLI treatments.

(Stage accounting record changes are specified inside
`api-executor-response-provenance` — additive fields plus a schema-version bump —
so `stage-cost-accounting`'s existing `actual | estimated | unknown` requirements
are reused unchanged rather than redefined.)

## Impact

- `core/scripts/types.ts` — `ModelEndpointExecutorDefinition` gains `dialect`,
  `params`, `headers`, `reasoning`, `structured_output`; new provenance types.
- `core/scripts/config.ts` — strict parse/validation for the new blocks.
- `core/scripts/executors.ts` — request building, header resolution, effort
  mapping, response provenance extraction, redaction.
- `core/scripts/accounting.ts` — additive record fields; schema version bump.
- `core/scripts/evals/*` — treatment → executor override binding and cell record
  execution class.
- Docs (`README` / SKILL variants) — OpenRouter example.
- Tests use the existing injected `fetchImpl` seam; CI makes no live API call.

## Acceptance criteria

- [ ] A `model-endpoint` treatment can override the model (and request controls)
      for one experiment cell without any edit to committed repository
      configuration; with no override, the committed `model` is used.
- [ ] `resolveConfig()` accepts an allowlisted `params` block (temperature,
      top_p, seed, max_output_tokens, stop, provider/model routing) and rejects
      any unknown key at parse time, naming the offending key.
- [ ] The exact request payload actually sent is recorded in run evidence with
      credential and `env:`-header values redacted.
- [ ] A requested effort is encoded per the definition's declared dialect; a
      dialect that cannot express effort either fails preflight naming the stage
      and executor, or — only under an explicit opt-in — records the effort as
      `unsupported`. It is never silently dropped.
- [ ] Extra headers resolve from a non-secret literal or an `env:` reference; a
      missing referenced env var fails preflight, and no resolved `env:` header
      value appears in any artifact.
- [ ] A review stage on a structured-output-capable endpoint can request
      JSON/schema output, and a returned verdict is still validated against the
      single-sourced verdict schema with unchanged `review-policy` gating; a
      non-compliant verdict still fails the gate.
- [ ] Response evidence records requested model, resolved model, upstream
      provider, request id, finish reason, token/cache usage, reported cost,
      retry/rate-limit observations, and timing when the endpoint exposes them.
- [ ] Absent provider metadata is recorded as `null`/unknown and is never derived
      from the model string.
- [ ] Run and experiment artifacts mark `model-endpoint` executions with an API
      execution/auth class distinct from `local-cli` OAuth/subscription harness
      executions.
- [ ] `model-endpoint` executors remain rejected at parse time for
      execution-environment stages.
- [ ] Unit tests cover an OpenRouter-shaped response and a generic
      OpenAI-compatible response through the injected HTTP seam; `npm run ci`
      passes and makes no live API call.
- [ ] Documentation contains a working OpenRouter executor example and states the
      prompt-contained-stage restriction with its rationale.
