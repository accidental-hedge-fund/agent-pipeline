## Context

The fix↔review loop in `advanceReview` (review.ts) currently iterates until `max_adversarial_rounds` is exhausted, then parks at `needs-human`. Each blocking finding is already identified by a stable content-addressed key — `findingKey` (`sha1(severity|file|title).slice(0,8)`) — which is already embedded in every review comment as `` `override-key: <key>` `` per finding, and in ceiling punch-list items as `` `<key>` `` at line start. These controlled markers are already parsed back by the pipeline for `--override` resolution.

The recurrence signal — "this exact finding survived a fix attempt" — is 100% derivable from controlled strings the pipeline itself emits. No model judgment or extra network calls are required beyond the `detail.comments` already fetched at loop start.

## Goals / Non-Goals

**Goals:**
- Park at `needs-human` on the first round where a blocking finding's key matches a blocking key from the immediately-prior review round (after a fix landed), without consuming remaining budget.
- Tag each finding in the ceiling/needs-human punch-list as `RECURRING (n rounds)` or `NEW` based on set-membership of its `findingKey` against all prior Review-N comment bodies.
- Zero new authority — `needs-human` is never auto-advanced; humans still own the disposition.

**Non-Goals:**
- Changing `max_adversarial_rounds` or removing the ceiling path (recurrence just ends earlier within it).
- Cross-round recurrence beyond "immediately-prior round" for the early-park trigger (that's the decisive signal; multi-round history is used only for the `n` count in the tag).
- Any model call, inference, or prose matching.

## Decisions

### Decision 1: Extract blocking keys from the immediately-prior Review-N comment only for the early-park trigger

**Chosen**: Compare current blocking keys against the set extracted from the most recent prior `## Review {round}` comment (not all prior rounds).

**Rationale**: "The same finding survived a fix round" requires exactly one prior-round comparison. Using all prior rounds for the early-park trigger would be over-aggressive: a finding that was dropped in round 2 but reappears in round 4 might have been re-introduced by a new change, not a failed fix. Recurrence of the immediately-prior round is unambiguous.

**Alternative considered**: Compare against ALL prior rounds. Rejected — a finding re-appearing after absence could be newly introduced, not a fix failure.

### Decision 2: Extract blocking keys by parsing the existing `` `override-key: <key>` `` pattern in review comment bodies

**Chosen**: A pure regex over the comment body string to collect 8-character hex keys from `` `override-key: <hex8>` `` tokens.

**Rationale**: The format is a controlled pipeline output — the pipeline both writes and reads it for `--override` resolution. Parsing it is a total function with no ambiguity. No new sentinel needed.

**Alternative considered**: Add a machine-readable `<!-- blocking-keys: ... -->` sentinel in the review comment. Rejected — the override-key text already serves as the structured marker; a new sentinel would duplicate it and require a comment-format change.

### Decision 3: RECURRING (n) count scans ALL prior Review-N comments, not just the immediately-prior

**Chosen**: For the tag, count how many prior Review-N comment bodies contain `` `override-key: <key>` `` for the finding's key.

**Rationale**: The tag is informational — operators want to know "how many rounds has this persisted?" One immediate-prior match triggers the early park; the count across all prior rounds answers "how long has this been stuck?" These are different uses of the same data.

### Decision 4: New pure helper `extractBlockingKeysFromComment(body: string): Set<string>`

**Chosen**: A single exported pure function, co-located in `review.ts`, regex-scanning the body for override-key tokens.

**Rationale**: Keeps the logic next to the other `extract*` helpers (`extractReviewedSha`, `extractReview1Summary`, `extractReview2Findings`). The same helper is reused for both the early-park key comparison and the RECURRING count scan.

### Decision 5: Recurrence check runs BEFORE the ceiling check

**Chosen**: In `advanceReview`, insert the recurrence check between the advisory-advance path and the ceiling check, so a recurring finding parks without consuming the ceiling count.

**Rationale**: The ceiling check (`priorRounds + 1 >= roundCap`) is the absolute backstop; recurrence is an earlier, tighter signal. Ordering: zero-findings re-review → advisory advance → **recurrence check** → ceiling → fix-stage route.

## Risks / Trade-offs

- [False key collision] Two semantically different findings could share an 8-char sha1 prefix. Probability is negligible (~1/16M per pair) and the consequence is conservative — an early park, not a false advance. Accepted.
- [Corpus dependency] The recurrence check depends on well-formed pipeline-emitted review comments being present in `detail.comments`. A truncated or externally-edited comment could cause a missed recurrence signal (loop continues to ceiling). Consequence is the current behavior, so it degrades gracefully.
- [Spec: "immediately-prior round" requires round ordering] `detail.comments` is returned in creation-ascending order. The helper must take the last Review-N comment before the current comment. This is the same ordering the existing `countPriorRounds` and `extractReview2Findings` helpers rely on — no new assumption.

## Migration Plan

Pure additive: no state-machine edges change, no config keys added, no schema change. The new check runs transparently within the existing loop. No migration required; a pipeline run started before the change completes as if no check existed (no prior Review-N comment → empty key set → no recurrence detected).
