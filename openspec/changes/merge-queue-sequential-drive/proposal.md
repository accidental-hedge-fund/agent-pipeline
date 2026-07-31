## Why

Operators finishing a milestone often face a pile of `pipeline:ready-to-deploy` PRs and must run `/pipeline:merge` (or `pipeline merge`) one-by-one by hand. After the sibling selection/dry-run surface (#673) shows an ordered candidate set, there is still no **operator-invoked sequential drive** that re-validates each PR and merges through the existing human merge primitive — so merges stay toilsome and easy to race against a shared base. This change adds that drive mode only; it does not introduce silent auto-merge or let the advance loop merge.

## What Changes

- Add **merge-queue drive mode**: when the human-gated `merge-queue` command is invoked with an explicit apply/confirm flag (e.g. `--apply`), walk the ordered dry-runable candidate set **one PR at a time** and merge each via the existing `mergePr` / `/pipeline:merge` surface (same squash/policy/gates).
- Default remains dry-run / plan-only: drive **refuses** to perform merges without the explicit apply/confirm flag.
- Before each merge, **re-validate** candidate eligibility (still open, still R2D / policy labels, checks green, mergeable) and record a clear skip/stop reason when not eligible.
- On merge success, proceed to the next candidate. On hard failure (conflict, required-check failure, merge API error, or revalidation that leaves the item unmergeable for a reason other than already-done), **stop the drive** (fail-stop) and report completed / skipped / failed items — do not race remaining merges against a shared base.
- Preserve structural never-auto-merge: no `auto_merge` config key; advance loop remains merge-free; operator invoking `--apply` is the merge authority for that session only.
- Unit tests with injected selection + merge/check deps prove single-flight ordering and apply gating.

## Capabilities

### New Capabilities

- `merge-queue-drive`: Operator-invoked sequential drive of an ordered ready-to-deploy candidate set through the existing `mergePr` surface, with revalidation, single-flight merges, fail-stop on hard failure, and explicit apply/confirm required.

### Modified Capabilities

- `merge-sub-command`: Require that merge-queue drive reuses the existing `mergePr` / `MergeDeps` path (no unguarded `gh pr merge` fork).
- `pipeline-state-machine`: Extend the never-auto-merge structural guarantee so merge-queue drive is documented as a human-only, apply-gated surface and is never reachable from the advance loop.

## Impact

- **Depends on** #673 candidate selection + ordering + dry-run contract (ordered candidate list with PR/issue/head/check/mergeability fields). Drive consumes that list; it does not redefine milestone selection filters.
- **Likely code (implementation phase, not this proposal step):** drive module (e.g. under `core/scripts/stages/`), CLI wiring for `merge-queue --apply`, tests with fake deps; `plugin/` mirror regen if `core/` changes.
- **Does not change** review policy, CI thresholds, advance-loop stages, release cutting (#676), or conflict/CI surgical repair (#675).
- **Concurrency:** single-operator / single-host assumption for apply runs; no cross-host distributed merge lock in this change.

## Acceptance Criteria

- [ ] With an ordered candidate set of N eligible PRs and `--apply`, drive merges them strictly one at a time (never two concurrent merges to the same base) and only after each prior merge attempt finishes.
- [ ] Each successful merge is performed only by calling the existing `mergePr` (or equivalent exported merge handler used by `pipeline merge`), not a parallel unguarded `gh pr merge` implementation.
- [ ] Without `--apply` (or the documented confirm flag), invoking merge-queue performs zero merges, pushes, or irreversible GitHub mutations attributable to drive mode.
- [ ] Before attempting each merge, drive re-checks open/R2D/mergeable/checks (or equivalent policy gates shared with merge) and, when the candidate is no longer eligible for a non-terminal reason, records a clear reason and **stops** the remaining queue (fail-stop) rather than continuing to later items.
- [ ] When a candidate is already merged or closed (already-done), drive records it as skipped and continues to the next candidate.
- [ ] On `mergePr` failure (conflict, required check fail, merge API error), drive stops, does not attempt further candidates, and reports which items merged, skipped, and failed.
- [ ] No `auto_merge` config key is introduced; no advance-loop path calls drive or `mergePr`.
- [ ] Unit tests with injected merge/check/selection deps prove single-flight order, apply gating, revalidation stop, and already-done skip; tests make no real network/git/subprocess calls.
- [ ] `npm run ci` passes; `plugin/` regenerated in the same change if `core/` is modified.
