## Context

See `proposal.md` — Why. Current constraints that shape the approach:

- Config-load `resolveAuto()` for every Adversarial cell returns `claude-fable-5` for the Claude harness (`stage-routing.ts`). That preference is intentional (adversarial rigor) and already tested.
- Claude CLI `--fallback-model sonnet` does **not** recover from this entitlement 429 (verified in the issue). Pipeline-owned retry is required.
- Reviewer call sites generally resolve model as `opts.model ?? cfg.harnesses.reviewerModel ?? cfg.models.review` plus `reviewerModelSourceWasAuto` / `resolveReviewerModelForHarness`. **Design-gate does not**: it initializes `reviewerIdentity.model` from `cfg.harnesses.reviewerModel` only, so unstructured `models.review: auto` yields `undefined` and the CLI uses the host default (often Fable).
- Stage accounting already has optional `requested_model`, `resolved_model`, and `fallback` fields (schema v4+). Call sites for this failure path do not populate the fallback path consistently.
- Durable projection maps unknown reason codes and several harness failures to `workflow-engine-defect`. A zero-token, two-second entitlement failure currently loses its useful class despite `throttled: true` on accounting.
- Recovery policy for `workflow-engine-defect` is aggressive and can redispatch the whole planning phase; `transient-rate-limit` uses `wait_and_retry` without rewriting completed work when labels/artifacts already advanced — but only if classification is correct **and** redispatch targets the blocked stage.

## Goals / Non-Goals

**Goals:**

- Make `models.review: auto` usable on subscription-only Claude accounts without Fable credits, while keeping Fable as the preferred auto choice when credits exist.
- Share one model-resolution + entitlement-fallback contract across plan-review, review-1/2, design-gate, and other reviewer call sites that already share the model chain.
- Preserve typed durable classification and stage-scoped recovery for entitlement vs ordinary throttle.
- Keep explicit model configuration fail-closed and profile-relative ownership intact.

**Non-Goals:**

- Purchasing or detecting usage credits via a live account-billing API at config-load time.
- Changing the static routing matrix preferred adversarial model away from `claude-fable-5` as the default auto pick.
- Relying on Claude CLI `--fallback-model` as the recovery mechanism.
- Adding a global `--model` escape hatch to `pipeline single` / `pipeline loop` (orthogonal CLI surface).
- Pinning `review_harness.command` to `claude` as the portable fix (breaks reverse profile).
- Expanding DurableBlockerClass with a new enum member unless classification cannot be expressed via an existing class + distinct reason code (prefer additive reason → existing class first).
- Cross-host entitlement cache or shared account state.

## Decisions

### 1. Preferred auto stays Fable; runtime allowlisted fallback for auto only

**Choice:** Keep config-load adversarial `auto` → `claude-fable-5` for Claude reviewers. On a **deterministic entitlement-specific failure** of that auto-selected model, perform **exactly one** in-process retry with allowlisted subscription-backed model `sonnet` (same effort as the original round unless effort is also invalid, which is out of scope).

**Why not change the static matrix to `sonnet`?** That permanently demotes adversarial rigor for accounts that *do* have Fable credits. Runtime fallback preserves preference when available.

**Why not probe entitlement at config-load?** No stable, offline entitlement probe exists in the supported Claude CLI surface that is cheaper or more reliable than the first failed invoke; probing would add latency and another failure mode to every run.

**Alternatives considered:** (a) matrix demotion to sonnet — rejected (rigor loss); (b) PATH shim rewriting argv — temporary operational workaround only; (c) CLI `--fallback-model` — does not handle this 429.

### 2. Entitlement signal is deterministic and narrow

**Choice:** Recognize the entitlement failure from harness stderr/stdout using a closed, tested pattern set (e.g. “requires usage credits”, “/usage-credits”, “Fable … usage credits”) and/or HTTP 429 **with zero tokens and that text**. Ordinary `rate_limit_event` throttle without entitlement text remains **transient throttle**, not entitlement fallback.

**Why:** Broad “any 429 → sonnet” would silently demote Fable under genuine capacity throttling and hide real rate limits. Narrow matching matches the observed product failure.

### 3. Explicit models never rewrite; auto flag is the sole gate

**Choice:** Entitlement fallback runs only when `reviewerModelSourceWasAuto` (or equivalent per-call-site “model originated from `auto`”) is true. Explicit `models.review: claude-fable-5` or structured `review_harness.model: claude-fable-5` fails with a typed blocker and no model rewrite.

**Why:** Operators who pin Fable intentionally must see credit/setup failure, not a silent quality demotion.

### 4. Design-gate uses the shared reviewer model chain

**Choice:** When initializing `reviewerIdentity`, set:

`model = resolveReviewerModelForHarness(cfg.harnesses.reviewerModel ?? cfg.models.review, reviewerHarness, wasAuto)`

(and the matching effort chain for `reviewerEffort` / `effort.review` as already used by other stages). Re-ask rounds reuse that identity. Entitlement fallback may update recorded identity for the successful fallback attempt and MUST account both attempts.

**Why:** Fixes the undefined-model → host Fable default path without requiring structured `review_harness` that pins the command.

### 5. Durable classification: throttle vs entitlement

**Choice:**

| Signal | Durable class | Canonical reason (illustrative) |
|--------|---------------|----------------------------------|
| Ordinary transient throttle / rate_limit | `transient-rate-limit` | `transient-infra` (existing) |
| Entitlement / usage-credit model refusal (after auto fallback exhausted or explicit model) | `environment-auth` | `model-entitlement-required` or reuse `capability-refusal` |
| Auto path recovered via sonnet in-process | No durable block | Accounting `fallback: true` |

Do **not** introduce a new `DurableBlockerClass` member in this change unless an existing class cannot carry distinct metrics (prefer distinct reason under `environment-auth`). Do **not** project either case to `workflow-engine-defect` solely because `usage.input_tokens=0` or duration is short.

**Why:** Entitlement is account setup, not an engine protocol defect. Transient throttle already has recovery policy (`wait_and_retry`). Collapsing to `workflow-engine-defect` caused `run_fatal` after expensive re-planning.

### 6. Recovery preserves completed plan and design decision record

**Choice:** When the blocked stage is `plan-review` and a completed plan artifact already exists (issue advanced past pure planning / plan comment present), recovery recipes for throttle/entitlement MUST redispatch **plan-review only**. When design-gate has a validated decision record version in issue comments/state, recovery MUST reuse it and re-run interrogation only.

**Why:** The observed defect spent two full planning passes on identical plan-review entitlement failures. Stage labels and durable item stage projection already know the blocked stage; classification + recipe must honor that stage, not reset to planning.

### 7. Shared helper over per-stage forks

**Choice:** Implement one pure classifier (`isClaudeModelEntitlementFailure`) and one small orchestrator helper used by reviewer invoke paths (or a thin wrapper around `invoke` for reviewer roles) rather than copying retry logic into every stage file. Design-gate, plan-review, and review rounds all call it.

**Why:** Design-gate already diverged once; shared helper is the regression-resistant fix.

### 8. Profile-relative ownership unchanged

**Choice:** Codex reviewer + auto continues to omit Claude-only aliases (`resolveReviewerModelForHarness`). Entitlement fallback applies only when the effective reviewer harness is `claude` (or another adapter that can run the allowlisted subscription model). Claude-primary / Codex-reviewer path is unchanged.

## Risks / Trade-offs

- **[Risk] Entitlement message text drifts** → Mitigation: closed pattern list + co-located fixture from the real CLI message; docs note that unknown wording fails closed as typed harness failure, not silent success.
- **[Risk] Sonnet also fails (no models available)** → Mitigation: after the single allowlisted retry, emit typed entitlement/auth blocker; do not chain further models.
- **[Risk] False positive matching ordinary throttle as entitlement** → Mitigation: require entitlement-specific phrases, not bare 429 alone; ordinary throttle stays `transient-rate-limit` without model rewrite.
- **[Risk] Design-gate identity already persisted with null model in old comments** → Mitigation: when decoding prior state with null/empty model under auto config, re-resolve from current config rather than reusing a broken identity.
- **[Risk] Recovery still re-plans due to label reset elsewhere** → Mitigation: regression test that planning is not re-invoked when only plan-review failed; fix any label/stage projection that still demotes to planning on reviewer harness failure.

## Migration Plan

1. Ship behavior behind normal release; no config schema break.
2. Operators on subscription-only Claude remove temporary PATH shims after upgrade.
3. Operators who intentionally require Fable keep explicit `models.review: claude-fable-5` (fail-closed without silent demotion).
4. Rollback: revert the change; temporary PATH shim remains the known operational workaround (not repository config).

## Open Questions

None that block specs. Allowlisted fallback model is fixed to `sonnet` unless a later change adds a config key (out of scope here).
