## Context

The pipeline already has a human-only, loop-isolated merge primitive: `pipeline merge <pr>` → `mergePr` in `core/scripts/stages/merge.ts`, with gates for mergeability, required checks, and linked-issue `pipeline:ready-to-deploy`. The autonomous advance loop never merges (rule #4 / `pipeline-state-machine`).

Issue #673 (sibling) defines selection + dry-run: an ordered candidate set of R2D PRs (e.g. by milestone) with plan-only output and zero merges. This change (#674) adds **drive**: after the operator reviews that set, an explicit apply flag walks the list and merges via the existing primitive.

Constraints:
- Never introduce `auto_merge` config or advance-loop merge.
- Prefer reusing `mergePr` / `MergeDeps` over a second `gh pr merge` path.
- Same-base merges must be single-flight (no parallel merges racing the base).
- Single-operator / single-host apply is the supported concurrency model for v1.

## Goals / Non-Goals

**Goals:**
- Sequential, single-flight drive over an ordered candidate list from the selection contract.
- Explicit apply/confirm required; dry-run remains default.
- Pre-merge revalidation; clear per-item outcomes; fail-stop on hard failures.
- Structural reuse of `mergePr` and preservation of never-auto-merge.
- Hermetic unit tests via injected deps.

**Non-Goals:**
- Conflict/CI surgical repair and re-gate loops (#675).
- Release prepare when the queue completes (#676).
- Redefining selection filters, milestone query, or dry-run formatting (#673).
- Cross-host distributed merge locking.
- Changing squash/delete-branch policy or merge gate semantics beyond calling them again per item.
- Background daemon or scheduled merge.

## Decisions

### Decision: Fail-stop on hard failure (not hold-and-continue)

**Default policy:** when an item cannot be merged for a hard reason, **stop the drive** and leave remaining candidates unattempted.

Hard reasons include:
- Pre-drive revalidation fails because the PR is not mergeable / not CLEAN, required checks not green, linked issue not at `pipeline:ready-to-deploy`, or the PR is open but no longer in policy scope for this queue.
- `mergePr` throws (conflict, checks, stage gate, merge API error).

**Exception — already-done:** if revalidation finds the PR already merged or closed (or otherwise terminal-done), record **skipped (already-done)** and **continue** to the next candidate. This avoids stopping a queue because an operator already merged the head of the list.

**Rationale:** sequential merges share a base; continuing after a conflicted or check-failed item races the rest of the queue and obscures the first actionable repair. Fail-stop matches the user story (“stopping cleanly … rather than racing the rest of the queue”). Hold-and-repair continues in #675.

*Alternatives considered:*
- **Hold item, continue** — better for independent bases; wrong default for same-base milestone queues; deferred to optional later flag only if product demand appears (out of scope for v1).
- **Retry N times** — mixes drive with repair; belongs in #675.

### Decision: Drive calls `mergePr` for every merge

Drive MUST invoke the exported `mergePr(pr, deps)` (or a thin wrapper that only adds queue logging around that call). It MUST NOT implement a second merge path that shells `gh pr merge` with different flags or weaker gates.

*Rationale:* single policy surface, existing unit tests, TOCTOU `--match-head-commit` behavior preserved.

*Alternative:* thin reimplementation for “queue speed.” Rejected — forks policy and violates acceptance criteria.

### Decision: Apply flag is mandatory for mutation; dry-run is default

Drive mode activates only when the operator passes an explicit apply/confirm flag (canonical name: `--apply`). Without it, merge-queue remains selection/dry-run only (per #673) and performs zero merges. There is no config default that turns apply on.

*Authority model:* the operator who runs `--apply` is the merge authority for that process session, equivalent to repeatedly running `pipeline merge` with less toil — not a standing auto-merge grant.

### Decision: Revalidate immediately before each merge (not only at selection time)

Selection/dry-run may be minutes old. Before each `mergePr`, drive re-fetches eligibility for that candidate (open state, R2D/stage, mergeable/CLEAN, checks — at minimum the gates `mergePr` itself enforces, plus “still open / not already merged”). Drive may rely on `mergePr`’s internal gates for the final refuse path, but MUST still surface queue-level outcome rows with reasons and MUST NOT start the next merge until the current attempt settles.

*Ordering:* process candidates in the ordered list from selection; never reorder during drive except by skip/stop outcomes.

### Decision: Single-flight by construction (async await loop, no parallel pool)

Implementation is a strict sequential loop: await revalidation + await merge for item i before starting i+1. No worker pool, no concurrent `Promise.all` over merges. Unit tests assert merge call order and that merge N+1 is not invoked until merge N’s promise settles (including failure).

### Decision: Module placement and DI

- Prefer a focused module (e.g. `core/scripts/stages/merge-queue-drive.ts` or sibling under the merge-queue package introduced by #673) exporting something like `driveMergeQueue(candidates, deps)`.
- `DriveDeps` extends or composes `MergeDeps` plus selection revalidation I/O and logging/reporting.
- CLI dispatches apply mode only; advance/dispatch tables never import drive.

### Decision: Report shape (operator-facing)

Drive SHALL emit a structured summary (human-readable; JSON optional only if already supported by the parent command surface — not required by this change) listing each candidate as one of: `merged`, `skipped-already-done`, `failed` / `stopped` with reason, and `not-attempted` for remaining items after fail-stop. Exit non-zero if any item failed/stopped for a hard reason or if apply was requested with an empty eligible set after selection (exact empty-set exit code may match parent CLI conventions).

### Decision: Concurrency scope

Document single-operator assumption. Optional same-host PID lock for the merge-queue apply process is allowed if trivial and consistent with existing `lock.ts` patterns, but is not a cross-host guarantee. No new GitHub-level merge lock.

## Risks / Trade-offs

- **#673 not landed** → Drive depends on an ordered candidate type/API. Mitigation: define a minimal `MergeQueueCandidate` contract in specs (pr number, issue number optional, ordered position); implement against that interface even if selection lives in the sibling change.
- **Base drift after each merge** → Later PRs may become conflicted mid-queue. Mitigation: fail-stop is intentional; #675 handles repair.
- **Double gating (drive revalidation + mergePr gates)** → Slightly more `gh` calls. Acceptable for safety and clear queue reasons.
- **Operator mis-applies large milestone** → Mitigation: dry-run default; explicit `--apply`; sequential stop on first hard failure.
- **False “already-done” detection** → Mitigation: use authoritative PR state (`merged`/`closed` via `gh pr view` fields verified live at implementation time per rule #5).

## Migration Plan

- Pure additive CLI mode; no config migration.
- No change to existing `pipeline merge <pr>` behavior.
- Rollback: remove apply dispatch; leave selection/dry-run intact.

## Open Questions

- Exact CLI keyword (`merge-queue` vs nested under `merge`) is owned by #673; this design assumes a single human-gated merge-queue command with `--apply`. If #673 chooses a different flag name for confirm, drive requirements map to that flag 1:1.
- Whether apply should accept a subset filter (e.g. only first K) is out of scope unless #673 already defines it; v1 drives the full ordered set from selection.
