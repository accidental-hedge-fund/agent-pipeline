## Context

`invoke(harness, worktreeDir, prompt, opts)` in `core/scripts/harness.ts` builds argv per harness. The `claude` branch appends `--model` and `--effort`; the `codex` branch appends only `-c model_reasoning_effort=<value>` and drops `opts.model`; a custom reviewer CLI receives just the prompt positional. `codex exec` accepts `-m <model>` and `-c model_reasoning_effort=<level>`, so codex model passthrough is a one-line argv addition — the hard part is the resolution layer above it.

Reviewer model/effort resolve through two seams:
- `resolveConfig()` (`config.ts`) sets `cfg.harnesses.reviewerModel` from the structured `review_harness.model` (expanded via `expandAutoModel(raw, "review-2", "claude")`) and leaves `cfg.harnesses.reviewerEffort` as-authored; `cfg.models.review` is `expandAutoModel(fileConfig.models?.review, "review-2", "claude") ?? default`.
- `invokePromptHarnessReview()` (`review-routing.ts`) computes `model = opts.model ?? cfg.harnesses.reviewerModel ?? cfg.models.review` and passes it to `invokeReviewer` → `invoke`.

Both expansions hardcode the harness argument as `"claude"`. The `auto` sentinel routes through `stage-routing.ts`'s matrix, whose Adversarial cells (`plan-review`, `review-1`, `review-2`) resolve to `claude-fable-5` for **both** `claudeModel` and `codexModel` — a claude-only alias the codex CLI does not recognize.

## Goals / Non-Goals

- Goal: a configured reviewer model (structured `review_harness.model`, else `models.review`) reaches `codex exec` as `-m <model>`, with effort continuing via `-c model_reasoning_effort`.
- Goal: `auto` never produces a claude alias sent to codex.
- Goal: retire the now-false "codex reviewer model is inert" warning without dropping the warning for genuinely inert cases (custom reviewer CLIs, codex implementer keys).
- Non-Goal: implementer (`--profile codex`) model passthrough for `planning`/`implementing`/`fix` — same mechanism, tracked separately.
- Non-Goal: API `model-endpoint` executor reasoning controls (#434); adding new reviewer CLIs (#431).

## Decisions

### 1. `invoke()` codex branch is a dumb passthrough

The codex branch appends `-m <opts.model>` whenever `opts.model` is set — no validation, no alias filtering. Keeping `invoke()` mechanical means the "should a model be passed at all" judgment lives in exactly one place (the resolution layer), matching how the claude branch already trusts its caller.

### 2. Alias-dropping lives in the reviewer resolution layer, not in `invoke()`

For a codex reviewer, an `auto`-resolved reviewer model is a claude-only alias (`claude-fable-5`) with no codex equivalent in the matrix. Rather than invent a placeholder codex adversarial model (a model-selection decision out of scope here) or send a claude alias codex will reject, the resolution layer drops the model (passes `undefined`) so codex falls back to its configured default — exactly today's effective behavior for `auto`. Concretely: resolve the reviewer model with the reviewer's real harness, and when the reviewer is codex and the resolved value is a claude-only alias, substitute `undefined`. An **explicit** (non-`auto`) reviewer model is always passed verbatim — the operator owns naming a codex-valid id, and criterion 5 (surface codex's error) covers a bad one.

"Claude-only alias" is the set the routing matrix and claude CLI use (`sonnet`, `opus`, `claude-fable-5`, `haiku`, any `claude-*`). Because the only `auto` path that reaches a codex reviewer resolves to `claude-fable-5`, the practical rule is narrow; the implementation should still gate on a small explicit allowlist/denylist rather than a fragile prefix guess, backed by a runtime test (types are stripped, not checked).

### 3. Inert-model warning mirrors the inert-effort warning

`warnInertEffort` already warns only for a **custom** reviewer CLI (neither claude nor codex), because both built-ins honor effort. Model honoring now has the same shape for the reviewer role: claude honors `--model`, codex honors `-m`, only a custom CLI is inert. So the `models.review` branch of `warnInertModelAliases` is reframed to warn iff the reviewer is neither claude nor codex — the same predicate `warnInertEffort` uses. Implementer-role keys keep the existing `role === "codex"` predicate (implementer passthrough is out of scope, so those aliases remain genuinely inert under codex). The `validateConfig` mirror of this warning is updated in lockstep.

### 4. Error surfacing is already load-bearing; assert it

`formatStderrExcerpt` already appends a bounded codex stderr excerpt to blocked-item evidence, and reviewer model is recorded in the accounting/evidence path. An unavailable-model run exits nonzero → the existing `!result.success` branch blocks with codex's own error. The change adds a regression test asserting the configured model id and codex's CLI output both appear in the evidence, rather than new surfacing code.

## Risks / Trade-offs

- Explicit claude alias with a codex reviewer (e.g. `models.review: sonnet`, reviewer codex) now passes `-m sonnet` to codex, which will error at runtime instead of being warned about at config-load. This is deliberate: the passthrough is the operator's responsibility and criterion 5 surfaces codex's error. If desired, a follow-up could add a soft advisory, but conflating "honored" with "inert" is what this change removes.
- `cfg.models.review` is consumed by other reviewer call sites (`pre_merge.ts`, `planning.ts` plan-review, `roadmap-deps.ts`, `auto_merge_eligibility.ts`, `shipcheck.ts`). The alias-drop must be applied wherever a reviewer model is handed to a codex reviewer, not only the two standard review rounds — otherwise a codex plan-review could still receive `claude-fable-5`. The implementation should centralize the "resolve a reviewer model for harness H" step so every reviewer call site shares it.
