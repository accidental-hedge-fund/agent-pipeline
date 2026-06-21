## Why

The codex plan-review step inherits the operator's global reasoning effort (e.g., `xhigh`),
causing it to run for ~18–20 minutes on complex issues — spending the entire `review_timeout`
budget exploring the repo and rewriting the plan in prose instead of returning the tight
structured verdict the pipeline expects — then timing out with no progress. The plan-review
step should deliver a concise verdict quickly; it should never inherit pathological deliberation
settings from the operator's global codex config.

## What Changes

- **Add `reasoningEffort` to `InvokeOptions`** in `harness.ts`: when set, pass
  `-c model_reasoning_effort=<effort>` to the codex CLI so plan-review calls can cap effort
  to `medium` (or `low`) regardless of operator globals.
- **Add `plan_review_timeout` config key** in `config.ts`/`types.ts`: a shorter wall-clock
  cap used only for the plan-review invocation (default: 300 s), so a runaway plan-review
  fails fast rather than burning the full `review_timeout` (default 1500 s = 25 min).
- **Validate plan-review output for a parseable verdict**: when plan-review output contains
  no structured verdict block, block immediately with a specific actionable message rather
  than forwarding a 4 k-line prose ramble to the plan-revision step.
- **Wire all three controls in `planning.ts`**: pass `reasoningEffort: "medium"` and
  `timeoutSec: cfg.plan_review_timeout` to the plan-review `invokeReviewer` call; add the
  post-review verdict-presence check before calling the revision step.

## Capabilities

### New Capabilities

- `plan-review-effort-controls`: Per-call reasoning-effort override for codex harness
  invocations, a dedicated `plan_review_timeout` config field, and structured-verdict
  validation of plan-review output.

### Modified Capabilities

- `pipeline-configuration`: `plan_review_timeout` is a new optional numeric config key
  (seconds, default 300) added to `PartialConfigSchema` and `PipelineConfig`.

## Impact

- `core/scripts/harness.ts` — add `reasoningEffort?: string` to `InvokeOptions`; pass
  `-c model_reasoning_effort=<effort>` to codex args when set.
- `core/scripts/types.ts` — add `plan_review_timeout: number` to `PipelineConfig` and
  `DEFAULT_CONFIG` (default 300).
- `core/scripts/config.ts` — add `plan_review_timeout` to `PartialConfigSchema` and
  `resolveConfig`; include it in the config-template string.
- `core/scripts/stages/planning.ts` — pass `timeoutSec: cfg.plan_review_timeout` and
  `reasoningEffort: "medium"` to the plan-review `invokeReviewer` call; add
  verdict-presence check after plan-review output is received.
- `plugin/` mirror — regenerated via `node scripts/build.mjs`.
- No breaking changes to existing config files; the new key is optional with a safe default.
