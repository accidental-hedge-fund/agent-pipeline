## Context

The pre-merge delta review (#228) already runs an adversarial round-2-equivalent review of the
unreviewed commits when the SHA gate detects the diff moved. On blocking findings it calls
`setBlocked(..., "needs-human")` and stops (`core/scripts/stages/pre_merge.ts` ~L1138–1150). Every
autonomous run that trips this branch requires a human to apply an often-mechanical fix.

This change interposes a bounded auto-fix between the blocking partition and the `setBlocked` call,
modeled directly on the sibling `performBoundedSpecRepair` (#356) already living in this file for
`spec-divergence` findings.

## Goals / Non-Goals

**Goals**
- Auto-resolve the mechanically-fixable subset of pre-merge blockers (`correctness`, `missing-dep`)
  without human judgment, then re-review once.
- Preserve every safety property: rigor (same adversarial delta review re-runs), surgical-fix
  discipline (#235), and the review-SHA gate's developer-vs-internal classification.
- Stay strictly bounded — at most one auto-fix attempt per pre-merge entry, crash-safe.

**Non-Goals**
- Auto-fixing `security` findings (always escalate).
- More than one attempt per entry.
- Auto-fixing when there is no prior verdict (the SHA gate skips the delta review on the first
  pre-merge entry).
- Any change to `isPipelineInternalCommit`'s classification of OpenSpec archive commits.
- Introducing an `auto_merge` path — pre-merge still stops at `ready-to-deploy`; the fix round only
  removes the *manual-fix* toil, not the human merge gate.

## Key Decisions

### 1. Category allowlist, fail-closed on unknown/absent

`ReviewFinding.category` is a free-text optional string. `review-schema.ts` only hints
`spec-divergence | correctness | security | ...`; the issue's `missing-dep`,
`product-judgment-required`, and `scope` categories are **not** formalized in the schema today.

Decision: gate on an **allowlist** `{ correctness, missing-dep }`, and treat *every* other value —
`security`, `scope`, `product-judgment-required`, `spec-divergence`, an unrecognized token, and an
absent/empty category — as **not** auto-fixable. Eligibility requires that *all* blocking findings
are in the allowlist; a single non-allowlisted finding escalates the whole entry.

Rationale: auto-fix must act only on positive signal. An absent/unknown category is exactly the case
where the reviewer did not assert the finding is a mechanical correctness fix, so escalating is the
safe reading — and it keeps the feature safe even though the reviewer does not yet reliably emit the
full taxonomy. (Conflict surfaced per repo convention: the acceptance criteria name categories the
schema doesn't formalize; the allowlist + fail-closed default resolves it without expanding scope.
A follow-up may extend the `review-schema.ts` category hint and reviewer prompt to emit
`missing-dep` / `product-judgment-required` / `scope` explicitly — tracked separately, out of scope
here.)

### 2. Dual commit classification: developer for the SHA gate, recognizable for the bound

The auto-fix commit must satisfy two apparently-opposing needs:
- **Re-review it.** The review-SHA gate re-reviews only *developer* commits.
  `isPipelineInternalCommit` returns `true` only for the OpenSpec-archive prefix, so a normal fix
  commit is already developer-classified — do **not** change that function.
- **Bound to one attempt.** The stage must recognize "an auto-fix was already tried for this entry"
  even across a process restart.

Decision: the auto-fix commit uses a stable, documented subject prefix (e.g.
`fix: pre-merge auto-fix …`) and the run's `Issue:`/`Pipeline-Run:` trailers. The one-attempt bound
scans the developer commits since the last reviewed SHA for that prefix; if present, it escalates to
`needs-human` without a second attempt. The prefix MUST NOT be added to `isPipelineInternalCommit`'s
internal set (that would suppress the required re-review). This keeps the bound crash-safe: the
commit *is* the durable marker, so a poll that re-enters after a crash sees it and stops.

### 3. Reuse the surgical-fix prompt and the DI-seam pattern

The attempt calls `buildFixPrompt` (the same prompt the fix-1/fix-2 rounds use, carrying the #235
minimal-diff / destructive-op-guard / self-check discipline) with the blocking delta findings as
`reviewFindings`, run from the issue worktree via the implementer harness. Production wires an
injectable closure (default when `cfg.harnesses.implementer` is set) exactly like `attemptBoundedRepair`
→ `performBoundedSpecRepair`; tests inject a fake `invoke`/git seam so no real harness, git, or
network runs. Pre-fix cleanliness is required (fail-closed if the worktree is dirty), and any failure
rolls back to the pre-fix HEAD over a clean tree — mirroring `performBoundedSpecRepair`'s rollback.

### 4. Re-review inline, once, off the ceiling

After the auto-fix commit lands and is pushed, the stage re-runs the delta review once against the
new head, posting a delta-review comment with fresh `reviewed-sha` / `verdict-diff-hash` sentinels
(so the next poll sees a matching diff hash and reuses the verdict). The re-review does **not**
increment `max_adversarial_rounds`, consistent with the existing rule that pre-merge delta reviews
never consume a review-2 ceiling slot.

## Risks / Trade-offs

- **Reviewer mis-categorizes a judgment call as `correctness`.** Mitigated by: (a) the auto-fix is
  itself re-reviewed adversarially (rigor preserved); (b) the surgical-fix self-check withholds a fix
  that raises severity; (c) the strict one-attempt bound caps blast radius; (d) `security` is never
  in the allowlist.
- **Auto-fix loops.** Prevented by the crash-safe one-attempt marker — a second blocking round always
  escalates to `needs-human`.
- **Partial push on crash mid-fix.** Prevented by pre-fix cleanliness + rollback-to-HEAD on any
  failure; only a complete, committed fix is pushed.

## Migration

None. Purely additive behavior on a branch that previously always blocked; no config key added, no
schema field required (the allowlist reads the existing optional `category`). Runs that never trip a
delta-review block are unaffected.
