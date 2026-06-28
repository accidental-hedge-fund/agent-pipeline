## Context

The pipeline's terminal state is `ready-to-deploy`; a human owns the merge button (structural guarantee in `pipeline-state-machine`). For low-risk scoped PRs, this is friction — the human must review metadata already captured in the evidence bundle. Issue #23 tracks graduated autonomy; this change adds the eligibility gate that makes classification auditable and machine-readable, enabling auto-merge *execution* as a safe follow-up.

Current state: no classification exists. The pipeline has clean review/CI/pre-merge checks but no structured way to express "this PR was boring and mechanical." The evidence bundle has a rich schema but no eligibility slot.

Constraints:
- The never-auto-merge structural guarantee (`pipeline-state-machine`) SHALL NOT be weakened. This gate produces metadata; it does not merge.
- The LLM judge is a *classifier*, not a gatekeeper. Deterministic policy holds the hard envelope; the judge only operates inside it.
- No new external dependencies. The judge uses the existing reviewer harness (or the same CLI invocation pattern as `reviewMode: prompt-harness`).

## Goals / Non-Goals

**Goals:**
- Classify each completed pipeline run as `auto-merge-eligible` or `needs-human` and persist the result in the run evidence bundle.
- Deterministic policy hard-denies any PR touching high-risk categories before the LLM judge is consulted.
- LLM judge emits a schema-validated structured output (scope size, blast radius, semantic risk, reversibility, confidence, reasons).
- Any judge failure mode (timeout, bad schema, low confidence, explicit denial) routes to `needs-human`.
- Configurable policy thresholds (diff line count, file count, deny/allow path patterns) via `.github/pipeline.yml`.
- CLI surfaces the eligibility result at run end.
- Tests cover all branches: eligible, hard-denied, judge uncertainty, judge schema failure, missing evidence.

**Non-Goals:**
- Auto-merge *execution* (no `git merge`, no `gh pr merge`). That is a follow-up.
- Changing what label the PR receives — it still gets `pipeline:ready-to-deploy`.
- A new STAGE in `STAGES` — the gate runs inside the `shipcheck-gate` handler or as a post-finalization step, not as a standalone label-gated stage (adding a stage would require all existing repos to traverse it; the gate is opt-in via config).

## Decisions

### Decision 1: Gate placement — inside `shipcheck-gate`, not a new stage label

**Chosen:** Run the eligibility gate inside the `shipcheck-gate` handler, after all its existing checks pass. Write the artifact to the evidence bundle before finalization.

**Alternatives:**
- *New stage between shipcheck-gate and ready-to-deploy*: Requires updating `STAGES` and every existing repo traverses it. Opt-in semantics are harder — you can't skip a stage without label surgery.
- *Post-finalization hook*: Runs after `ready-to-deploy` is set, so the artifact isn't in the evidence bundle that's written at finalization.
- *Separate CLI command*: Loses the pipeline integration; the result isn't captured in the run artifact.

**Rationale:** `shipcheck-gate` is the last guard before `ready-to-deploy`. Running inside it keeps the gate invisible when disabled (no new label, no new stage) and ensures the artifact lands in the evidence bundle before finalization.

### Decision 2: Two-phase check order — deterministic first, judge second

**Chosen:** Run deterministic policy checks before invoking the LLM judge. If any hard denial fires, skip the judge entirely and write `needs-human` with the denial reasons.

**Rationale:** LLM judge calls cost tokens and latency. Deterministic checks are cheap and infallible for hard categories. The judge adds value only within the envelope the policy allows.

### Decision 3: Judge invocation — same `reviewMode: prompt-harness` pattern

**Chosen:** Invoke the reviewer CLI with a JSON-returning prompt, identical to the review stage pattern. Schema is single-sourced and drift-guarded by a test. Judge output is validated against the schema before use.

**Alternatives:**
- *Inline LLM call (Anthropic SDK)*: Would add a new dependency and a different invocation path; inconsistent with the harness model.
- *Reuse review verdict*: The review verdict answers "does this code have bugs?" not "is this safe to auto-merge?" — different questions.

**Rationale:** Reusing the `prompt-harness` pattern means no new dependencies, no new I/O seam, and existing fake injection tests work the same way.

### Decision 4: Config keys in `.github/pipeline.yml` under `auto_merge_eligibility`

**Chosen:**
```yaml
auto_merge_eligibility:
  enabled: false            # opt-in; default off
  max_diff_lines: 300       # deterministic threshold
  max_files: 10             # deterministic threshold
  deny_paths: []            # always needs-human if any path matches
  allow_paths: []           # if set, only paths in this list may be auto-eligible
  min_confidence: 0.8       # judge confidence floor
```

**Rationale:** Namespace under `auto_merge_eligibility` avoids polluting the top-level config. `enabled: false` default preserves existing behavior for all repos — the gate is a no-op unless opted in. Zod schema strict validation rejects unknown keys.

### Decision 5: Hard-denied categories are a compile-time constant, not config

**Chosen:** The set of always-denied path patterns (migrations, auth, billing, security, infra, etc.) is a code constant in `auto_merge_eligibility.ts`, not overridable by repo config.

**Rationale:** These are safety invariants. Allowing repos to opt out of the "no auth changes auto-merged" rule defeats the purpose. The `deny_paths` config adds *more* denials; it cannot remove hard-coded ones.

### Decision 6: Eligibility artifact schema co-located with the stage, not in review-schema.ts

**Chosen:** Define `AutoMergeEligibilityArtifact` and `EligibilityJudgeOutput` in a new `auto-merge-eligibility-schema.ts` co-located with the stage.

**Rationale:** `review-schema.ts` is single-sourced for review verdicts and drift-guarded. Mixing eligibility schema into it would couple two independent concerns and make drift-guarding more complex.

## Risks / Trade-offs

- **Judge inconsistency** → The judge is a classifier, not the final authority. Deterministic checks hold the envelope. Low-confidence outputs route to `needs-human`, so inconsistency just increases human workload, it doesn't enable unsafe merges.
- **False negatives (safe PRs classified needs-human)** → Acceptable. Default is conservative; the gate is for reducing friction on genuinely routine changes, not for classifying everything.
- **Hard-coded deny categories miss novel risk vectors** → The deny list covers structural categories (migrations, auth, etc.); the LLM judge adds a semantic layer for unlisted patterns. Neither is a guarantee.
- **Gate adds latency to shipcheck-gate** → Only when `enabled: true`. The LLM call is bounded by the same harness timeout as review. Deterministic-only path (when judge is skipped on hard denial) is fast.
- **Config `enabled: false` default means zero adoption** → Intentional. Repos adopt when they're ready; this change just makes the capability available.

## Migration Plan

1. Deploy: new code lands behind `enabled: false` default — no behavior change for any existing repo.
2. Opt-in: a repo sets `auto_merge_eligibility.enabled: true` and tunes thresholds in `.github/pipeline.yml`.
3. Rollback: set `enabled: false` or remove the block; no state migration needed.

## Open Questions

- Should the eligibility verdict be surfaced on the PR as a label (`pipeline:auto-merge-eligible`, `pipeline:needs-human-review`) in addition to the evidence artifact? Deferred — this change persists the artifact only.
- Judge model: use the profile's reviewer harness, or always the cheapest available model? Defer to implementation; start with the profile reviewer.
