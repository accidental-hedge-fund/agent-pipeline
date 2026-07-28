## Context

The current evaluator has a single `harness` treatment axis. Its end-to-end mode invokes that same harness for every stage, and its independent Cartesian `harness`, `model`, and `effort` axes cannot express valid harness-specific configurations. The current production baseline is Claude primary with Codex review; the decision under evaluation requires comparing that pair to Codex/Grok alternatives under identical fixtures.

## Goals / Non-Goals

**Goals:**

- Make valid named treatments first-class and preserve current axis expansion unchanged.
- Execute an isolated implementation → review → fix → re-review trajectory with distinct primary and reviewer coordinates.
- Execute a deployable full-pipeline policy through planning → plan-review → plan revision → implementation → both review/fix rounds.
- Supply the reviewer with the actual current worktree diff, never a static fixture diff.
- Preserve no-production-write, timeout, resume, trajectory, and deterministic-grading guarantees.

**Non-Goals:**

- Simulating GitHub issue comments, labels, PR mutation, CI, merge, or deployment.
- Evaluating the OpenSpec planning variant. `pipeline-paired` currently
  exercises the production freeform planning contract; OpenSpec planning must
  be added as an explicit corpus/treatment dimension before results can be
  generalized to that path.
- Declaring reviewer precision/recall from primary-generated findings; seeded review fixtures remain the authoritative measurement for that role metric.
- Changing a production profile, routing live traffic, or auto-selecting a winner.

## Decisions

### 1. Named treatments are an additive manifest alternative

`treatments` keeps its current Cartesian axes. A new `named_treatments` array is mutually exclusive with it; each item has a stable `id`, `primary` coordinate, and, for `paired` mode, a `reviewer` coordinate. A coordinate names a registered local CLI harness plus optional model and effort. The explicit `id` becomes the treatment id and is validated for uniqueness and path safety.

This avoids invalid cross-products such as a Grok model being sent to Codex while retaining all existing manifests and report joins.

### 2. Paired execution starts from an implementing fixture

`mode: "paired"` requires a fixture with an `implementing` stage artifact. In one fresh worktree and one shared deadline, the runner invokes the primary with the implementing prompt, derives the actual `git diff <base_sha>`, invokes the reviewer with the task plus that diff and the structured verdict contract, invokes the primary with blocking findings when present, then derives the updated diff and re-reviews it. Public checks run only after the final primary state; hidden checks remain grader-only.

The pair uses the same primary coordinate for implementation and fix. This is deliberate: it measures the selected operating pair without multiplying the first experiment by phase-specific routing. Separate phase routing remains a later treatment concern.

### 3. Review findings are structured and convergence is observable

The paired reviewer prompt requires the existing review-verdict JSON shape. The cell detail records primary/reviewer coordinate provenance, initial and final diff hashes, both review outputs/findings, whether a fix was invoked, remaining blocking findings, and per-phase duration/success. A malformed verdict is a completed poor treatment outcome, not an approval.

`paired` implementation grading consumes only the final checks and changed paths. Pair convergence (fix invoked, blocking findings before/after, final review success) is reported independently; independent seeded-defect review grades remain separate rather than being fabricated from primary-generated diffs.

### 4. Safety and scheduling remain inherited

Paired cells reuse the existing per-cell worktree, evaluation GitHub refusal surface, stripped credential environment, deadline, and cleanup path. The scheduler interleaves by a stable treatment identity derived from both pair members. A named treatment preflight checks each distinct harness before invoking it.

### 5. Pipeline-paired treatments preserve deployable policy coupling

`pipeline-paired` adds a complete `policy.models` and `policy.effort` object
with the same planning, implementing, review, and fix slots a repository can
configure. The primary coordinate selects the implementer harness; the
reviewer coordinate selects the reviewer harness and may carry the structured
`review_harness.model` / `review_harness.effort` override. The runner passes
the produced plan, plan-review feedback, revised plan, and worktree diffs
between stages rather than substituting frozen downstream artifacts.

The mode intentionally preserves shared production slots: review model/effort
feed plan-review and both review rounds unless the reviewer override applies,
and the fix slot feeds both fix rounds. Treatments that cannot be represented
by this policy shape are rejected before execution.

### 6. Production prompt and policy contracts are shared, not approximated

`pipeline-paired` calls the pure production builders for planning,
plan-review, plan revision, implementation, standard review, adversarial
review, and both fixes. Implementation/fix builders accept an additive
evaluation execution mode that appends a final no-commit/no-push override;
their default production output remains byte-identical.

The executor embeds the installed eval contract from the cell worktree,
enforces the production plan-review and plan-revision output gates, formats
review-1 context for adversarial review-2, and partitions blocking findings
with the production review policy. It still avoids the live stage
orchestrators because those require GitHub comments, labels, commits, and PR
state that an isolated evaluation cell must never create.

Review-2 happens before optional fix-2. Evidence therefore calls its finding
count `review_2_blocking_findings`; `final_diff_hash` describes the post-fix-2
worktree but does not imply a third review occurred. Reports preserve strict,
tolerant, and unparseable verdict counts per round and read named-treatment
dimensions from the resolved plan treatment rather than its arbitrary id.

## Risks / Trade-offs

- **Dynamic primary diffs lack a fixed review oracle.** → Report final deterministic correctness and convergence here; retain seeded review fixtures for precision/recall.
- **Paired cells cost more than single-stage cells.** → One shared timeout, explicit plan-before-run, bounded concurrency, and screening before paired trials.
- **A model CLI may not reveal its resolved default.** → Persist requested model (or `null` for a default) and CLI version; never infer an unavailable resolved ID.
- **A reviewer finds no blocking issue.** → Skip fix, still perform final review accounting and deterministic checks.
- **OpenSpec planning can differ materially from freeform planning.** → State
  the current freeform-only boundary in reports and add OpenSpec as an
  explicit future evaluation dimension rather than silently pooling it.

## Migration Plan

1. Add validation, expansion, execution, grading, reporting, fixtures, and unit tests behind the new mode.
2. Extend the mode with deployable `pipeline-paired` policy validation and the full dynamic stage graph.
3. Regenerate the plugin mirror and pass the full CI gate.
4. Run plan-only manifests, then bounded screens and replicated baseline-versus-candidate experiments in local eval output.
5. Roll back by omitting `named_treatments` and the paired modes; all prior manifests remain valid.

## Open Questions

- Historical run artifacts are absent from this isolated worktree. Additional harvested fixtures require the source run store to be made available to this evaluation workspace.
