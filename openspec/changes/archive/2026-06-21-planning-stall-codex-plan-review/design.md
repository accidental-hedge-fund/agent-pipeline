## Context

The codex plan-review step (`planning.ts:~L357`) invokes `invokeReviewer` with
`timeoutSec: cfg.review_timeout` (default 1500 s) and no reasoning-effort cap.
The `invoke()` function in `harness.ts` builds codex args as
`["exec", "--full-auto", "-C", worktreeDir, prompt]` — no reasoning-effort flag —
so the operator's global codex config governs effort. With `reasoning effort: xhigh`
and model `gpt-5.5`, a complex issue's plan review ran for ~4,200 lines and ~18 min
before the timeout killed it, blocking every pipeline run on that issue.

The plan-review prompt (`plan_review.md`) requests a tight structured response
(`## Plan Review Verdict`, `## Required Changes`, `## Risks / Checks`). When codex
goes autonomous, none of those sections appear; the raw prose is then fed into the
plan-revision step, which cannot interpret it as a review.

## Goals / Non-Goals

**Goals:**
- Cap reasoning effort for plan-review codex invocations so they cannot inherit
  pathological global settings.
- Give plan-review its own shorter wall-clock budget (independent of `review_timeout`).
- Detect when plan-review output has no structured verdict and block fast with a
  specific message instead of feeding 4 k lines of prose into the revision step.
- Keep the fix surgical: no new pipeline.yml fields beyond `plan_review_timeout`
  (the only operator-tunable knob with a safe default).

**Non-Goals:**
- Making plan-review reasoning effort operator-configurable via pipeline.yml
  (hardcoding `"medium"` at the call site is sufficient and prevents regression;
  configurability can be added later if needed).
- Changing the review-1/review-2 reasoning effort or timeout (separate concern).
- Fixing the underlying codex global-config inheritance issue (external to this repo).

## Decisions

### D1 — Add `reasoningEffort?: string` to `InvokeOptions` in `harness.ts`

**Choice**: Add a new optional field to the existing `InvokeOptions` interface; when
set and `harness === "codex"`, append `-c model_reasoning_effort=<effort>` to the
codex args array before the prompt positional.

**Alternatives considered**:
- A separate `invokePlanReview` helper: rejected — unnecessary indirection; the
  existing `invokeReviewer` path already threads `InvokeOptions`.
- A module-level codex flag constant: rejected — `InvokeOptions` is already the
  right per-call customization seam.

**Rationale**: `InvokeOptions` is the established per-call customization surface
(used for `timeoutSec`, `model`, `sandbox`, `lean`). Adding `reasoningEffort` here
is consistent, injectable, and testable via the existing `deps.invoke` seam.

### D2 — Hardcode `reasoningEffort: "medium"` at the plan-review call site

**Choice**: Pass `reasoningEffort: "medium"` in the `planning.ts` plan-review
invocation directly; do not add a `plan_review_reasoning_effort` key to pipeline.yml.

**Alternatives considered**:
- Config field `plan_review_reasoning_effort: "low" | "medium" | "high"`: rejected —
  YAGNI; the bug is about uncontrolled inheritance and `medium` is always the right
  cap for a structured review verdict. A config field invites users to set it to
  `xhigh`, reproducing the bug.

**Rationale**: The plan-review step always produces a structured verdict; it never
benefits from `xhigh` deliberation. Hardcoding `"medium"` is the minimal fix that
closes the failure mode without exposing a new knob.

### D3 — Add `plan_review_timeout` as an optional config key (default 300 s)

**Choice**: Add `plan_review_timeout` to `PartialConfigSchema`, `PipelineConfig`,
and `DEFAULT_CONFIG` (default 300 s). Use it instead of `cfg.review_timeout` in the
plan-review `invokeReviewer` call.

**Alternatives considered**:
- Reduce `DEFAULT_CONFIG.review_timeout`: rejected — `review_timeout` governs
  review-1/review-2 which legitimately need a longer budget (they examine code, not
  just a plan).
- Hardcode a short timeout at the call site: rejected — operators with slow setups
  should be able to tune it without patching the engine.

**Rationale**: A dedicated config key with a safe default gives operators the tuning
knob without coupling plan-review latency to code-review latency. 300 s is
generous for a structured verdict on a plan.

### D4 — Validate plan-review output for the `## Plan Review Verdict` header

**Choice**: After receiving plan-review output, check whether it contains the string
`## Plan Review Verdict`. If absent, block the issue at `plan-review` with a
specific message (`plan-review output missing required "## Plan Review Verdict"
section`) rather than feeding the raw output into the revision step.

**Alternatives considered**:
- Full schema parse of the plan-review output: rejected — the plan-review response
  is Markdown prose, not JSON; there is no schema to parse.
- No validation, just log a warning: rejected — the revision step cannot function
  on unstructured output; silent continuation wastes another full revision timeout.

**Rationale**: The `## Plan Review Verdict` header is the only required structural
element in `plan_review.md`. Its absence is a reliable signal that the reviewer
went off-task. Blocking immediately is the right response.

## Risks / Trade-offs

- **`medium` effort may be insufficient for very large plans**: A complex 1000-line
  plan might get a shallower review at `medium` than at `high`. Mitigation: the
  plan-revision step (always `primary` harness = claude, no effort cap) synthesizes
  the review; the reviewer is a secondary check, not the sole arbiter. If `medium`
  proves insufficient in practice, a config field can be added then.
- **`plan_review_timeout: 300 s` may be tight for slow networks/cold starts**:
  Mitigation: operators can raise it in pipeline.yml; 300 s is the default, not a
  hard cap.
- **Verdict header check is a string match, not semantic validation**: If the
  reviewer returns `## Plan Review Verdict` followed by gibberish, the pipeline
  continues. Mitigation: the revision step catches incoherent feedback at the
  acknowledgement-section check (`verifyPlanRevisionOutput`).
