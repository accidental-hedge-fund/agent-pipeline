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
  is `mergeable === "UNKNOWN"`, shared by all `mergePr` callers.
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

### D2 — Retry only `mergeable === "UNKNOWN"`; re-fetch head each attempt

**Choice:** The re-read loop runs **only** when `mergeable === "UNKNOWN"`.
Any other non-success classification fails **immediately** on that read:
no sleep, no further UNKNOWN-budget consumption, no merge.

Success classification (exit the loop and proceed to checks) is only:

- `mergeable === "MERGEABLE"` **and** `mergeStateStatus === "CLEAN"`.

Immediate hard refusals (examples; match existing `checkMergeability` law):

- `mergeable === "CONFLICTING"`
- `mergeStateStatus === "DIRTY"` (including MERGEABLE+DIRTY)
- `mergeable === "MERGEABLE"` with non-CLEAN status (BEHIND, BLOCKED,
  HAS_HOOKS, UNKNOWN status, etc.)
- any other non-MERGEABLE / non-CLEAN combination that is not the pure
  `mergeable === "UNKNOWN"` compute gap

On **each** attempt, re-call `ghPrView` for `mergeable`, `mergeStateStatus`,
and `headRefOid`. Bind `--match-head-commit` to the `headRefOid` from the
**successful** MERGEABLE+CLEAN read only. Do **not** retain or reuse the SHA
from an earlier UNKNOWN read.

**Why:** Head can move while waiting; using a stale head from the first UNKNOWN
read would either block wrongly or merge the wrong SHA. Hard states must not
burn retry delay as if they were compute gaps.

**Alternatives considered:**

- Cache head from first read and only re-poll mergeable — rejected (stale head
  risk).
- Sleep outside `mergePr` then single re-entry of the whole train merge step —
  unnecessary; the gate already owns the read.
- Retry also when `mergeable === "MERGEABLE"` and `mergeStateStatus === "UNKNOWN"`
  — rejected for this change; that path stays an immediate hard refuse per
  existing gate (reviewer: retry only `mergeable === "UNKNOWN"`).

### D3 — Exact retry budget (named constants)

**Choice:** Export named constants from `core/scripts/stages/merge.ts`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `MERGEABILITY_UNKNOWN_MAX_ATTEMPTS` | `5` | Total mergeability `ghPrView` reads in the UNKNOWN loop (initial read **counts**) |
| `MERGEABILITY_UNKNOWN_RETRY_DELAY_MS` | `5000` | Fixed delay between consecutive UNKNOWN reads |

**Loop mechanics:**

1. Attempt `i = 1..MAX_ATTEMPTS`: call `ghPrView` for mergeability fields.
2. If MERGEABLE+CLEAN → break; use this attempt’s `headRefOid`.
3. If `mergeable === "UNKNOWN"` and `i < MAX_ATTEMPTS` →
   `await deps.sleep(MERGEABILITY_UNKNOWN_RETRY_DELAY_MS)`, continue.
4. If `mergeable === "UNKNOWN"` and `i === MAX_ATTEMPTS` → throw existing
   actionable UNKNOWN message class; **do not** call `ghPrMerge`.
5. If any other classification → throw that gate error **immediately**;
   **zero** further sleeps for that merge; **do not** call `ghPrMerge`.

**Derived counts (tests pin these):**

| Scenario | `ghPrView` (mergeability) | `sleep` calls | `ghPrMerge` |
| --- | ---: | ---: | ---: |
| Immediate MERGEABLE+CLEAN | 1 | 0 | 1 (if later gates pass) |
| UNKNOWN then MERGEABLE+CLEAN on 2nd read | 2 | 1 (5000 ms) | 1 with **2nd** head SHA |
| All 5 reads UNKNOWN | 5 | 4 | 0 |
| First read CONFLICTING | 1 | 0 | 0 |
| First read MERGEABLE+DIRTY | 1 | 0 | 0 |

Maximum wall-clock wait on sticky UNKNOWN: **4 × 5s = 20s** of sleeps
(plus five read latencies). Fits the issue band “5× / 5–15s” delay per gap.

**Why:** Plan review required exact semantics before coding. Fixed small budget
matches live “few seconds” UNKNOWN windows without unbounded ship hang.

**Alternatives considered:**

- Exponential backoff with large cap — overkill for a seconds-scale compute gap.
- Single extra retry only — weaker against multi-second UNKNOWN windows.
- Config key in `.github/pipeline.yml` — deferred; constants are enough for
  v1.39.1; config can come later if ops need it.
- Leaving constants as “implement-time choice” — rejected; pin here.

### D4 — Injectable `sleep` on `MergeDeps`

**Choice:** Add `sleep(ms: number): Promise<void>` to `MergeDeps`.

- Production `realMergeDeps`:
  `sleep: (ms) => new Promise((r) => setTimeout(r, ms))`.
- Unit-test fixtures: inject a recorder that pushes `ms` and resolves
  immediately (no wall-clock wait). Default `makeDeps` in tests always
  supplies a no-wait sleep so accidental omission never real-waits.

**Pattern citation:** same injectable-sleep DI as
`core/scripts/detach.ts` (`sleep` on deps + production `setTimeout` default)
and the hermetic recorder style in `core/test/idempotent-audit.test.ts`
(`retryComment` with `async (ms) => { sleeps.push(ms); }`).

### D5 — UNKNOWN never counts as success; CONFLICTING never enters the UNKNOWN sleep path as success

**Choice:** `checkMergeability` stays a pure classifier. `mergePr` owns the
loop and only sleeps when the pure check returned the UNKNOWN-class error
**and** attempts remain. CONFLICTING / DIRTY / etc. throw on first observation
without sleeping.

**Why:** Do not soften conflict gates. Do not squash while mergeable is still
UNKNOWN.

### D6 — Observability

**Choice:** Log each UNKNOWN re-attempt at info level, e.g.

`[pipeline merge] #N: mergeability UNKNOWN; retry i/MAX after 5000ms`

so ship logs show recovery rather than a silent multi-second hang. Do not
change event schema in this change.

### D7 — Train surface stays thin; train fixture must call real `mergePr`

**Choice:** No special-case UNKNOWN handling in `train.ts` beyond what
`mergeIssuePr` → `mergePr` already provides. Existing catch that builds
`merge failed for #…` remains for true failures (budget-exhausted UNKNOWN,
CONFLICTING, checks, etc.).

**Train hermetic fixture requirement (plan review):** Do **not** satisfy the
acceptance criterion by mocking `mergeIssuePr` to return success. Wire
`mergeIssuePr: (pr) => mergePr(pr, mergeDeps)` with injected `MergeDeps`
(`ghPrView` sequence UNKNOWN then MERGEABLE+CLEAN, fake sleep, recording
`ghPrMerge`). Assert:

- train `exitCode === 0` (or continues to next item / full success for that
  work list);
- containment proceeds (`fetchBase` / `isAncestor` as today);
- terminal error is **not** the first-attempt-only UNKNOWN STOP text of the
  form `merge failed for #<issue> PR #<pr>: PR mergeability is not yet
  computed (UNKNOWN)...`.

**Why:** Proves class-over-site inheritance through the real shared gate, not a
train-local fake.

## Risks / Trade-offs

- **[Risk] Ship merge wave pauses up to ~20s of sleep on sticky UNKNOWN** →
  Mitigation: fixed 5 attempts / 5s; still better than full milestone STOP +
  human re-run. Log retries for operators.
- **[Risk] Tests flaky if real sleep used** → Mitigation: mandatory injectable
  `sleep` on deps; unit tests assert attempt counts, not wall clock; test
  `makeDeps` defaults to no-wait sleep.
- **[Risk] Message-based callers assume immediate UNKNOWN throw** → Mitigation:
  update `merge.test.ts` and train fixture that expected first-read UNKNOWN
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

None. Retry budget, classification, head-SHA authority, and train fixture
requirements are fixed above.
