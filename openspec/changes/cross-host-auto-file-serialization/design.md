# Design — cross-host auto-file serialization

## Context

`autoFilePapercuts` (`core/scripts/stages/papercut.ts`) runs its dedup lookup, rate-cap
calculation, and issue creation inside `deps.withLock(opts.domain, …)`. `withLock` is a `/tmp`
PID lock (`lock.ts`), the same primitive as the domain/advance lock. It is atomic **within one
host's filesystem** and provides zero mutual exclusion between processes on different machines.
Under the single-operator factory (v1.15.0) this has never bitten in practice, but it is a real
correctness gap that #421's reviewer flagged (`582c19e6`).

The full remedy the finding gestures at — a GitHub-native mutex applied uniformly to every lock
site — is out of scope for #459 and unnecessary for the factory's actual concurrency model. The
scope here is the **auto-file path specifically**, whose cross-host failure is uniquely harmful:
it produces a *persistent, irreversible artifact* (a GitHub issue) visible to humans, unlike the
other lock sites which guard ephemeral host-local resources.

## Decision

**Use GitHub as the cross-host source of truth for the auto-file path; formally scope the rest as
single-host.**

This splits #459's acceptance criteria across its two allowed branches deliberately:

- **AC1 (the auto-file path) → the stronger "cross-host safe" branch.** The auto-file path already
  reads and writes GitHub, so GitHub *is* an available cross-host coordination medium — no new
  service required. We lean on it directly instead of on the host-local `/tmp` lock.
- **AC1 for the rest of the engine + AC2 → the "declared, enforced-scope" branch.** The advance
  lock, queue lock, and live-planning marker guard host-local state; we assess and document them
  as single-host scope rather than rewrite the engine's concurrency model.

### Part A — GitHub-truth auto-file (two mechanisms)

`withLock` is retained unchanged as the intra-host fast path (it still prevents same-host double
files cheaply and avoids redundant gh calls). On top of it:

1. **Cap derived from GitHub state per create.** Today `filedInWindow` is computed once from a
   single up-front `listOpenImproveIssues()` snapshot and `remaining` is decremented locally. Two
   hosts each start from an empty snapshot and each file up to the full cap → up to `2×cap`. The
   fix recomputes the in-window auto-filed count from GitHub-authored issue state
   at/immediately-before each create, so once host A's issue exists, host B counts it and stops at
   the cap. Because both hosts observe the same GitHub-authored `createdAt`/labels, the count
   converges.

2. **Post-create read-back reconciliation.** A residual TOCTOU window remains: both hosts can pass
   the pre-create title/cap check simultaneously and both create. After each create the path
   re-lists improve issues; if the just-filed title now maps to more than one **open** issue, it
   keeps the lowest-numbered issue (deterministic, host-independent tiebreak — both hosts pick the
   same survivor) and closes the rest with a short comment referencing the survivor. This makes
   dedup **eventually consistent to exactly one open issue per cluster** even when the create race
   is lost, and it retroactively corrects any transient cap overshoot (the closed duplicates no
   longer count as open auto-filed issues).

Both mechanisms sit inside the existing outer `try/catch` that swallows all failures — a failing
list/close call logs a non-fatal warning and leaves the (at worst) duplicate for the next
trigger to reconcile. The `AutoFileDeps` seam gains a `closeIssue(number, comment)` operation so
tests drive reconciliation with no real gh.

### Part B — scope declaration + assessment of the other locks

| Lock site | Guards | Cross-host failure mode | Disposition |
|---|---|---|---|
| Advance lock (`withLock(cfg.domain, …)`, `pipeline-run.ts`) | One host's worktrees, run-state dir, in-flight dispatch for an issue | Two hosts advance the same issue → each in its own worktree; GitHub label transitions are last-writer-wins, not corrupting | Single-host scope; documented |
| Queue batch serialization | One host's queue/run-state | Two hosts run overlapping batches on their own machines | Single-host scope; documented |
| Live-planning marker (`/tmp/pipeline-planning-*`) | One host's planning worktree for a repo+issue | Two hosts plan the same issue concurrently on separate checkouts | Single-host scope; documented |

None of these produce a persistent irreversible shared artifact the way auto-file does, so the
single-operator model tolerates them. This change **records the assessment** and declares
single-host as the supported concurrency scope in project docs; extending GitHub-native
coordination to them is deferred architectural work, tracked separately.

## Alternatives considered

- **Full GitHub-native mutex (lease issue/label) for every lock site.** Rejected for #459: large
  architectural change, adds gh round-trips to the hot advance path, and is unneeded for the
  single-operator factory. This is exactly the deferred work the #421 finding named.
- **Unique-title enforcement via a reserved marker before create.** Rejected: creating and later
  cleaning up reservation artifacts pollutes the issue tracker and adds a second race
  (reservation cleanup). Read-back reconciliation achieves the same convergence without junk.
- **Advisory-lock only (declare single-host, add a startup warning).** Rejected for the auto-file
  path: it leaves the irreversible-duplicate failure unaddressed. Accepted (documentation form)
  for the host-local lock sites, where the failure is benign.

## Risks

- Extra gh calls per create (re-list for cap + read-back). Auto-file is rare and the engine
  prizes rigor over latency; acceptable. The intra-host `withLock` still collapses same-host
  bursts to one critical section.
- Read-back close is itself best-effort; a failed close can leave a transient duplicate. Bounded
  by the next trigger reconciling it, and never fails the run — an acceptable convergence delay,
  not a correctness loss.
