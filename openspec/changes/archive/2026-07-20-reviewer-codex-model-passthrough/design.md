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

For a codex reviewer, an `auto`-resolved reviewer model is a claude-only alias (`claude-fable-5`) with no codex equivalent in the matrix. Rather than invent a placeholder codex adversarial model (a model-selection decision out of scope here) or send a claude alias codex will reject, the resolution layer drops the model (passes `undefined`) so codex falls back to its configured default — exactly today's effective behavior for `auto`.

Since `models.review`/`cfg.harnesses.reviewerModel` are resolved once in `config.ts` with `"auto"` already expanded (hardcoded against the claude routing cells, which are harness-invariant for Adversarial stages), the resolution layer cannot distinguish "resolved from `auto`" from "explicitly authored as `claude-fable-5`" by the time a reviewer call site reads the value — both arrive as the identical string. Rather than thread the raw pre-expansion value through every call site to preserve that distinction, `resolveReviewerModelForHarness(model, reviewerHarness)` (`stage-routing.ts`) applies a single, harness-aware rule uniformly: **any** resolved reviewer model that is a claude-only alias is dropped for a codex reviewer, regardless of whether it came from `auto` or was authored explicitly. This matches the spec text's own example set (`claude-fable-5`, `sonnet`, `opus`) and is simpler and safer than trying to recover provenance — an operator who explicitly names a claude alias for a codex reviewer almost certainly intended the codex default, not a rejected flag. A non-claude-alias explicit id (e.g. `gpt-5.6-terra`) always passes through verbatim, whatever its origin.

"Claude-only alias" is the set the routing matrix and claude CLI use (`sonnet`, `opus`, `claude-fable-5`, `haiku`, any `claude-*`). The implementation gates on a small explicit allowlist/denylist (`isClaudeOnlyModelAlias`) rather than a fragile prefix guess, backed by a runtime test (types are stripped, not checked).

### 3. Inert-model warning mirrors the inert-effort warning

`warnInertEffort` already warns only for a **custom** reviewer CLI (neither claude nor codex), because both built-ins honor effort. Model honoring now has the same shape for the reviewer role: claude honors `--model`, codex honors `-m`, only a custom CLI is inert. So the `models.review` branch of `warnInertModelAliases` is reframed to warn iff the reviewer is neither claude nor codex — the same predicate `warnInertEffort` uses. Implementer-role keys keep the existing `role === "codex"` predicate (implementer passthrough is out of scope, so those aliases remain genuinely inert under codex). The `validateConfig` mirror of this warning is updated in lockstep.

### 4. Error surfacing is already load-bearing; assert it

`formatStderrExcerpt` already appends a bounded codex stderr excerpt to blocked-item evidence, and reviewer model is recorded in the accounting/evidence path. An unavailable-model run exits nonzero → the existing `!result.success` branch blocks with codex's own error. The change adds a regression test asserting the configured model id and codex's CLI output both appear in the evidence, rather than new surfacing code.

## Risks / Trade-offs

- An explicit claude alias with a codex reviewer (e.g. `models.review: sonnet`, reviewer codex) is dropped by the same rule that drops `auto`'s `claude-fable-5`, rather than being forwarded to error at codex's CLI boundary. This is a deliberate simplification over trying to distinguish "resolved from auto" from "authored explicitly" (config.ts pre-resolves `auto` before any call site sees it, so the two are indistinguishable strings) — and it matches the spec's own example set, which lists `claude-fable-5`, `sonnet`, and `opus` together as aliases that must never reach codex. A non-alias explicit id (e.g. `gpt-5.6-terra`) is unaffected and still surfaces codex's own error per criterion 5 if it's invalid.
- `cfg.models.review` is consumed by other reviewer call sites (`pre_merge.ts`, `planning.ts` plan-review, `roadmap-deps.ts`, `auto_merge_eligibility.ts`, `shipcheck.ts`). The alias-drop is applied wherever a reviewer model is handed to a codex reviewer, not only the two standard review rounds — otherwise a codex plan-review could still receive `claude-fable-5`. `resolveReviewerModelForHarness` (`stage-routing.ts`) centralizes the "resolve a reviewer model for harness H" step so every reviewer call site shares it.
