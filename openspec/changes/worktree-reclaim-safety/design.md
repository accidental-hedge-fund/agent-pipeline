## Context

Two removal paths exist in `core/scripts/worktree.ts` with asymmetric safety:

| Path | Entry | Dirty / local-only gates | Mutation |
| --- | --- | --- | --- |
| Operator remove | `removeWorktreeForIssue` (`pipeline N --remove-worktree`) | Yes — dirty blocks without `--force`; local-only tiers (`true` / `"unverifiable"` / `null`) as documented | Then `realRemoveWorktreeOp` |
| Create reclaim | `createWorktree` loop over same-issue active records + optional path collision | **None** | Always `removeWorktree` → `worktree remove --force` + `branch -D` (`ignoreFailure: true`) |

Reclaim runs on every create for that issue when any of its managed worktrees are still listed as active (retry after block, title→slug change leaving a prior path, multi-stale accumulation). Operators and harnesses leave recoverable work in those trees; silent force-delete is the blast radius #622 names.

`worktree-per-run-removal` and `worktree-stale-cleanup` already require fail-closed behavior for dirty / local-only work. Create reclaim is the remaining gap on the managed lifecycle path.

## Goals / Non-Goals

**Goals:**

- Reclaim never silently destroys dirty or local-only recoverable work.
- Reclaim safety is the **same ladder** as operator remove (shared implementation preferred) so the two cannot drift.
- Clean self-reclaim continues to work so capacity, retry, and slug-change create paths remain viable.
- Clear errors name the condition (dirty vs local-only vs verification failure) and leave the worktree intact.
- Unit-test regressions that would have caught #622.

**Non-Goals:**

- Multi-host lock doctrine / PID mutex changes.
- Eval `createWorktreeAt` isolation (separate; unique paths, no issue reclaim).
- Changing operator `--remove-worktree` / `--force` semantics or JSON result shape.
- Changing sweep (`worktree-stale-cleanup`) or terminal `deploy_ready` / `auto_recover` removals beyond ensuring they do not regress if they share a primitive.
- Adding a create-time force flag or auto-salvage-on-reclaim (salvage remains the harness post-exit path).
- Relocating worktrees or changing managed-root discovery (`managed-worktree-resolution` stays as-is).

## Decisions

### Decision 1: Fail closed on reclaim — no create-time force discard

When reclaim detects dirty state or a blocking local-only result, `createWorktree` SHALL throw (or otherwise abort) **without** calling the destructive remove primitive. There is no implicit `--force` for reclaim.

Rationale: Reclaim is automatic; the operator did not consent to discard. Operator discard remains available via `pipeline N --remove-worktree --force` (still blocked for definitive local-only commits and hard verification failure, per existing tiers).

**Rejected:** Always force-remove (status quo). **Rejected:** Auto-salvage then remove on reclaim (scope creep; salvage is harness-exit scoped; dirty work may be intentional WIP).

### Decision 2: Share the operator safety ladder, do not fork a weaker copy

Extract (or call into) a shared **pre-remove safety check** used by:

1. `removeWorktreeForIssue` (existing tiers + optional `force` for dirty / `"unverifiable"`), and
2. create reclaim (equivalent to operator remove **without** force — dirty and non-clean local-only always refuse).

Shared pieces already exist: `hasDirtyWorkdir` / `isDirtyResult`, `checkLocalOnlyCommits` (via `hasLocalOnlyCommits` dep). The missing piece is applying them on the reclaim path before `removeWorktree`.

Preferred shape (implementation may adjust naming):

- A pure-ish helper, e.g. `assertSafeToRemoveWorktree({ pathOnDisk, dirty, localOnly, force }) → { ok: true } | { ok: false; error: string }`, encoding the tier table once.
- Reclaim always passes `force: false`.
- Operator remove keeps current `opts.force` behavior.

**Rejected:** Only checking dirty on reclaim and ignoring local-only (issue explicitly names both). **Rejected:** Routing reclaim through full `removeWorktreeForIssue` CLI result plumbing (JSON exit codes, cross-checkout marker adopt messaging) — reclaim already has managed candidates from `listActive`; reuse the **safety policy**, not necessarily the whole operator façade. Cross-checkout ownership marker rules for operator remove stay on that path; reclaim only targets issue-owned managed records it already classifies (including `underManagedRoot === false` skip).

### Decision 3: Apply gates to every reclaim candidate, including path-collision cleanup

Both reclaim sites in `createWorktree` need gates:

1. Loop over same-issue active managed records (`mine`).
2. Collision cleanup when `existsFn(wtPath)` and the path was not already handled as a `mine` record.

For (2), if the path is not a git worktree (orphan directory), dirty/local-only checks may be non-applicable; fail-closed rules for non-zero `git status` already treat errors as dirty. If the directory exists but is not a worktree, the design allows removal only when there is no evidence of recoverable git work (implementation: treat non-repo / status failure as unsafe unless the path is clearly empty/non-git and documented — prefer fail-closed: if status cannot prove clean, refuse or use existing force-remove only for empty non-git dirs if tests already assume that). **Default: fail closed when status is non-clean or unverifiable.**

### Decision 4: Local-only tier table (reclaim = no force)

Mirror operator remove without force:

| `hasLocalOnlyCommits` | Reclaim |
| --- | --- |
| `false` | Proceed (if not dirty) |
| `true` | Refuse — unpushed commits |
| `"unverifiable"` | Refuse — same as operator without `--force` |
| `null` (hard failure) | Refuse — verification failed |

Dirty + not force → refuse (reclaim never forces).

Order: keep local-only evaluation before dirty early-return in the shared ladder so dirty state does not hide unpushed commits (matches `removeWorktreeForIssue` comments today).

### Decision 5: Inject deps on create for testability

Extend `CreateWorktreeDeps` with the same injectables used for safety (`hasDirtyWorkdir`, `hasLocalOnlyCommits`, and/or a single `assertSafeToRemove` seam) so unit tests prove refusal without real git. Existing `removeWorktree` dep remains for the mutation after gates pass.

### Decision 6: Error surface

Errors thrown from reclaim MUST:

- Name the issue number and candidate path (and/or branch).
- Distinguish dirty vs local-only vs verification failure in the message text (reuse operator phrasing where practical).
- Leave the worktree and branch unmodified.

Callers already treat `createWorktree` throw as setup failure / block; no new stage machine required.

## Risks / Trade-offs

- **[Risk] Stuck capacity when an abandoned dirty worktree blocks self-reclaim** → Mitigation: error message points operators at `pipeline N --remove-worktree` (and `--force` when appropriate); intentional — recoverable work beats silent discard. Capacity counts other issues only after reclaim of *mine*; if mine cannot reclaim, create fails early rather than deadlocking other slots incorrectly.
- **[Risk] Shared helper refactor regresses operator remove** → Mitigation: keep existing `worktree-remove.test.ts` suite green; extract policy without changing tier outcomes; prove bite tests for reclaim only.
- **[Risk] Orphan non-git directories at target path** → Mitigation: fail closed on unverifiable status; document in tasks if empty-dir special case is needed for create bootstrap.
- **[Trade-off] Slightly more create latency** (status + rev-list / remote checks per candidate) → Acceptable; same cost as operator remove; reclaim candidates are few (same issue only).

## Migration Plan

- Pure behavior fix on next engine release; no config keys, no schema migration.
- Existing dirty/local-only worktrees stop vanishing on re-run; operators may need one explicit remove after they intentionally discard.
- Rollback: revert the shared gate wiring (not recommended).

## Open Questions

- None blocking. Optional follow-up (out of scope): whether `auto_recover` / `deploy_ready` low-level `removeWorktree` should also call the safety ladder for defense in depth; not required for #622 acceptance.
