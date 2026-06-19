## Why

Pipeline Desk's **Review tab** is the product differentiator: it renders the cross-harness
review as rounds of *individual findings* (severity badge + `file:line` + description +
per-item resolved/unresolved across fix rounds + verdict + reviewed SHA + reviewer
harness/model). Today the run directory cannot back it. `summary.json` `reviews[]` and the
`events.jsonl` `review_verdict` event record only per-severity **counts** (`ReviewRecord`,
`core/scripts/types.ts`). The rich `ReviewFinding[]` and `ReviewVerdict` exist transiently
inside the engine and are posted to the PR review comment markdown, but are **never written
into the run directory**. So the Desk can only show counts, or scrape/parse PR comment
markdown — fragile, and unavailable offline / on rate-limit / at the Legacy tier the Desk
must degrade into honestly (#155, #147).

This change persists the structured per-finding records into the run directory so the Desk
reads review state from the engine's own artifacts, keeping the engine the single source of
truth (matches the #153–#156 desktop-contract direction).

## What Changes

- The `events.jsonl` `review_verdict` event (incremental, crash-safe tier) gains a
  `findings` array — one record per enumerated finding carrying `key` (the stable
  `findingKey` from `review-policy.ts`), `severity`, `title`, `body`, `file`, `line_start`,
  `line_end`, `confidence`, `recommendation`, `category`, and `blocking` — plus
  `reviewer_harness`, `reviewer_model`, and `self_review` for the round.
- The `summary.json` `reviews[]` `ReviewRecord` (finalized tier) gains the same per-finding
  `findings` array plus `harness`, `model`, and `selfReview`, in addition to the existing
  `findingCounts`.
- Per-finding **resolution** (✓ resolved / ○ still-open) is **derivable** from the persisted
  round findings via the stable `key`: a key that blocks in round N and is absent from a
  later round's findings is resolved; a key still present is still-open. No mutable
  per-finding status is stored (keeps the append-only model intact). The issue's "or enough
  to derive it" branch is satisfied.
- Finding text fields (`title`, `body`, `recommendation`) pass through the **existing**
  write-time injection denylist + secret redaction before persistence (#161), like every
  other artifact record.
- Records ride **inside the existing `events.jsonl` and `summary.json`** — **no new files**
  are added to the run directory. The decision not to write a sibling
  `reviews/round-<n>-<sha>.json` (one of the issue's two suggested shapes) is deliberate:
  it conflicts with the existing `run-directory-layout` requirement that those four
  well-known files are the *only* files the orchestrator writes (see design.md).
- All new fields are **additive and optional**, so `schema_version` stays `1`; writes remain
  **non-fatal**; `--json-events` streams the enriched event to stdout unchanged in shape.

## Capabilities

### New Capabilities
- `review-finding-records`: Defines the structured per-finding review record persisted into
  the run directory — its field set, the stable finding `key` as the cross-round / overrides
  correlation handle, the resolution-derivation rule, the reviewer harness/model identity,
  the redaction obligation, and the supplement-only / non-fatal guarantees.

### Modified Capabilities
- `events-jsonl-streaming`: The `review_verdict` event SHALL additionally carry the per-finding
  `findings` array and the reviewer `reviewer_harness` / `reviewer_model` / `self_review`
  identity (the incremental, crash-safe tier).
- `evidence-bundle`: The `ReviewRecord` in `summary.json` SHALL additionally carry the
  per-finding `findings` array and the reviewer `harness` / `model` / `selfReview` identity
  (the finalized tier).

## Impact

- `core/scripts/types.ts` — new `ReviewFindingRecord` type; `ReviewRecord` gains
  `findings`, `harness`, `model`, `selfReview`.
- `core/scripts/run-store.ts` — `ReviewVerdictEvent` gains `findings`, `reviewer_harness`,
  `reviewer_model`, `self_review`.
- `core/scripts/stages/review.ts` — build the `findings` array from `verdict.findings`
  (computing each `key` via `findingKey`), pass reviewer identity into `recordReview` and
  the `review_verdict` event.
- `core/scripts/evidence-bundle.ts` — `recordReview` carries the enriched `ReviewRecord`.
- `core/test/` — unit tests for record shape, key correlation, resolution derivation,
  redaction, non-fatal writes, and zero-findings.
- No state-machine edges, review verdict schema (`review-schema.ts`), or blocking/routing
  logic change — this is a write-only supplement. `plugin/` mirror regenerated.

## Acceptance Criteria

Observable, falsifiable outcomes that make #209 done:

- [ ] After a review round completes, the `review_verdict` event in `events.jsonl` carries a
      `findings` array with one entry per enumerated finding, each entry containing `key`,
      `severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`,
      `recommendation`, `category`, and `blocking`.
- [ ] The same `review_verdict` event also carries `reviewer_harness`, `reviewer_model`, and
      `self_review` for the round.
- [ ] Each persisted finding's `key` is exactly `findingKey(finding)` from `review-policy.ts`
      (the same 8-char key used by overrides and recurrence), so a consumer can join a finding
      to `overrides[]` and to the same finding in another round.
- [ ] After finalization, every `summary.json` `reviews[]` entry carries the same per-finding
      `findings` array plus `harness`, `model`, and `selfReview`, alongside the existing
      `findingCounts`.
- [ ] Per-finding resolution is derivable from persisted rounds: a unit test over a
      two-round fixture confirms that a finding `key` blocking in the earlier round and absent
      from the later round's findings is classified resolved, while a key still present is
      classified still-open — with no GitHub access.
- [ ] Finding text fields are screened before persistence: a finding whose `body` contains an
      injection-denylist span persists `[REDACTED-INJECTION]`; one whose field contains a
      secret assignment persists `[REDACTED]`. Raw values never reach disk.
- [ ] No new files appear in the run directory — findings are carried inside the existing
      `events.jsonl` and `summary.json`; the `run-directory-layout` "only well-known files"
      requirement still holds.
- [ ] `schema_version` (and `schemaVersion`) remain `1` — the additions are optional fields.
- [ ] A write error while persisting the enriched record does not abort or block the review
      stage (non-fatal I/O), proven by a test that injects a write failure.
- [ ] With `--json-events`, the enriched `review_verdict` line (including `findings`) appears
      on stdout identical to the `events.jsonl` line.
- [ ] A review round with zero findings still records the verdict and counts, with `findings: []`.
- [ ] From the run directory alone (no GitHub access), a consumer can reconstruct each review
      round's findings with severity, `file:line`, description, per-item resolved/unresolved,
      verdict, reviewed SHA, and reviewer harness/model.
- [ ] `npm run ci` is green and the `plugin/` mirror is regenerated and committed.
