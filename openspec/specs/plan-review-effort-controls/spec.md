# plan-review-effort-controls Specification

## Purpose
TBD - created by archiving change planning-stall-codex-plan-review. Update Purpose after archive.
## Requirements
### Requirement: InvokeOptions SHALL accept a reasoningEffort field for codex calls
`InvokeOptions` in `harness.ts` SHALL accept an optional `reasoningEffort` string field.
When `harness === "codex"` and `reasoningEffort` is set, `invoke()` SHALL append
`-c model_reasoning_effort=<value>` to the codex args immediately before the prompt
positional argument. When `reasoningEffort` is absent or the harness is not `"codex"`,
the field SHALL be silently ignored.

#### Scenario: reasoningEffort passed to codex args
- **WHEN** `invoke("codex", dir, prompt, { reasoningEffort: "medium" })` is called
- **THEN** the codex process SHALL be spawned with args
  `["exec", "--full-auto", "-C", dir, "-c", "model_reasoning_effort=medium", prompt]`

#### Scenario: reasoningEffort absent — args unchanged
- **WHEN** `invoke("codex", dir, prompt, {})` is called without `reasoningEffort`
- **THEN** the codex process SHALL be spawned with args
  `["exec", "--full-auto", "-C", dir, prompt]` (no reasoning-effort flag)

#### Scenario: reasoningEffort ignored for claude harness
- **WHEN** `invoke("claude", dir, prompt, { reasoningEffort: "medium" })` is called
- **THEN** the claude process SHALL NOT include any `-c model_reasoning_effort` flag
- **AND** the claude invocation SHALL be unchanged from its prior shape

### Requirement: Plan-review codex invocation SHALL cap reasoning effort to medium
The plan-review invocation in `planning.ts` SHALL pass `reasoningEffort: "medium"` in
its `InvokeOptions`. This cap SHALL apply regardless of the operator's global codex
config and SHALL NOT be overridable via `pipeline.yml`.

#### Scenario: plan-review invocation includes reasoning-effort cap
- **WHEN** the pipeline reaches the plan-review step with `cfg.harnesses.reviewer === "codex"`
- **THEN** the codex invocation SHALL include `-c model_reasoning_effort=medium` in its args

#### Scenario: review-1 and review-2 invocations are unchanged
- **WHEN** the pipeline reaches review-1 or review-2
- **THEN** those codex invocations SHALL NOT include any `-c model_reasoning_effort` flag
  (they are unaffected by this change)

### Requirement: Plan-review SHALL use plan_review_timeout, not review_timeout
The plan-review `invokeReviewer` call in `planning.ts` SHALL pass
`timeoutSec: cfg.plan_review_timeout` instead of `timeoutSec: cfg.review_timeout`.

#### Scenario: plan-review times out using plan_review_timeout
- **WHEN** `cfg.plan_review_timeout` is 300 and the plan-review harness does not complete within 300 s
- **THEN** `runCapped` SHALL kill the process and return `timed_out: true`
- **AND** `planning.ts` SHALL block the issue with a message reporting the 300 s timeout
- **AND** `review_timeout` SHALL NOT be the timeout used

#### Scenario: plan_review_timeout absent — default 300 s applies
- **WHEN** `.github/pipeline.yml` does not set `plan_review_timeout`
- **THEN** the plan-review wall-clock cap SHALL be 300 s

### Requirement: Plan-review output missing the verdict header SHALL block the issue
After receiving plan-review output, `planning.ts` SHALL check whether the output
contains the string `## Plan Review Verdict`. When the header is absent, the pipeline
SHALL block the issue at stage `plan-review` with tag `needs-human` and a message that
identifies the missing section. It SHALL NOT pass the output to the plan-revision step.

#### Scenario: verdict header present — pipeline continues
- **WHEN** plan-review output contains `## Plan Review Verdict`
- **THEN** the pipeline SHALL continue to the plan-revision step as normal

#### Scenario: verdict header absent — issue blocked immediately
- **WHEN** plan-review output does not contain `## Plan Review Verdict`
- **THEN** `planning.ts` SHALL call `setBlocked` with a message that includes
  `"plan-review output missing required"` and `"## Plan Review Verdict"`
- **AND** the plan-revision step SHALL NOT be invoked
- **AND** the issue SHALL remain at stage `plan-review`

#### Scenario: empty plan-review output — issue blocked
- **WHEN** plan-review output is an empty string (or whitespace only)
- **THEN** the missing-verdict-header check SHALL trigger
- **AND** the issue SHALL be blocked at `plan-review` with an appropriate message

