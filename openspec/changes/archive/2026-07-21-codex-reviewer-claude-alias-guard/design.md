## Context

#441 made the reviewer model a real passthrough for the codex reviewer. Its guard
(`resolveReviewerModelForHarness` in `stage-routing.ts`) deliberately drops a Claude-only
alias only when it came from the `auto` sentinel; an **explicit** value is forwarded verbatim
"so codex can surface its own invalid-model error rather than silently falling back". That
decision is right for an unknown-but-plausible model id — the engine must not second-guess
which OpenAI models an account has — but it is wrong for the closed set of ids the engine
already knows codex can never accept (`isClaudeOnlyModelAlias`). For those, "let codex surface
the error" means: fail at every review stage, after the planning stage has already run.

## Goals / Non-Goals

- Goal: move a *known-impossible* reviewer model/harness pairing from mid-run failure to
  config-parse failure, with an actionable message.
- Goal: keep one source of truth for "which model ids are claude-only"
  (`isClaudeOnlyModelAlias`).
- Non-Goal: validating arbitrary model ids against the operator's account (unknowable at parse
  time — an unrecognized-but-plausible id still fails at the CLI, by design).
- Non-Goal: changing runtime passthrough, `auto` resolution, or implementer-role alias
  behavior.

## Decisions

**Decision: reject, don't silently coerce to `auto`.**
Silently substituting the codex default would make the run succeed with a model the operator
never asked for — exactly the class of surprise that made #441's explicit-passthrough rule
correct. A hard parse-time error preserves operator intent and costs one config edit. It also
mirrors how the schema already treats structurally impossible config (`harnesses:` rejected
outright, `stage_executors` model-endpoint eligibility) — fail fast, name the key.

**Decision: validate in `resolveConfig`, after the reviewer harness is resolved — not in the
zod schema.**
The rejection is conditional on the *effective* reviewer, which depends on the active profile
plus a `review_harness` override; the per-field zod schema cannot see it. This is the same
shape as `validateStageExecutorAssignments`: a post-parse function that throws a single Error
naming the offending key, called from `resolveConfig` and mirrored as a diagnostic in
`validateConfig`.

**Decision: cover both reviewer model sources.**
`models.review` and `review_harness.model` feed the same reviewer invocation (`reviewerModel`
takes precedence over `models.review`). Guarding only the first would leave an identical
mid-run 400 reachable through the structured form, so both are validated, each reported under
its own key path.

**Decision: `tolerateInvalidConfig` keeps its existing semantics.**
`init` (and any other tolerant caller) warns and falls back rather than throwing, consistent
with how the stage-executor validation already degrades — an operator running `init` on a
misconfigured repo should still get labels and a scaffold.

**Decision: error text prescribes the fix.**
The message names the rejected value and offers the two valid shapes for a codex reviewer: a
codex-supported OpenAI model id (e.g. `gpt-5.6-terra` / the `gpt-5.x-codex` family) or `auto`,
flagged as the safe default because it resolves round-aware and defers to the operator's
`~/.codex/config.toml`. Without this, the operator's likely next move is to guess another
Claude alias.

## Risks / Trade-offs

- A repo pinned to a Claude alias with a codex reviewer now fails at parse time on *every*
  command, not just review stages. This is intended (the config was already unusable) and the
  remediation is stated in the error.
- `CLAUDE_ONLY_MODEL_ALIASES` is a maintained list; a future Claude alias not in it would
  still fall through to a mid-run 400. Acceptable — the list already backs the `auto` guard,
  so both paths improve together.
