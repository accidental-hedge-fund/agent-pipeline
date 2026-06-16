## Context

The pipeline already has two post-implementation gating layers before `ready-to-deploy`:
- `pre-merge` — CI and mergeability checks.
- `eval-gate` — runs a repo-provided shell command (test suite, scoring harness) and treats exit code as pass/fail.

Neither layer asks "did the change satisfy the issue's stated acceptance criteria?" from the perspective of an independent evaluator. The `shipcheck-gate` fills this gap by invoking the **reviewer** harness with a structured rubric and the full context of the completed change.

The key constraint from the issue: the implementing harness must not self-certify. This is the same separation already enforced by review-1/review-2 (separate harness from implementing), applied to acceptance evaluation.

## Goals / Non-Goals

**Goals:**
- Run an independent, reviewer-owned acceptance rubric after all implementation, review, fix, and eval work.
- Default to advisory mode so false positives don't block shipping before the gate's accuracy is calibrated.
- Allow a repo to graduate to gate mode via config once they trust the rubric.
- Surface findings on the issue/PR with enough detail for a human to act on.
- Bound the gate's runtime with a configurable max-rounds limit; never silently pass on timeout.

**Non-Goals:**
- Auto-merge or auto-remediation on shipcheck pass.
- Publishing the rubric contents publicly on the PR (the rubric lives in a private repo file).
- Replacing code review or CI — those remain separate, earlier gates.
- Running the rubric on every commit (this is a pre-`ready-to-deploy` one-shot, not a continuous check).

## Decisions

### Decision: Stage position — after eval-gate, before ready-to-deploy

Placing `shipcheck-gate` after `eval-gate` means the evidence bundle already contains eval results when the shipcheck runs. The rubric prompt can reference eval pass/fail as evidence. Alternatives considered:

- **After pre-merge, before eval-gate**: eval-gate is optional and often not configured; putting shipcheck before it avoids a dependency, but loses the eval result as rubric input and breaks the "all automated checks done" precondition.
- **Alongside review-2**: Would re-run review harness in parallel with adversarial review. Rejected — rubric evaluation is a distinct activity from finding code defects; merging them complicates both prompts.

### Decision: Reviewer harness owns the rubric evaluation

The rubric is invoked via `cfg.harnesses.reviewer` — the same harness role used for `review-1` / `review-2`. This guarantees separation from the implementer. The reviewer prompt for shipcheck is a distinct template (`prompts/shipcheck.md`) that embeds the rubric, issue body, plan, ACs, changed files, and evidence bundle excerpt, and asks for a structured acceptance verdict (pass/partial/fail + per-criterion findings).

Alternative considered: a third harness role (`evaluator`). Rejected — it adds config surface without new capability; the reviewer role already embodies "independent evaluator."

### Decision: Advisory mode default; gate mode opt-in via config

`mode: advisory` (default when not set) — the stage posts findings and a summary, then transitions to `ready-to-deploy` regardless of verdict. `mode: gate` — blocks `ready-to-deploy` on a `fail` verdict (partial may also block, configurable).

This matches the issue's stated guidance: "Should stay advisory-first until the false-positive rate is understood." Teams graduate to `gate` mode when they've calibrated the rubric against their own history.

### Decision: Rubric lives at a repo-local path, defaults to .github/shipcheck-rubric.md

The rubric is a repo-private Markdown file. Its path is set by `shipcheck_gate.rubric_path` (default `.github/shipcheck-rubric.md`). The pipeline reads it at runtime and embeds it in the reviewer prompt. This keeps the rubric out of public PR comments and decoupled from the pipeline's own source.

Alternative: inline rubric in `pipeline.yml`. Rejected — YAML is hostile for multi-line prose rubrics; a separate Markdown file is easier to maintain and diff.

### Decision: Bounded by max_rounds; timeout surfaces as needs-human

`max_rounds` (default 1) limits how many reviewer invocations the gate makes. A single round is almost always sufficient for an acceptance rubric (unlike code review, which may need fix cycles). If the reviewer output is unparseable or times out after all rounds, the stage sets `blocked` (in gate mode) or logs a warning and advances (in advisory mode) — it never silently passes.

### Decision: Verdict schema reuses the review-verdict structure for findings, adds an acceptance field

The reviewer returns a JSON object matching the shipcheck verdict schema: `{ verdict: "pass" | "partial" | "fail", summary: string, criteria: CriterionResult[] }` where each `CriterionResult` is `{ criterion: string, result: "pass" | "fail" | "na", note: string }`. This is a separate schema from `REVIEW_VERDICT_SCHEMA` (which uses `approve` / `needs-attention`) — distinct concepts should have distinct schemas. The schema is single-sourced in `review-schema.ts` alongside the review schema and drift-guarded by the existing schema test.

## Risks / Trade-offs

- **False-positive rate**: A vague or over-specified rubric will block real work in gate mode. Mitigation: advisory-first default and human review of the posted findings before graduating to gate mode.
- **Rubric maintenance**: The rubric is a separate file that drifts from issue acceptance criteria over time. Mitigation: the prompt instructs the reviewer to cross-reference the issue's stated ACs as the ground truth; the rubric is a supplement, not a replacement.
- **Reviewer model cost**: Each shipcheck round is an additional harness invocation. In advisory mode this adds latency but no blocking risk. Mitigation: `max_rounds: 1` default; teams can increase if they want retry on parse failure.
- **Config coupling to eval-gate**: If `eval-gate` is disabled (skipped), the evidence bundle won't have eval results, so the shipcheck prompt will note their absence. This is not a failure — the rubric evaluates acceptance criteria, not eval scores.
