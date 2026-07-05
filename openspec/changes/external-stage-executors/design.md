## Context

The engine already has the seam this change extends. `invoke(harness, worktreeDir,
prompt, opts)` in `core/scripts/harness.ts` dispatches on a `string` harness name:
`claude` and `codex` keep fixed invocation shapes, and **any other string** is
treated as a user-configured reviewer CLI (`review_harness`, #40) — spawned with
the prompt as a positional argument, its stdout captured as the harness output.
`resolveConfig()` already folds an optional `review_harness` key onto
`cfg.harnesses.reviewer` after the profile/file/CLI merge. Review verdicts are
parsed by `parseStructuredVerdict` against a single-sourced JSON schema
(`review-schema.ts`), so the *reviewer* is already provider-agnostic at the
contract boundary.

Two things are missing for #314:

1. External executors are **API-driven**, not local CLIs. The dispatcher must be
   able to POST a prompt to an agent-system provider or an OpenAI-compatible
   `/chat/completions` endpoint and read the result back, not just `spawn` a
   binary.
2. Executor selection is **per reviewer only** today. This change makes it
   per-stage (or per-role — see open question), for the full set of model-invoking
   stages.

`STAGES` (in `types.ts`) is the canonical stage list. The model-invoking subset
this change governs is: `planning`, `implementing`, `review-1`, `review-2`,
`fix-1`, `fix-2`, `plan-review`, and `shipcheck-gate` (when enabled). Every other
stage (`ready`, `pre-merge`, `eval-gate`, `deploy_ready`, …) is deterministic or
gate-only and is out of scope.

## Goals / Non-Goals

**Goals**

- Delegate any model-invoking stage to an external agent system (OpenCode /
  HermesAgent / OpenClaw) via that system's API.
- Support a second executor type — a raw OpenAI-compatible model endpoint — for
  prompt-contained stages only, with a hard config-parse-time guardrail.
- Keep the stage outcome contract (verdict schema, fix loops, review gates,
  never-auto-merge) enforced identically regardless of executor.
- Strict opt-in: zero behavior change for repos with no executor config.

**Non-Goals**

- Built-in credential management or secret storage (out of scope — credentials are
  referenced, resolved from the environment at invocation, never persisted).
- Auto-discovering provider capabilities or negotiating the outcome contract with
  the provider — the contract is fixed and enforced on whatever the provider
  returns.
- Changing the outcome contract itself (verdict schema, review gates, fix loop
  behavior, pre-merge checks).
- Per-provider cost/token accounting (tracked in #304).
- A UI for comparing provider outputs across stages.
- `model-endpoint` executors for execution-environment stages — a raw endpoint has
  no repo or tool access; running those stages locally means routing through an
  `agent-system` executor that is itself configured with a local model.

## Executor-type / stage-eligibility matrix

| Stage            | Kind                 | `agent-system` | `model-endpoint` |
|------------------|----------------------|:--------------:|:----------------:|
| `planning`       | execution-environment| ✅             | ❌ (parse error) |
| `implementing`   | execution-environment| ✅             | ❌ (parse error) |
| `fix-1`, `fix-2` | execution-environment| ✅             | ❌ (parse error) |
| `shipcheck-gate` | execution-environment| ✅             | ❌ (parse error) |
| `plan-review`    | prompt-contained     | ✅             | ✅               |
| `review-1`, `review-2` | prompt-contained| ✅             | ✅               |

The "prompt-contained" set is exactly `{ plan-review, review-1, review-2 }` — the
stages whose prompt already carries (or can carry) all the context needed to reach
a verdict without exploring the repo. This is the canonical allowlist for
`model-endpoint` eligibility; everything else requires an execution environment.

## Decisions

**Decision: two executor types, not a single generic "provider".** Agent systems
and raw model endpoints differ in a way the pipeline must enforce, not paper over:
an endpoint cannot explore a repo or run tools, so it can only serve stages whose
prompt is self-contained. Modeling them as one type would push that constraint to
runtime; two explicit types let the config parser reject the illegal combination
up front (naming the stage + executor) — matching the issue's "never mid-run"
requirement.

**Decision: reuse the `invoke()`/`parseStructuredVerdict` contract boundary.** The
reviewer contract is already provider-agnostic (#40 proved a non-`claude`/`codex`
string can produce a valid verdict). External executors plug in at the same
boundary: the dispatcher gains API-driven branches; the verdict schema and fix
loops are untouched. This keeps "rigor enforced identically regardless of
executor" a structural property, not a per-provider promise.

**Decision: no silent fallback.** #39 established a self-review fallback for a
missing *reviewer CLI*. External executors are the operator's deliberate choice; a
misconfigured/unreachable/non-compliant external provider must **block** with a
named error (stage + provider), not silently degrade to a local harness. Silent
fallback would mask that the operator's intended infrastructure isn't running and
could weaken rigor invisibly. Preflight runs **before** the stage executes.

**Decision: credentials are references, resolved at invocation, never persisted.**
`pipeline.yml` stores an env-var name / secret reference (e.g.
`credential: OPENCODE_API_KEY`), never a value. The value is read from the process
environment at invocation time and scrubbed from any evidence/accounting output.
Endpoint executors with no credential (localhost Ollama) are valid with none. This
keeps secret storage out of scope while making the feature usable.

**Decision: `model-endpoint` prompts are self-contained by construction.** For an
endpoint-type executor the pipeline embeds plan text, PR diff, and a conventions
excerpt directly in the prompt (the review prompts already assemble most of this).
The prompt contract for these stages must not assume the executor can open files —
the same assumption the current `review_harness` shim relies on.

## Decision — executor assignment scope: stage-scoped, key `stage_executors:`

Resolved during plan-review (codex verdict, 2026-07-05T19:03:08Z — see the
"Plan Review" comment on #314): **stage-scoped**, config key `stage_executors:`,
keyed by the exact `Stage` string (`planning`, `plan-review`, `implementing`,
`review-1`, `fix-1`, `review-2`, `fix-2`, `shipcheck-gate`). Rationale accepted
from the review: the issue and this spec already require each stage to be
assignable independently (`plan-review` may want a different executor than
`review-1`/`review-2`, which role-scoping cannot express), and the
`model-endpoint` stage-eligibility matrix above is inherently stage-granular —
stage-scoped keys let the config parser express and enforce it directly, with no
role→stage indirection to reconcile. `role_executors:` is rejected; there is no
role-scoped alternative in this change.

Config surface:

```yaml
executors:
  opencode-main:
    type: agent-system
    provider: opencode
    endpoint: https://opencode.internal/api
    credential: OPENCODE_API_KEY      # env-var NAME, never the value
  local-ollama:
    type: model-endpoint
    base_url: http://localhost:11434/v1
    model: llama3.1:70b
    # no credential for a localhost endpoint

stage_executors:
  planning: opencode-main
  review-1: local-ollama
  review-2: local-ollama
```

## External agent-system API contract

Defined here (not negotiated with or discovered from the provider — providers are
addressed by a plain identifier string, not a provider-specific adapter; an
operator pointing `provider:` at OpenCode/HermesAgent/OpenClaw is responsible for
fronting that system with an endpoint that speaks this contract, e.g. a thin
shim):

- **Request**: `POST <endpoint>` with JSON body `{ "stage": "<stage-name>",
  "prompt": "<full prompt text>" }` and header `content-type: application/json`.
  When `credential` is set, header `authorization: Bearer <resolved-value>` is
  added. No other headers are sent.
- **Response**: `2xx` with JSON body `{ "output": "<full stdout-equivalent
  text>" }`. `output` becomes the harness's `stdout` and flows through the exact
  same downstream parsing (`parseStructuredVerdict` for review stages) as a local
  CLI's stdout. A non-2xx response, a network error, or a response that fails to
  parse as JSON with a string `output` field is a contract violation.
- **Timeout**: the stage's existing configured timeout (`review_timeout`,
  `plan_review_timeout`, `implementation_timeout`, `fix_timeout`) bounds the
  request; on expiry the pipeline aborts the request and treats it as a timed-out
  harness failure, exactly like a local CLI timeout.
- **model-endpoint contract**: standard OpenAI-compatible
  `POST <base_url>/chat/completions` with `{ "model": "<model>", "messages":
  [{ "role": "user", "content": "<prompt>" }] }`; response
  `choices[0].message.content` becomes `stdout`. Same auth-header and timeout
  rules as above.

## Preflight — two phases, not one

Plan-review correctly flagged that "non-compliant result" cannot be proven before
a real invocation. Preflight is split:

- **Before the stage runs** (`preflightExecutor`): configuration completeness,
  credential-env-var presence (if `credential` is declared, the named env var
  must be set and non-empty), and endpoint reachability (a bounded HTTP probe).
  Failure here blocks the item before any prompt is sent — named stage + provider,
  no fallback.
- **After invocation** (unchanged, existing machinery): the stage's normal
  outcome-contract enforcement (`parseStructuredVerdict` + review-policy for
  review stages) runs on whatever the executor returned. A schema-non-compliant
  result is a contract violation handled by that existing path, not a new
  preflight phase — there is no dry-run/contract-probe mode to invoke.

## No fallback for `stage_executors` (distinct from the legacy `review_harness` self-review fallback)

The existing `review_harness` self-review fallback (#39, `self-review.ts`) applies
only when the reviewer CLI cannot be spawned (`spawn_error`) and predates
`stage_executors`. A `stage_executors` assignment is the operator's deliberate,
explicit choice; the executor dispatch path (`executors.ts`) never sets
`spawn_error`, and stage call sites route a `stage_executors`-assigned stage
directly to the executor dispatcher instead of through `invokeReviewer` — so the
self-review fallback structurally cannot trigger for an externally-delegated
stage. A preflight or invocation failure blocks the item with a named error
instead.

## Dependency seam for HTTP calls

`executors.ts` takes an injectable `{ fetchImpl?: typeof fetch }` deps bag
(defaulting to the global `fetch`), mirroring the repo's `Deps`-parameter
convention (`gh`/harness/worktree fakes). Unit tests inject a fake `fetchImpl`
that never performs real network I/O, including a "fetch throws/rejects" case
proving the unreachable-provider path fails without a live network dependency.

## Risks / Trade-offs

- **Contract drift per provider.** A provider that returns malformed verdict JSON
  must be treated as a contract violation (block), not a soft failure. Mitigation:
  the same `parseStructuredVerdict` gate all reviewers pass; preflight probes
  contract-compliance before the stage runs.
- **Credential leakage into evidence.** Accounting/evidence records executor +
  provider (+ model). Mitigation: record the credential *reference name* only;
  scrub any value; a test asserts no configured secret env value appears in
  emitted evidence.
- **Config surface growth.** Two executor types + per-stage assignment is more YAML
  than `review_harness`. Mitigation: strict schema with named parse errors,
  everything optional, no-config parity preserved by a dedicated test.
- **Reachability preflight latency.** Probing each provider before its stage adds a
  round-trip. Acceptable: it is bounded, opt-in, and prevents a far more expensive
  mid-run failure.
