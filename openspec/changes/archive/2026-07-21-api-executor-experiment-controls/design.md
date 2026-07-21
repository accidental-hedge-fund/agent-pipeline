## Context

`model-endpoint` executors were introduced by #314 as a deliberately minimal
OpenAI-compatible client: `POST {base_url}/chat/completions` with
`{model, messages:[{role:"user",content:prompt}]}`, keeping only
`choices[0].message.content` as the stdout-equivalent. Everything else on the
wire — sampling controls, reasoning controls, routing, usage, cost, upstream
provider — is neither sent nor read.

#432 (`stage-eval-runner`) made controlled comparison possible by holding fixture,
base commit, prompt, and config constant across cells. #429
(`stage-cost-accounting`) established `actual | estimated | unknown` cost
semantics and additive accounting-record evolution. #431 established treatment
provenance fields (requested vs. resolved model/effort, provider auth class) for
*CLI adapters*. This change brings the API executor up to the same standard so an
API cell is a real treatment rather than an unlabeled black box.

**Scope note on the issue's human comment.** The commenter asks whether these
executors are "mainly for research experiments, or production trading/automation
workflows". They are neither a trading nor a general automation surface: a
`model-endpoint` executor is only assignable to the pipeline's prompt-contained
review stages, and this change's purpose is controlled evaluation of those
stages. The provenance fields the commenter asks for (provider/base_url, model,
experiment controls, token usage, latency, fallback path per stage) are exactly
what the provenance requirements below record; nothing in this change extends
model endpoints to production automation.

## Goals / Non-Goals

Goals:
- Make an API treatment reproducible: the exact controls sent are declared,
  validated, and recorded.
- Make an API treatment attributable: what actually served it, at what cost, is
  recorded or explicitly unknown.
- Keep API treatments visibly distinct from OAuth/subscription CLI treatments.
- Change nothing for an existing minimal `model-endpoint` configuration.

Non-Goals:
- No agent loop for raw model endpoints — the prompt-contained-stage restriction
  stands.
- No new CLI adapters (Grok Build / Pi / OpenCode are #431).
- No experiment scheduling, fixtures, grading, or aggregation (#432, #433).
- No relaxation of verdict validation or review-policy gating.
- No second cost model.

## Decisions

### 1. Wire dialect is declared, never sniffed

A `model-endpoint` definition declares `dialect` explicitly, defaulting to a
plain OpenAI-compatible `chat/completions` dialect. The dialect — not the
`base_url` host, not the model string — selects how reasoning/effort and
structured output are encoded and which response fields are read for provenance.

*Why:* model names are the least reliable signal available (`openai/gpt-x` served
through OpenRouter is not an OpenAI endpoint; the same slug appears across
resellers), and sniffing is precisely the "inferred from model name alone"
failure the issue forbids. An explicit declaration is also the only thing that
can be validated at parse time.

*Alternative rejected:* probing the endpoint's capabilities at preflight. It costs
a round trip per run, varies with provider load, and would make a config's meaning
non-deterministic.

### 2. Effort mapping is a small, closed adapter with three outcomes

`{dialect, requested effort}` maps to one of:
- **encoded** — the dialect can express it (`openrouter` → `reasoning: {effort}`;
  `openai` → `reasoning_effort`), and the encoded form goes on the wire;
- **preflight failure** — the dialect cannot express it, naming stage, executor,
  dialect, and requested effort (default);
- **recorded unsupported** — only when the definition explicitly opts in
  (`reasoning.on_unsupported: record`), the request goes out without the effort
  and the record carries `resolved_effort: null` with an explicit
  `effort_support: "unsupported"` marker.

*Why:* silently dropping an effort would let two cells that differ only by effort
produce identical requests, which is a fabricated experimental result. Failing
closed by default is the rigor-preserving choice; the opt-in exists so an operator
can deliberately run a "no reasoning control available here" arm and have it
labeled as such rather than pretending.

### 3. Params are an allowlist, not a passthrough

`params` accepts a fixed set of keys. Unknown keys are a parse-time error naming
the key.

*Why:* an open passthrough turns `pipeline.yml` into an untyped wire-format hole:
typos become silent no-ops (again fabricating "identical" treatments), and a
secret could be smuggled into a body field that redaction does not know about. The
allowlist is the same posture the rest of the config schema takes (strict, reject
unknown keys at parse time, never mid-run).

### 4. Overrides are per-invocation arguments, not config mutation

The eval runner supplies overrides as an argument to the executor invocation. It
never rewrites `.github/pipeline.yml`, and the resolved definition for a cell is
`committed definition + cell override` computed in memory.

*Why:* the committed config must stay the reproducible default and must not be
mutated by a concurrent experiment; cells run concurrently against one checkout,
so any file-level mutation would race. Recording both the requested override and
the resolved payload keeps the cell auditable without the file changing.

### 5. Structured output is a transport hint; the verdict schema stays authoritative

When enabled, the request carries the endpoint's structured-output field
(`response_format` json/json_schema per dialect). The response is still parsed and
validated by `parseStructuredVerdict` against the single-sourced schema, and
review-policy gating is untouched. A structurally invalid verdict fails exactly as
it does today, regardless of what the endpoint claimed to guarantee.

*Why:* provider-side schema enforcement is best-effort and varies by upstream
route; treating it as the contract would weaken review rigor (golden rule 3). It
is a nudge that reduces retries, nothing more.

### 6. Headers: literal or `env:` reference, redaction by construction

Header values are either a non-secret literal or `{ env: NAME }`. `env:`-sourced
values are resolved at invocation time only. The evidence writer records header
*names* plus, for `env:` values, the reference name — never the resolved value.
The credential header is redacted the same way.

*Why:* redaction that has to recognize secrets by pattern eventually misses one.
Marking the secret-bearing values structurally at config time means the redactor
never needs to guess.

### 7. Provenance is read where exposed and null otherwise

Requested model always exists (it is what we sent). Resolved model, upstream
provider, request id, finish reason, usage, cost, retry/rate-limit, and timing are
read from the response body and headers per dialect; each is `null` when absent.
No field is back-filled from another. Reported provider cost maps onto the
existing `cost_source: actual`; when no cost is reported the existing
estimated/unknown classification applies unchanged (#429).

*Why:* a fabricated provenance value is worse than a missing one — it silently
corrupts a comparison. Reusing #429's classifier avoids a second, divergent cost
notion.

### 8. Execution class is an explicit recorded field

Records carry an execution/auth class distinguishing an API-key `model-endpoint`
invocation from an OAuth/subscription `local-cli` invocation, rather than leaving
readers to infer it from whether `base_url` happens to be set.

*Why:* cost and rate-limit semantics differ fundamentally between the two
(metered per token vs. bundled in a subscription); an aggregate that mixes them is
meaningless, and inference-by-absence breaks the moment a new executor type is
added.

## Risks / Trade-offs

- **Dialect list grows over time.** Mitigation: dialect is a closed enum validated
  at parse time; adding one is an additive, testable change, and an unknown value
  fails loudly rather than degrading to a guess.
- **Provider response shapes drift.** Mitigation: every extraction is optional and
  nulls out on mismatch; extraction is tested against captured OpenRouter-shaped
  and generic OpenAI-compatible fixtures through the injected `fetchImpl` seam
  (golden rule 5 — no guessing at external shapes, and no live calls in CI).
- **More surface for secret leakage.** Mitigation: decision 6 makes secret-bearing
  values structurally identifiable, and a test asserts no resolved credential or
  `env:` header value appears in emitted evidence.
- **Accounting record growth.** Mitigation: all new fields are additive and
  optional with a schema-version bump, matching #429/#431 precedent; readers must
  not gate on an exact version.

## Open Questions

None blocking. If a future dialect needs a reasoning *budget* (token count) rather
than a categorical effort, it extends the same adapter with a fourth outcome
rather than reopening these decisions.
