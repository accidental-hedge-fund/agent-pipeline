## Why

The review fix↔review loop oscillates to the round ceiling before parking at `needs-human` even when the same blocking finding re-appears unchanged after a fix round — a proven non-convergence signal that a human is needed *now*, not after consuming more budget. Observed on #85: 3 extra round-trips ran before parking, and the operator's first question was always "which of these survived a fix attempt?" — a question the pipeline has enough information to answer for free via the existing content-addressed `findingKey`.

## What Changes

- **Early park on recurrence.** When a re-review after a fix round emits a blocking finding whose `findingKey` matches a blocking finding from the immediately-prior round, the pipeline SHALL immediately transition to `needs-human` without consuming the remaining `max_adversarial_rounds` budget. A finding whose severity or title changed carries a different key and is treated as new (no early park).
- **RECURRING / NEW tags on the hand-off punch-list.** The ceiling/needs-human punch-list posted by `reviewCeilingComment` SHALL tag each finding `RECURRING (n rounds)` when its `findingKey` appears in a prior Review-N comment, and `NEW` otherwise — derived by set-membership against the prior Review-N comment bodies the pipeline already reads. The `needsHumanPunchlist` helper used by `--status` gains the same tagging.
- **Pure deterministic implementation.** Both mechanisms compare controlled string sets; zero model calls, zero network calls beyond what the loop already performs.

## Capabilities

### New Capabilities
- `review-loop-recurrence`: Recurrence-aware convergence for the fix↔review loop — early park at `needs-human` when a blocking finding repeats unchanged after a fix round, plus RECURRING/NEW tagging on the needs-human punch-list.

### Modified Capabilities
- `needs-human-status-surface`: The `needsHumanPunchlist` helper and its `--status` output gain per-finding RECURRING/NEW tags derived from prior Review-N comment set-membership.

## Impact

- `core/scripts/stages/review.ts`: `reviewCeilingComment` gains per-finding tags; `advanceReview` gains a recurrence check before routing to a fix stage.
- `core/scripts/review-policy.ts` (or a new helper): `extractBlockingKeysFromPriorRound` — a pure function scanning existing Review-N comments for blocking `findingKey` values.
- `core/scripts/stages/pre_merge.ts` / `needs-human` status helper: `needsHumanPunchlist` gains the same RECURRING/NEW tagging.
- No state-machine edges added or removed; no config/CLI/schema changes.
