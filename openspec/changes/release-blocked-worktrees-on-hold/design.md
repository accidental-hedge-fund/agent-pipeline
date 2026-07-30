## Context

`createWorktree` gates concurrency with:

```text
otherActive = listActive().filter(r => r.issueNumber !== current).length
if (otherActive >= max_concurrent_worktrees) throw capacity error
```

`listActive` treats every on-disk managed worktree as active when the GitHub issue is **open** and not labeled `pipeline:ready-to-deploy`. Parked / blocked issues still have open issues and non-terminal stage labels, so their worktrees occupy slots indefinitely until merge-path cleanup or manual remove.

Durable loop behavior after a hold is intentionally to continue with other schedulable items (`loop-blocked-item-hold-continuation`). That is correct for *human* product holds — but when capacity is full of parked trees, every next dispatch dies in planning create and becomes another false human hold. That is the cascade observed on #673–#675.

Related existing surfaces:

| Surface | Relevance |
| --- | --- |
| `worktree-lifecycle` | Capacity gate + same-issue reclaim before capacity check |
| `worktree-per-run-removal` | Safe remove ladder (dirty / local-only) — park-release must reuse |
| `worktree-stale-cleanup` | Merge-only sweep; does **not** free open blocked PRs |
| `blocked-recovery-recipes` | `BlockerKind` closed set + recipes; capacity today is poorly kinded |
| `loop-needs-human-blocker-disposition` | Holds continue the run; must not absorb pure capacity as product judgment |

## Goals / Non-Goals

**Goals:**

- Free capacity when items durable-park so other dependency-ready items can start (Policy A).
- Never discard dirty or unpushed work on automatic park-release.
- Recreate worktrees on resume with existing create/reclaim safety.
- Stop classifying pure capacity failures as product needs-human; avoid per-item cascade of human holds when the real barrier is admission capacity.
- Preserve same-issue reclaim and “does not count against itself”.
- Document the operator-visible capacity policy.

**Non-Goals:**

- Raising `max_concurrent_worktrees` as the sole fix.
- Policy B (exclude blocked from capacity count while retaining trees) as the primary fix — rejected for this change in favor of release-on-park (see Decision 1).
- Fixing #712 ledger `pr_opened` stranding, #714 OpenSpec, #716 docs:check.
- Teaching `pipeline:cleanup` to remove open blocked-PR worktrees.
- Multi-host worktree locks; out-of-managed-root developer checkouts.
- Auto-merge or any merge-path change.

## Decisions

### Decision 1: Primary policy is A — release on durable park, not B or C alone

**Chosen:** When an issue reaches a durable non-transient park/hold (blocked / needs-human wait where advance will not continue harness work in that worktree), attempt to **release** the managed worktree if safe.

**Why not B (exclude parked from count while retaining trees):** Retained trees still consume disk, confuse operators (`pipeline:cleanup` does not help), and dual-count semantics (active-for-capacity vs on-disk) drift easily. Release matches the physical resource model: slots = on-disk active worktrees for open non-terminal issues.

**Why not C alone (loop stops at capacity without cascading blocks):** Necessary as a *residual* behavior when true-active work fills the cap, but alone it leaves parked trees stranded forever and never recovers capacity without human cleanup. C is the safety net for residual full capacity, not the primary fix for the leak.

**Park triggers (normative intent):** Any terminal-for-this-advance outcome that parks the issue awaiting human or external progress without further harness execution in the worktree — including `blocked_needs_human`, durable needs-human holds, and non-auto-recoverable blocked kinds where the engine will not immediately re-enter the worktree. Transient in-process waits that will resume in the same process without a durable park MUST NOT release (implementation maps concrete outcome enums once at coding time; tests pin the park set).

### Decision 2: Safety preconditions for automatic release (fail closed)

Automatic park-release MAY remove a managed worktree only when **all** hold:

1. Path is under a managed root (`underManagedRoot !== false`).
2. Working tree is clean (same dirty definition as operator remove / reclaim).
3. No local-only commits (same tier table: `true` / `"unverifiable"` / `null` refuse).
4. Branch tip is present on the remote **or** an open PR exists for that head branch (so work is recoverable from origin without the local worktree).

Otherwise: **retain** the worktree; log / surface the retain reason; do not force-delete.

Reuse the shared remove safety ladder from `worktree-per-run-removal` / create reclaim (#622). Prefer a shared helper (e.g. `releaseWorktreeForParkedIssue`) rather than a third forked safety copy.

Remote branch and open PR are **never** deleted by park-release. Local branch deletion follows the same policy as other safe removes (local branch only; compare-and-delete / non-force remove as reclaim uses).

### Decision 3: Capacity error is a first-class ops disposition, not product needs-human

Today capacity throws a generic `Error` from `createWorktree`; planning/bootstrap often lands in blocked / needs-human style offramps. That produced #673–#675 “answer the human” semantics for a pure resource wait.

**Chosen:**

- Capacity failures are **machine-distinguishable** (stable error identity / typed kind, e.g. `worktree-capacity` or equivalent `BlockerKind` member — exact name chosen at implement time and locked by tests).
- Disposition text and recipes say: wait for a slot, free retained unsafe parks manually if needed, or let parked-release free slots — **not** “override findings” / product judgment.
- Durable loop: pure capacity MUST NOT cascade as sequential per-item product needs-human holds on every remaining pending item. Prefer:
  - After park-release, create succeeds for the next item; or
  - If residual true-active capacity is full, **stop admitting** further new starts for this cycle/run with a clear capacity reason (`worktree_capacity` / admission hold) without labeling every leftover pending item as product-blocked.

Existing genuine product needs-human paths are unchanged.

### Decision 4: Resume recreates; same-issue reclaim preserved

On re-advance after release, planning calls `createWorktree` as today. Same-issue reclaim runs before the capacity check and excludes self from `otherActive`. No special “resume without create” path is required if remote branch exists: create branches from base as usual unless existing resume/bootstrap already reattaches to a remote head (implementation MUST follow existing planning bootstrap; do not invent a second branch model). If planning already has attach-to-existing-remote behavior, park-release MUST remain compatible with it.

### Decision 5: Where release is invoked

Prefer a **single post-park hook** near the durable outcome sink (advance result → blocked/needs-human/hold) rather than sprinkling remove calls across every stage file. Stages remain free of capacity bookkeeping; the lifecycle owner releases once per durable park. Unit tests inject the release seam.

### Decision 6: Docs as part of done

Operator docs (README and/or loop section) MUST state:

- What counts toward `max_concurrent_worktrees` (on-disk managed worktrees for open, non-ready-to-deploy issues).
- Park-release preconditions and retain cases.
- Capacity disposition vs product needs-human.
- Recovery: parked-release automatic when safe; unsafe retain may need `pipeline N --remove-worktree` after push/commit; `pipeline:cleanup` is merge-only.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Releasing too early while a harness still needs the tree | Only release on durable park outcomes after harness exit; never mid-stage. Tests pin the outcome set. |
| Silent data loss on dirty park | Fail-closed retain; shared dirty/local-only gates; no force on automatic path. |
| Resume cost: recreate + install | Acceptable vs factory deadlock; same cost as first start. |
| Residual full capacity of true-active work | Decision 3 admission hold — no cascade human blocks; operators raise cap or wait for completes. |
| Double-remove races with operator cleanup | Idempotent release (missing worktree = success); reuse existing remove seams. |
| Policy B fans want exclude-from-count | Documented rejection; release is the resource truth. Can revisit later if recreate cost dominates. |

## Migration Plan

- No data migration. Behavior change is forward-looking on park and create.
- Existing parked issues with retained worktrees: next durable re-evaluation or a subsequent park path may release them; operators can still manual-remove. Optional one-shot “release safe parked trees” is **not** required for v1 of this change (document manual recovery).
- Rollback: revert the change; capacity cascade returns (no destructive schema).

## Open Questions

- Exact enum membership for capacity kind vs reusing/extending `worktree-creation-failed` — prefer a distinct capacity kind so recipes and metrics stay clean; finalize at implementation with `blocked-recovery-recipes` snapshot tests.
- Whether durable-loop ledger should record an explicit `worktree_released` event for scoreboard/FRG — useful for #723 capacity scenario pack; implement if a cheap additive event path already exists, otherwise log-only for v1.
