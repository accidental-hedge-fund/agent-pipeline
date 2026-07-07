## Why

Today every model-invoking stage runs through one of two locally-installed CLI
harnesses — `claude` or `codex` (plus the `review_harness` escape hatch from #40,
which only overrides the *reviewer* CLI). Operators whose teams already run an
agent platform — OpenCode, HermesAgent, OpenClaw, or another API-driven execution
system — have no way to delegate stage work to that platform. They must install a
separate local harness alongside the infrastructure they already operate.

Separately, operators running local models (e.g. an Ollama server on
`http://localhost:11434`) want review verdicts to run on local, zero-API-cost
infrastructure. The current-release workaround is a `review_harness` shim CLI that
forwards the prompt to the endpoint — functional, but per-operator glue with no
first-class config surface or stage-eligibility guardrail.

This change generalizes the `review_harness` concept to **all** model-invoking
stages and to **two kinds of external executor**, while keeping the pipeline's
stage outcome contract (verdict schema, fix loops, review gates, never-auto-merge)
enforced identically regardless of which system executes a stage. It is strictly
opt-in: a repo with no executor configuration behaves exactly as today.

## What Changes

- Add a named **executor definitions** block to `.github/pipeline.yml`. Each
  definition has one of two `type`s:
  - **`agent-system`** — a full execution backend (OpenCode / HermesAgent /
    OpenClaw) addressed by a provider identifier + API endpoint. Valid for **any**
    model-invoking stage.
  - **`model-endpoint`** — a raw OpenAI-compatible chat/completions endpoint
    (e.g. local Ollama) declared with a base URL and model name. Valid **only** for
    prompt-contained stages (`review-1`, `review-2`, `plan-review`).
- Let each model-invoking stage (`planning`, `implementing`, `review-1`,
  `review-2`, `fix-1`, `fix-2`, `plan-review`, and `shipcheck-gate` when enabled)
  be assigned a named executor independently, so one run can mix executors.
- Reject at **config-parse time** any assignment of a `model-endpoint` executor to
  an execution-environment stage (`planning`, `implementing`, `fix-1`, `fix-2`,
  `shipcheck-gate`) — with an error naming the offending stage and executor. Never
  discover this mid-run.
- For `model-endpoint` executors, embed all stage context the prompt needs (plan
  text, PR diff, conventions excerpt) in the prompt itself — the prompt contract
  must not assume repo/tool access.
- Reference provider credentials by **environment-variable name or secret
  reference** only; never store secret values in `pipeline.yml` or emit them in run
  evidence. Endpoint executors with no credential (e.g. localhost Ollama) are valid
  with none.
- **Preflight** every configured executor before the stage runs: a misconfigured,
  unreachable, or non-contract-compliant provider blocks the run with an error
  naming the stage and provider — no silent fallback to a local harness.
- Enforce the existing stage outcome contract (including the JSON verdict schema
  via `parseStructuredVerdict`) on whatever the provider returns, regardless of
  which system produced it.
- Record, in run evidence, which executor and provider (and, for `model-endpoint`,
  which model name) ran each stage.

The pipeline **still never merges** — this change adds no auto-merge path and does
not touch the `ready-to-deploy` stop.

## Capabilities

### New Capabilities

- `external-stage-executors`: Named executor definitions (two types —
  agent-system and model-endpoint) that operators can assign per model-invoking
  stage; config-parse-time stage-eligibility validation; executor-independent
  outcome-contract enforcement; credential-reference handling; provider preflight
  with no silent fallback; and per-stage executor/provider/model evidence.

### Modified Capabilities

- (none — this introduces a new opt-in surface. The existing
  `pipeline-configuration`, `review-layer`, and `evidence-bundle` behaviors are
  unchanged when no executor is configured; the new requirements live entirely in
  the `external-stage-executors` capability.)

## Impact

- `core/scripts/config.ts` — new `executors:` schema block + per-stage assignment
  keys under `.strict()`; parse-time stage-eligibility validation; credential
  reference resolution (name → value at invocation, never persisted).
- `core/scripts/harness.ts` — `invoke()` (or a sibling executor dispatcher) learns
  to route a stage to an agent-system provider or a model-endpoint, in addition to
  the existing `claude` / `codex` / custom-CLI paths.
- `core/scripts/stages/*.ts` — planning, review, fix, plan_review, shipcheck call
  sites resolve the assigned executor for their stage.
- Provider preflight helper + a normalization layer that maps a provider result
  back onto the pipeline's stage outcome contract.
- Run evidence / stage accounting (`accounting.ts`, `run-store.ts`,
  `evidence-bundle`) — record executor + provider (+ model name for
  model-endpoint) per stage; scrub secret values.
- `.github/pipeline.yml` template comment, `hosts/claude/SKILL.md`, `README.md`.
- `plugin/` mirror (regenerated via `scripts/build.mjs`; never hand-edited).
- Co-located unit tests in `core/test/`.

## Open questions

- **Executor assignment scope (role vs. stage) — BLOCKS implementation planning.**
  Should an executor be assigned to a *role* (`implementer` / `reviewer`) or to
  *individual named stages*? Role-scoped is a smaller config surface; stage-scoped
  gives finer control (e.g. a different executor for `plan-review` than for the
  review rounds). The behavioral requirements below are written to hold under
  either choice; the concrete config key shape (`role_executors:` vs
  `stage_executors:`) is deferred to @comamitc — see `design.md`. Implementation
  MUST NOT begin until this is decided.

## Acceptance Criteria

- [ ] Pipeline configuration accepts named executor definitions that reference
  external agent providers by API endpoint or provider identifier — not just local
  CLI paths.
- [ ] Each model-invoking stage (`planning`, `implementing`, `review-1`,
  `review-2`, `fix-1`, `fix-2`, `plan-review`, `shipcheck-gate` when enabled) can
  be assigned a named executor independently.
- [ ] A single run can use different executors for different stages; the
  combination is valid as long as each stage's outcome contract is met.
- [ ] OpenCode, HermesAgent, and OpenClaw can each be referenced as named,
  `agent-system`-type executors in configuration.
- [ ] A `model-endpoint`-type executor (e.g. Ollama) can be declared with a base
  URL and model name.
- [ ] Assigning a `model-endpoint` executor to an execution-environment stage
  (`planning`, `implementing`, `fix-1`, `fix-2`, `shipcheck-gate`) is rejected at
  config-parse time with an error naming the stage and the executor — never
  mid-run.
- [ ] For `model-endpoint` executors, the pipeline embeds all context the stage
  needs (plan text, PR diff, conventions excerpt) in the prompt itself.
- [ ] When a stage is delegated to an external provider or endpoint, the pipeline
  enforces its outcome contract (including the JSON verdict schema for review
  stages) on the returned result, regardless of which system produced it.
- [ ] Provider credentials are referenced by environment-variable name or secret
  reference; secret values are never stored in `pipeline.yml` or emitted in run
  evidence. Endpoint executors with no credential are valid.
- [ ] A misconfigured, unreachable, or non-compliant provider fails before the
  stage executes, with an error that names the stage and provider — the run does
  not proceed with a silent fallback.
- [ ] Run evidence records which executor and provider (and, for `model-endpoint`,
  which model name) ran each stage.
- [ ] A repository with no executor configuration behaves exactly as today.
- [ ] `npm run ci` passes end-to-end after the change.
