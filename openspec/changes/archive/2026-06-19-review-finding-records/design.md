## Context

Issue #209 asks the engine to persist the structured per-finding review records into the run
directory so Pipeline Desk's Review tab renders from the engine's artifacts, not from scraped
PR comment markdown. The data exists transiently (`ReviewVerdict.findings: ReviewFinding[]` in
`core/scripts/stages/review.ts`) but only **counts** are persisted today:

- `events.jsonl` → `review_verdict`: `{ round, sha, verdict, finding_counts }` (`run-store.ts`).
- `summary.json` → `reviews[]` `ReviewRecord`: `{ round, sha, verdict, findingCounts }` (`types.ts`).

## Decision 1 — enrich the existing artifacts; do NOT add a sibling `reviews/` file

The issue offers two shapes: (a) extend `reviews[]` with `findings`, or (b) write a sibling
`reviews/round-<n>-<sha>.json` per round. **(b) conflicts with an existing spec** and is
rejected:

> `run-directory-layout` → "Run directory contains only well-known files": *The run directory
> files (`run.json`, `events.jsonl`, `terminal.log`, `summary.json`) SHALL be the only files
> the orchestrator writes to the run directory.*

Adding per-round files would force a modification of that requirement and split review state
across an unbounded set of files. Instead we **enrich the two artifacts already in the
contract**, which also gives the consumer both tiers for free:

- **`events.jsonl` `review_verdict`** — the incremental, crash-safe, append-only tier the Desk
  reads (#155). Enriched in place, so the Desk sees per-finding data even for an in-progress or
  crashed run (before `summary.json` exists).
- **`summary.json` `reviews[]`** — the finalized snapshot, enriched identically.

This matches the established direction (#147 evidence bundle, #155 structured events) and keeps
the engine the single source of truth.

## Decision 2 — the per-finding record shape

A persisted finding record = the in-memory `ReviewFinding` field set **plus** the stable `key`:

```
key            // findingKey(finding) — 8-char hex, from review-policy.ts
severity        title        body
file?           line_start?  line_end?
confidence      recommendation
category?       blocking?
```

Optional source fields (`file`, `line_start`, `line_end`, `category`, `blocking`) are persisted
only when present, mirroring `ReviewFinding`. **No truncation** of `title` / `body` /
`recommendation` — unlike `CommandRecord.outputExcerpt` / `PromptRecord.excerpt` (capped at 500
chars), these are the content the Desk renders, and they are bounded by the reviewer's own
output (and already mirrored in the PR comment). A new `ReviewFindingRecord` type in `types.ts`
names this shape.

## Decision 3 — `key` is the correlation handle (reuse `findingKey`, never reimplement)

`stable-finding-identity` already makes `findingKey` in `review-policy.ts` the *single* source
of finding identity for overrides and recurrence. Persisting that same `key` per finding lets
the Desk:
- join a finding to its `OverrideRecord` in `overrides[]` (matching `key`), and
- correlate the same finding across rounds (matching `key`).

The persistence path calls `findingKey(f)` directly — no second algorithm.

## Decision 4 — resolution is derived, not stored

The Desk's ✓/○ per finding is a function of the per-round `key` sets: a `key` blocking in round
N and absent from round N+1's findings is **resolved**; still-present is **still-open**. We do
**not** add a mutable per-finding status field, because the round records are append-only —
storing a status would mean rewriting an earlier round when a later round resolves it, which
fights the model and risks divergence. Deriving keeps a single source of truth (the round
findings) and satisfies the issue's explicit "or enough to derive it" branch. A unit test
encodes the derivation over a two-round fixture so the contract is executable.

"Blocking in round N" uses the finding's `blocking` field (absent/true = blocking by
severity/confidence; false = advisory, #236), consistent with how the rest of the engine
partitions blocking vs. advisory findings.

## Decision 5 — reviewer identity

Each round records the harness that **actually** reviewed (`reviewer` after the #39
same-harness-fallback reassignment in `review.ts`, not the configured reviewer), the reviewer
model (`cfg.models.review`, the same value passed to the harness at `review.ts`), and a
`self_review` boolean (true on the #39 fallback). This lets the Desk show "reviewed by
`<harness>`/`<model>`" and honestly flag a self-review round.

## Decision 6 — field casing follows each artifact's existing convention

`events.jsonl` is snake_case throughout (`finding_counts`, `schema_version`), so the event
fields are `findings`, `reviewer_harness`, `reviewer_model`, `self_review`. `ReviewRecord` in
`summary.json` is camelCase (`findingCounts`), so its added fields are `findings`, `harness`,
`model`, `selfReview`. This per-artifact split already exists today (`finding_counts` vs
`findingCounts`); we follow precedent rather than introduce a third style. The `ReviewFinding`
objects keep their native field names in both (`line_start`/`line_end` are already snake on the
TS interface).

## Decision 7 — redaction, non-fatal, schema_version

- **Redaction**: finding `title`/`body`/`recommendation` are reviewer/model-authored, so they
  flow through the existing write-time injection denylist + field-level secret redaction
  (`run-artifact-conventions`, #161) — the same `sanitizeDeep`/`redactSecrets` path every
  record already uses. No new redaction code; the new fields just ride the existing path.
- **Non-fatal**: the enriched writes stay inside the current best-effort `.catch(() => {})`
  paths in `review.ts` and the non-fatal bundle writer.
- **schema_version**: every addition is an optional field, so per the
  `run-artifact-conventions` backward-compat promise, `schema_version` (and the transitional
  `schemaVersion` alias) stay `1`.

## Implementation touchpoints

- `core/scripts/types.ts` — add `ReviewFindingRecord`; add `findings`, `harness`, `model`,
  `selfReview` to `ReviewRecord`.
- `core/scripts/run-store.ts` — add `findings`, `reviewer_harness`, `reviewer_model`,
  `self_review` to `ReviewVerdictEvent`.
- `core/scripts/stages/review.ts` — build the `findings` array from `verdict.findings` (mapping
  each through `findingKey`), thread `reviewer` (effective), `cfg.models.review`, and the
  `selfReview` flag into both `recordReview(...)` and the `review_verdict` `appendEvent(...)`.
- `core/scripts/evidence-bundle.ts` — `recordReview` already persists whatever `ReviewRecord`
  it is handed; no logic change beyond the wider type.
- `core/test/` — tests for: record shape & key equality, resolution derivation over two rounds,
  redaction of an injected/secret-bearing finding, non-fatal write failure, zero-findings empty
  array, and `schema_version` unchanged.

## Risks / trade-offs

- **Event-line size**: full finding bodies enlarge `events.jsonl` lines. Accepted — bodies are
  bounded by reviewer output and are exactly what the Desk needs; truncation would defeat the
  feature. (`terminal.log` remains the place for unbounded raw output.)
- **Derived resolution vs. stored**: derivation requires the consumer to diff rounds, but it
  avoids append-only violations and keeps one source of truth. The unit test makes the rule
  unambiguous for the Desk to mirror.
