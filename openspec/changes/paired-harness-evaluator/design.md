## Context

The current evaluator has a single `harness` treatment axis. Its end-to-end mode invokes that same harness for every stage, and its independent Cartesian `harness`, `model`, and `effort` axes cannot express valid harness-specific configurations. The current production baseline is Claude primary with Codex review; the decision under evaluation requires comparing that pair to Codex/Grok alternatives under identical fixtures.

## Goals / Non-Goals

**Goals:**

- Make valid named treatments first-class and preserve current axis expansion unchanged.
- Execute an isolated implementation → review → fix → re-review trajectory with distinct primary and reviewer coordinates.
- Supply the reviewer with the actual current worktree diff, never a static fixture diff.
- Preserve no-production-write, timeout, resume, trajectory, and deterministic-grading guarantees.

**Non-Goals:**

- Simulating every production stage, GitHub issue comment, or PR lifecycle.
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

## Risks / Trade-offs

- **Dynamic primary diffs lack a fixed review oracle.** → Report final deterministic correctness and convergence here; retain seeded review fixtures for precision/recall.
- **Paired cells cost more than single-stage cells.** → One shared timeout, explicit plan-before-run, bounded concurrency, and screening before paired trials.
- **A model CLI may not reveal its resolved default.** → Persist requested model (or `null` for a default) and CLI version; never infer an unavailable resolved ID.
- **A reviewer finds no blocking issue.** → Skip fix, still perform final review accounting and deterministic checks.

## Migration Plan

1. Add validation, expansion, execution, grading, reporting, fixtures, and unit tests behind the new mode.
2. Regenerate the plugin mirror and pass the full CI gate.
3. Run plan-only manifests, then a bounded baseline-versus-candidate experiment in local eval output.
4. Roll back by omitting `named_treatments` and `mode: "paired"`; all prior manifests remain valid.

## Open Questions

- Historical run artifacts are absent from this isolated worktree. Additional harvested fixtures require the source run store to be made available to this evaluation workspace.
