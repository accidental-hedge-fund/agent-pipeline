## Context

`enforceReviewShaGate` (`core/scripts/stages/pre_merge.ts`) runs at most one delta review per pre-merge entry (plus at most one post-auto-fix re-review, #359). Rounds therefore accumulate *across pipeline invocations*: block → fix/override → re-enter pre-merge → another delta round. Nothing counts them.

Two independent guards already exist and both were bypassed on fuseiq-core#95:

- `review_policy.max_adversarial_rounds` + `ceiling_action` (#233) — bounds review-2 rounds, and the `pre-merge-delta-recheck` spec explicitly exempts delta rounds from that budget.
- The settled-finding reversal guard (#389 → narrowed to per-finding by #464) — demotes a blocking finding only when `matchSettledFinding` reports it re-raises a *specific* settled entry via surface identity **and** (key equality OR title similarity ≥ threshold).

Round 5's findings had fresh keys and re-worded titles, so `matchSettledFinding` correctly reported no match. The narrowing in #464 was deliberate and correct (surface identity alone caused mis-fires); the gap is not the matcher's precision but that the digest records **what was found**, never **what was ruled out**.

## Goals / Non-Goals

**Goals**
- Bound delta rounds per item, durably and crash-safely.
- Make an operator OVERRIDE settle a trade-off as bindingly as a fix does, including the design alternatives it ruled out.
- Detect the specific escape observed: same axis, new keys, re-framed title, declining confidence, recommendation reinstating a rejected design.

**Non-Goals**
- Relaxing review rigor. Every mechanism here either bounds a loop that was already unbounded or demotes a *re-litigation* — never a first-raise finding.
- Changing review-1/review-2 policy, the fix-outcome path (#473), or the no-auto-merge invariant.
- Widening `matchSettledFinding` back toward surface-only matching (it caused the #464 mis-fires).

## Decisions

### Decision 1 — Count delta rounds from the comment thread, not run state

Delta rounds are counted by matching `DELTA_REVIEW_MARKER_PREFIX` (`## Pre-merge Delta Review`) comments authored by the trusted pipeline actor on the issue. This mirrors `review-cross-round-memory` Decision 1: the comment thread is the only substrate that survives a crashed run, a re-run from a fresh clone, or a host switch, and the counting stays a pure function of `comments` (unit-testable with no I/O).

*Alternative rejected:* a counter in the run directory. It resets on every fresh run — exactly the situation where a loop has already been running for hours.

*Consequence:* pre-existing PRs carry historical delta comments, so enabling a cap can retroactively place an in-flight item at its ceiling. That is the intended behavior (the item is, in fact, already over budget); the ceiling comment states the observed count so an operator can override with a documented rationale.

### Decision 2 — Default `max_delta_rounds: 4`, chosen from the evidence

On fuseiq-core#95 rounds 1–4 each produced a genuine defect; round 5 was the churn round. A cap of 4 would have preserved every valuable round and stopped the loop exactly where it went bad. A lower default risks truncating real convergence (golden rule 3: no rigor-for-latency trades); a higher one does not bind on the only case we have. Non-positive values are rejected by the schema; there is deliberately **no** "unbounded" sentinel — the issue is that unbounded is the current, broken state.

### Decision 3 — Reuse `ceiling_action` rather than adding a delta-specific action

`park` / `demote_and_advance` (and the high/critical hard-park override from `review-ceiling-demote-and-advance`) already encode the operator's stated preference for what a round-budget exhaustion should do. Introducing a second knob would let the two ceilings drift apart with no benefit. The *budgets* stay independent (a delta round still must not consume review-2's ceiling); only the *action* is shared.

### Decision 4 — Record rejected alternatives, not just findings

The digest today answers "what did prior rounds find?". It cannot answer "what design did a prior round require removed?", which is the question round 5 needed to be checked against. So the reviewer verdict schema gains an optional per-finding `rejected_alternatives: string[]`, populated when the recommendation requires removing or replacing an existing design. Those strings ride the durable `blockingFindings` artifact extension into `DigestEntry.rejectedAlternatives`.

A new pure matcher `matchSettledAlternative(finding, settledFindings)` compares the *new finding's `recommendation`* against each settled entry's rejected alternatives using the same normalized-token similarity machinery already used for titles (stopwords + suffix stripping + exported threshold constant), and requires the finding's `surfaceKey` to be non-null and equal to the settled entry's surface. `partitionFindings` demotes a match lacking `prior_round_acknowledgment` with reason `settled-alternative-reinstated`.

This is deliberately **orthogonal** to `matchSettledFinding`: that one asks "is this the same defect argued the other way?" (title/key axis); this one asks "does this recommendation put back what we took out?" (recommendation-vs-rejected-alternative axis). Neither subsumes the other, and either alone would have missed round 5.

*Alternative rejected:* an LLM-judged "does this contradict a prior decision?" step. It adds a non-deterministic model call to a guard whose whole value is that it is reproducible and testable offline.

*Degradation:* legacy comments and reviewers that omit `rejected_alternatives` yield an empty list, the matcher reports no match, and partitioning is unchanged — the guard is strictly additive.

### Decision 5 — Confidence trend is an audit signal, not a blocker

Declining confidence on a settled axis is *evidence* of churn but not proof: a reviewer can legitimately re-raise a settled axis at lower confidence when new code genuinely reopens it. So `detectSuspectedChurn(round, digest)` is pure and its output only labels the comment, emits one event, and lands in the bundle. Blocking disposition is decided by the policy and the two reversal guards, which have precise matching. This keeps the mechanism from silently unblocking a real defect (golden rule 3).

The detector requires **all** of: every blocking finding of the round sits on an axis (`surfaceKey`) all of whose digest entries are settled; every such finding carries a `confidence`; and every confidence is strictly below the prior maximum confidence on that axis. Any missing confidence, any unsettled-axis finding, or any non-decreasing confidence ⇒ no flag. Strictness here is deliberate: a noisy churn label would train operators to ignore it.

### Decision 6 — Digest carries confidence; entries degrade, never drop

`DigestEntry` gains an optional `confidence`. It is sourced from the `blockingFindings` artifact extension; the fallback ladder rungs (blocking-keys marker, surfaces marker) cannot supply it, and those entries simply carry no confidence — they are still emitted with their existing fields. The digest's character cap and truncation behavior are unchanged in kind; rendering appends confidence only when present.

## Risks / Trade-offs

- **Retroactive ceiling on in-flight PRs** (Decision 1) — mitigated by naming the observed count and cap in the ceiling comment and by the audited `--override` path.
- **Reviewer omits `rejected_alternatives`** — the guard silently does nothing. Mitigated by prompting for it explicitly in `review_adversarial.md` (drift-guarded like the other prompt disciplines) and accepted as a fail-open: a missing field must never demote a legitimate first-raise finding.
- **Similarity false positive demotes a genuine finding** — bounded by requiring surface identity, by the `prior_round_acknowledgment` escape hatch (which restores full blocking authority), and by the demotion being rendered in the comment with the settled key, alternative text, and settling round rather than silently dropped.
- **Two ceilings to reason about** — mitigated by sharing `ceiling_action` and by naming both budgets in the ceiling comment.

## Migration

Purely additive. Existing configs get `max_delta_rounds: 4`; existing PR comment threads parse unchanged; reviewers that never emit `rejected_alternatives` behave exactly as today.
