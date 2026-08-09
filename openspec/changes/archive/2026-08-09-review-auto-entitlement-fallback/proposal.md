## Why

Pipeline v1.30 resolves adversarial `models.review: auto` to `claude-fable-5`. On a valid Claude Code subscription without separately purchased Fable usage credits, that model fails immediately with an entitlement HTTP 429 (`Fable 5 requires usage credits…`) before any tokens are consumed. Stage accounting may mark `throttled: true`, but durable classification collapses to `workflow-engine-defect`, so recovery re-runs completed planning twice and then `run_fatal`s. The same gap appears in design-gate: with unstructured `models.review: auto` and no structured `review_harness`, design-gate records only `cfg.harnesses.reviewerModel` (undefined) and launches Claude with no `--model`, falling through to the host Fable default and failing the same way. Codex-primary / Claude-reviewer profile-relative ownership is otherwise correct; the bug is auto model selection under subscription-only entitlement, durable typing of that failure, and recovery scope when plan-review cannot start.

## What Changes

- Keep adversarial `auto` preferred resolution as `claude-fable-5` at config-load time (rigor preference unchanged).
- For **auto-sourced** reviewer models only, when the Claude reviewer returns a **deterministic entitlement-specific 429** for the preferred auto model, perform **one allowlisted in-process retry** to a subscription-backed Claude model (`sonnet`). Explicit non-`auto` model configuration MUST fail visibly and MUST NOT be rewritten.
- Thread the same reviewer model resolution chain through **design-gate** as other reviewer stages: structured `review_harness.model` when set, else round-aware `models.review` / auto expansion, then the existing non-claude-auto alias guard. Never launch an unstructured `auto` reviewer with a missing model flag that silently inherits a host Fable default.
- Record requested model, resolved/fallback model, and `fallback` on stage accounting for every reviewer attempt (including design-gate and the entitlement retry).
- Classify ordinary transient throttling as `transient-rate-limit` and entitlement-specific model unavailability as a typed durable class (`environment-auth` via a distinct canonical reason such as `model-entitlement-required` / `capability-refusal`) — never collapse either to `workflow-engine-defect` solely because tokens were zero or the harness exited quickly.
- When plan-review (or design-gate reviewer) fails after planning / decision-record work already completed, durable recovery MUST redispatch the **reviewer stage only** and MUST NOT re-run planning or re-extract a decision record from scratch.
- Document `auto` behavior when the preferred model requires unavailable usage credits; do not promote PATH shims or structured `review_harness: {command: claude, model: sonnet}` as the portable fix (the latter pins the reviewer command and breaks Claude-primary → Codex-reviewer portability).

## Capabilities

### New Capabilities

- `review-auto-entitlement-fallback`: Runtime detection of Fable/usage-credit entitlement failures on auto-selected Claude reviewer models; allowlisted single retry to a subscription-backed model; explicit-model fail-closed; requested/resolved/fallback accounting; typed durable blockers for entitlement vs ordinary throttle; recovery that preserves completed planning and design decision records.

### Modified Capabilities

- `stage-model-effort-routing`: Clarify that config-load adversarial `auto` still prefers `claude-fable-5` for a Claude reviewer, and that runtime entitlement fallback is the supported subscription path (not silent config rewrite; not `--fallback-model` reliance).
- `design-interrogation-gate`: Reviewer identity model/effort MUST resolve through the shared reviewer model chain (structured harness fields with fallback to `models.review` / round-aware auto), and entitlement fallback/classification/accounting apply to interrogation and re-ask rounds.
- `durable-blocker-classification`: Zero-token harness entitlement 429 and ordinary rate-limit throttle MUST project to typed classes rather than defaulting to `workflow-engine-defect`.
- `stage-cost-accounting`: Reviewer entitlement-fallback attempts MUST populate requested/resolved model and `fallback` provenance already permitted by the accounting schema.

## Impact

- `core/scripts/stage-routing.ts` — auto source flags remain authoritative for “was auto”; optional shared allowlist of subscription fallback model(s).
- `core/scripts/harness.ts` / `harness-adapters/claude.ts` — deterministic entitlement-429 recognition (distinct from ordinary `rate_limit_event` throttle); optional single auto-only retry path or a reviewer call-site helper used by all reviewer stages.
- `core/scripts/stages/review-routing.ts`, `planning.ts` (plan-review), `stages/design_gate.ts`, pre-merge / shipcheck / other reviewer call sites that share the model chain — use shared resolution + entitlement fallback; design-gate identity init MUST fall through `cfg.models.review`.
- `core/scripts/stage-diagnostic.ts` / loop recovery projection — map entitlement and throttle diagnostics to typed durable classes; ensure plan-review recovery does not re-dispatch planning when the plan artifact/label already advanced.
- `core/scripts/accounting.ts` (call sites) — always set `requestedModel` / `resolvedModel` / `fallback` on auto entitlement recovery.
- Docs: README / host SKILL model-routing notes for `auto` under subscription-only Claude accounts.
- Tests: zero-token Fable entitlement response → Sonnet recovery; explicit model fails closed; both invocation-relative profiles; design-gate unstructured `models.review: auto`; durable classification; plan/decision-record preservation on retry.
- `plugin/` mirror regenerated with any `core/` edits (implementation phase).

## Acceptance Criteria

- [ ] With Codex-primary / Claude-reviewer and `models.review: auto`, plan-review completes on a Claude subscription without Fable usage credits when `sonnet` (or another allowlisted subscription-backed Claude model) is available.
- [ ] Claude-primary / Codex-reviewer profile-relative ownership is unchanged: auto still does not force a Claude-only alias onto a Codex reviewer.
- [ ] Design-gate with unstructured `models.review: auto` (no structured `review_harness`) passes a concrete reviewer model flag on both interrogation and re-ask rounds; it does not inherit the host Fable default by omitting `--model`.
- [ ] Stage accounting for reviewer attempts records requested model, resolved/fallback model, and whether a fallback occurred.
- [ ] An explicit non-`auto` reviewer model (for example `claude-fable-5`) is never silently replaced with `sonnet` on entitlement failure; the failure remains visible and typed.
- [ ] Entitlement-specific 429 classifies as a typed durable blocker (not `workflow-engine-defect`); ordinary transient throttling classifies as `transient-rate-limit` (or its existing projection), also not `workflow-engine-defect`.
- [ ] After a successful planning stage, a failed plan-review entitlement/throttle recovery reuses the completed plan and re-runs plan-review only — it does not re-run planning from scratch.
- [ ] After a valid design decision record exists, a failed design-gate reviewer round recovery reuses that record and does not re-generate it solely because the reviewer could not start.
- [ ] Unit tests cover: zero-token Fable entitlement → successful Sonnet auto recovery; explicit-model fail-closed; both profiles; design-gate model resolution; durable classification of entitlement vs throttle; plan/decision-record preservation.
- [ ] Operator docs explain that `auto` prefers Fable for adversarial review and may fall back once to a subscription-backed model when Fable requires unavailable usage credits.
