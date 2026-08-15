## Context

See `proposal.md` for motivation and live instances (#693 / #1059).

Today `mergePr` in `core/scripts/stages/merge.ts` reads mergeability once via
`ghPrView`, runs pure `checkMergeability`, and throws immediately on
`mergeable === "UNKNOWN"` with operator-facing “wait a few seconds and retry”
text. Train’s serial merge wave (`mergeIssuePr` → `mergePr`) catches any throw
as:

`merge failed for #<issue> PR #<pr>: <message>`

and returns `exitCode: 1` / `status=failed` for the whole train. GitHub’s
GraphQL mergeability field is often `UNKNOWN` for a few seconds after PR
creation or base movement; a second read commonly returns `MERGEABLE`/`CLEAN`.

Constraints:

- Advance/loop never merge (unchanged).
- Train inherits merge gates only through the shared merge surface.
- Unit tests inject I/O via `MergeDeps` / train deps — no real sleep, network,
  or `gh` in tests.
- Ship-path doctrine: class-over-site for engine dogfood; do not put the retry
  only in `train.ts`.

## Goals / Non-Goals

**Goals:**

- Bounded deterministic retry of the mergeability **read** when the latest value
  is `UNKNOWN`, shared by all `mergePr` callers.
- Preserve fail-closed behavior for real unclean states and for UNKNOWN after
  budget exhaustion.
- Keep train’s STOP path for true merge failures; remove false STOP for
  in-budget UNKNOWN → MERGEABLE transitions.
- Injectable delay so tests advance attempts without wall-clock waits.

**Non-Goals:**

- Treating UNKNOWN as MERGEABLE / speculative squash.
- Retrying CONFLICTING, DIRTY, BEHIND, BLOCKED, HAS_HOOKS, or failed required
  checks as if they were compute gaps.
- Putting a second recoverer or sleep loop inside `train.ts` that bypasses
  merge gates.
- Changing serial merge wave ordering, independence rules, or merge authority.
- Reworking merge-queue dry-run skip semantics beyond automatic inheritance if
  it already calls `mergePr` (dry-run does not merge today).
- Human intervention taxonomy changes (this is not a needs-human class).

## Decisions

### D1 — Retry in the shared merge surface, not train-only

**Choice:** Implement the UNKNOWN re-read loop inside `mergePr` (or a helper
owned by `merge.ts` and only used by that gate), so CLI `pipeline merge`, train
`mergeIssuePr`, and any other authorized caller share one law.

**Why:** The throw text already lives in `checkMergeability`. A train-only
catch/retry of that string is a path-local mole; the next `pipeline merge`
invocation fails the same way. Class-over-site for ship-path dogfood.

**Alternatives considered:**

- Train-only retry of `mergeIssuePr` on UNKNOWN message match — rejected
  (fragile string matching; leaves CLI merge broken).
- Outer supervisor sleep + re-invoke train — rejected (human/supervisor as
  first recoverer; issue asks the engine to retry).

### D2 — Retry only the mergeability gate; re-fetch head with each attempt

**Choice:** On each attempt, re-call `ghPrView` for `mergeable`,
`mergeStateStatus`, and `headRefOid`. Proceed to checks / stage / squash only
when the **latest** read is `MERGEABLE` + `CLEAN`. Bind `--match-head-commit`
to the head from that successful read (existing TOCTOU protection).

**Why:** Head can move while waiting; using a stale head from the first UNKNOWN
read would either block wrongly or merge the wrong SHA.

**Alternatives considered:**

- Cache head from first read and only re-poll mergeable — rejected (stale head
  risk).
- Sleep outside `mergePr` then single re-entry of the whole train merge step —
  unnecessary; the gate already owns the read.

### D3 — Fixed small budget (attempts + delay), not infinite poll

**Choice:** Fixed attempt budget on the order of **5 attempts** with a short
delay between attempts on the order of **5–15 seconds** (exact constants
chosen at implement time; document as named constants). Sleep is optional on
`MergeDeps` (default real sleep in production; fake/no-op or recorded sleep in
tests).

**Why:** Matches issue acceptance (“5× / 5–15s”), bounds ship latency, and
fails closed if GitHub stays UNKNOWN (rare sticky state or API oddity).

**Alternatives considered:**

- Exponential backoff with large cap — overkill for a seconds-scale compute gap.
- Single extra retry only — weaker against multi-second UNKNOWN windows observed
  in the wild.
- Config key in `.github/pipeline.yml` — deferred; constants are enough for
  v1.39.1; config can come later if ops need it.

### D4 — UNKNOWN never counts as success; CONFLICTING never enters the UNKNOWN sleep path as success

**Choice:** `checkMergeability` semantics stay fail-closed for non-MERGEABLE
except that `mergePr` **loops** only while the classified failure is the
UNKNOWN class (and attempts remain). CONFLICTING / DIRTY / etc. throw (or
return the existing error) on first observation without burning the UNKNOWN
retry budget as a success path.

**Why:** Do not soften conflict gates. Do not squash while mergeable is still
UNKNOWN.

### D5 — Observability

**Choice:** Log each UNKNOWN re-attempt at info level
(e.g. `[pipeline merge] #N: mergeability UNKNOWN; retry a/b after delay`) so
ship logs show recovery rather than a silent multi-second hang. Do not change
event schema in this change unless an existing merge/train event already has a
natural field (prefer minimal surface).

### D6 — Train surface stays thin

**Choice:** No special-case UNKNOWN handling in `train.ts` beyond what
`mergeIssuePr` → `mergePr` already provides. Existing catch that builds
`merge failed for #…` remains for true failures (budget-exhausted UNKNOWN,
CONFLICTING, checks, etc.).

**Why:** Train STOP on exhausted budget is correct; only the false first-attempt
STOP is the bug.

## Risks / Trade-offs

- **[Risk] Ship merge wave pauses up to ~budget wall time on sticky UNKNOWN** →
  Mitigation: small fixed budget; still better than full milestone STOP + human
  re-run. Log retries for operators.
- **[Risk] Tests flaky if real sleep used** → Mitigation: mandatory injectable
  `sleep` on deps; unit tests assert attempt counts, not wall clock.
- **[Risk] Message-based callers assume immediate UNKNOWN throw** → Mitigation:
  update `merge.test.ts` and any train fixture that expected first-read UNKNOWN
  terminal; keep the same error text class after budget exhaustion so playbooks
  still match.
- **[Trade-off] Fixed constants vs config** → Prefer constants for this hotfix
  milestone; revisit if ops need per-repo tuning.

## Migration Plan

1. Land behavior + tests on the feature branch; regenerate `plugin/` with
   `node scripts/build.mjs` when `core/` changes.
2. No label or data migration.
3. Rollback: revert the change; worst case returns to immediate UNKNOWN STOP
   (prior behavior).

## Open Questions

None that block specs or implementation. Exact attempt count and delay within
the stated band are implement-time constants as long as tests pin them and the
budget remains small and deterministic.
