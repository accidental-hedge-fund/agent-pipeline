## Context

`enforceReviewShaGate` (`core/scripts/stages/pre_merge.ts`) resolves `head` once from
`getPrDetailFn`, and everything downstream — the delta diff range, the reviewer
invocation, the `commitSha` embedded in the delta comment, the `verdict-diff-hash`, and
the `pipeline-blocking-keys` marker — is anchored to that single read. The reviewer call
is the slow part (minutes), and the fix round pushes to the same branch, so `head` can be
superseded between the read and the recording.

Today only one branch re-validates: after the initial delta review returns **zero**
blocking findings, the stage re-reads the PR head and throws if it moved, deliberately
falling back to the conservative full re-review. The blocking branch posts the comment and
`setBlocked`s without any such check. The post-auto-fix re-review has a more careful
approve-side confirmation (API read plus `git ls-remote` disambiguation, #371) but again
only on the approving side.

## Goals / Non-Goals

Goals:
- No blocking verdict may be recorded against a SHA that is not the branch head at
  recording time.
- A superseded verdict must be visibly recorded as superseded, not silently dropped.
- The already-recorded-blockers gate must not resurrect a stale verdict as a blocker on a
  later pre-merge entry.
- Termination: a branch receiving continuous pushes must not loop.

Non-goals:
- Cancelling in-flight reviewer work, or locking the branch during review.
- Changing what counts as a pipeline-internal commit, or how findings are partitioned.

## Decisions

### D1 — Re-validate at recording time, symmetric across verdicts

The check moves from "approve path only" to "before recording any delta verdict". The
reviewed SHA is compared against a freshly read PR head immediately before the delta
comment is formatted. Rationale: the defect is in *attribution*, and attribution happens
at recording. Gating recording (rather than, say, gating the reviewer launch) closes the
whole window with one check, and keeps the blocking and approving paths from drifting
apart again — the asymmetry is exactly what produced this bug.

Alternative rejected: re-read the head only before `setBlocked`. That still posts a
comment claiming `reviewed-sha: <superseded>` with a blocking-key marker, which is the
misleading-history half of the issue and the input the later gate reads.

### D2 — Superseded verdicts are recorded without blocking authority

A superseded verdict is posted as a superseded delta-review comment naming both the
reviewed SHA and the newer head, and carrying **no** `pipeline-blocking-keys` marker and
no head-claiming `commitSha`. Rationale: the pipeline must never present a verdict as
covering code it did not read, and the marker is precisely the durable artifact that made
#427/#432 require a human. Keeping the findings text visible (as history) while stripping
blocking authority preserves audit value without gating on stale keys.

### D3 — Bounded re-review at the head, then conservative fallback

After discarding a superseded verdict, the stage re-resolves the head and re-runs the
delta review against it, up to a small fixed bound (default: one additional attempt) per
pre-merge entry. Beyond the bound it takes the existing conservative path — the same
fall-through used today when the approve-path head check fails — which re-enters the SHA
gate on the next run. Rationale: an unbounded retry on a branch under active pushes is a
livelock, and the conservative path is already the proven, converging escape hatch. The
bound is deliberately small because each attempt costs a full reviewer invocation.

Consistent with the existing rule, these re-runs do not consume a `max_adversarial_rounds`
slot — they are delta reviews, not review-2 rounds.

### D4 — Staleness is decided by PR commit order, not timestamps

"Superseded" means: the reviewed SHA appears in the PR commit list strictly before a
commit that is not pipeline-internal, or the reviewed SHA is not the current head and the
commits between differ from it by a developer/fix commit. The existing
`getPrCommitsFn` + `isPipelineInternalCommit` machinery already answers this and is the
same classification #16 uses, so the two gates cannot disagree. Timestamps and comment
ordering are not used: they are not authoritative about branch content.

If commit classification cannot be read (API failure), the stage fails **closed** to the
conservative re-review path rather than assuming currency — matching the existing `catch`
behavior in the gate.

### D5 — The blocking-keys gate consults the same staleness rule

`reuseBlockedBy`-style re-evaluation of recorded blocking keys gains a precondition: the
recorded verdict must not be stale under D4. A stale recorded verdict routes to re-review
instead of blocking. Verdicts at the head, and verdicts separated from the head only by
pipeline-internal commits, keep today's behavior exactly — which is what preserves the
#228/#229 gate-bypass protections (a no-op or archive commit still cannot launder
unresolved blockers).

## Risks / Trade-offs

- **Extra head reads.** One additional `getPrDetail` per delta verdict. Negligible next to
  a reviewer invocation, and only on the delta path.
- **A real blocking finding is deferred one round** when a push races it. Acceptable: the
  re-review at the head will re-find it if it still exists, and pre-merge cannot advance
  without a current verdict. Rigor is preserved — the change removes *stale* blocks, never
  a block that describes the head.
- **Reviewer work is discarded** when a race occurs. Accepted; the alternative is
  attributing a verdict to code it never saw.

## Migration

None. Existing recorded verdicts are read with the same extractors; a pre-change comment
whose reviewed SHA is now stale simply routes to re-review instead of blocking, which is
the desired behavior.
