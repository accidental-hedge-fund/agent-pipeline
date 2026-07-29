## Why

Operators observe pre-merge as “blocks more often than not,” but the factory scoreboard
cannot answer *why*: existing metrics report a coarse `needs_human_rate` and
`blocker_rate_by_kind` over all stages, while many pre-merge off-ramps still collapse to
the generic `needs-human` / `product-judgment-required` labels. Without a durable
pre-merge reason-class breakdown (CI failed vs delta-review vs merge-conflict vs
OpenSpec vs other), operators cannot prioritize CI recovery, delta allowlists, or flake
work. This change makes those rates measurable from run artifacts.

## What Changes

- Define a closed, stable set of **pre-merge off-ramp reason classes** aligned with
  `BlockerKind` and pre-merge failure modes (at least: CI failed, delta-review /
  unresolved review findings, merge-conflict, OpenSpec invalid/stale, and a residual
  other / needs-human class).
- Record every pre-merge → blocked / needs-human off-ramp with that class on durable run
  events (prefer enriching existing `blocker_set` / intervention emission over scraping
  issue comments or free-text reason parsing alone).
- Expose a machine-readable aggregate on the existing factory scoreboard (human +
  `--json`): count and rate of pre-merge entries that end needs-human/blocked, plus a
  breakdown by reason class over the selected window.
- Document the dogfood-day query path (scoreboard flags / JSON path).
- **Out of scope (follow-up):** papercut auto-file thresholds when a class (e.g.
  `ci-failed`) exceeds N% — noted only as a non-blocking follow-up so noisy auto-filing
  does not land with this metrics work.

## Acceptance Criteria

- [ ] When pre-merge routes an issue to blocked or needs-human, the run’s durable event
      stream records a stable reason class from a closed enumerated set (not free-text
      alone), including stage context that identifies the off-ramp as pre-merge.
- [ ] `pipeline scoreboard --json` over a fixture window with mixed pre-merge off-ramps
      emits a parseable aggregate with (a) count and rate of pre-merge entries ending
      needs-human/blocked and (b) per-class counts and rates that sum consistently with
      the total.
- [ ] The same aggregate appears in the human-readable scoreboard report for that window.
- [ ] Aggregation reads run artifacts / correction or event ledger surfaces only — it does
      not scrape issue comments for classification.
- [ ] Operators can obtain a dogfood-day breakdown using documented `pipeline scoreboard`
      flags (e.g. `--days 1` or `--since`/`--until` + `--json`) without new ad-hoc scripts.
- [ ] Zero-denominator windows report `null` rates (matching existing scoreboard rules)
      rather than fabricating zeros or crashing.
- [ ] Historical events missing the new class fields are diagnosed or bucketed into a
      stable residual class without aborting the scoreboard scan.
- [ ] Optional papercut auto-file threshold by class % is explicitly deferred (documented
      as follow-up), not implemented in this change.

## Capabilities

### New Capabilities
- `pre-merge-offramp-classification`: Durable closed-set classification of pre-merge
  blocked / needs-human off-ramps on run events so scoreboard and other consumers can
  aggregate without parsing free-text reasons or GitHub comments.

### Modified Capabilities
- `factory-scoreboard`: Add pre-merge needs-human rate and per-class breakdown metrics
  derived from the durable classification, exposed in human and `--json` output over the
  existing time window (and composing with `--bucket` period metrics when present).

## Impact

- `core/scripts/stages/pre_merge.ts` and the blocked-path orchestrator
  (`pipeline-run.ts` / `setBlocked` → event emission) must emit a stable class on every
  pre-merge off-ramp (may add `BlockerKind` values and/or additive event fields).
- `core/scripts/run-store.ts` event types (`blocker_set` and/or related) may gain additive
  fields (`kind` / `class` / `stage`) without a schema_version bump if the change stays
  purely additive and consumers tolerate unknown fields.
- `core/scripts/scoreboard.ts` (+ tests/fixtures) gains aggregation and report sections.
- README / scoreboard help gains a short dogfood-day query note.
- Does **not** change pre-merge advance/merge semantics, auto-merge policy, or review
  rigor. Does **not** auto-file papercuts from class rates.
