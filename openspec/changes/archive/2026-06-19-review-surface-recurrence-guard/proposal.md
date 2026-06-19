## Why

The non-convergence recurrence guard (`review-loop-recurrence`) only trips on
**exact** finding-key recurrence (`findingKey = sha1(severity|file|line-band)`,
title-stable per #144). But the dominant adversarial-review churn pattern is a
**new key every round**: the reviewer fixes the flagged instance, then finds the
*next adjacent edge case* on the same surface, minting a fresh key the exact-key
guard never sees. The loop then runs to the round ceiling.

Evidence from real runs:

- **#186** churned **6 adversarial rounds with ZERO key repeats** — every round a
  different new `package.json`-hardening edge ("unreadable → malformed →
  machine-mode flags → fast-path → valid-JSON-Node-rejects → `type:commonjs`").
  The exact-key guard never fired.
- **#214** minted a brand-new key in **6 of 8** churn rounds, all on the same
  `.marker.lock` mechanism ("concurrent allocation → leaked lock → empty-lock
  reclaim → reclaim deletes fresh lock → reclaim deletes live replacement").

These are the same *class* of finding re-surfacing on the same file, but each new
wording/line mints a new key, so the recurrence guard is bypassed.

## What Changes

- Add a **surface/theme-based** diminishing-returns guard keyed on
  `(file + category)` clusters across rounds, complementing — not replacing — the
  exact-key guard.
- Each review verdict comment gains a machine-readable
  `pipeline-blocking-surfaces` marker (a `key~surface` list, emitted and parsed by
  a single-sourced pure function, mirroring the existing `pipeline-blocking-keys`
  marker) so prior-round surfaces are recoverable deterministically without a
  model call.
- The review stage computes a per-surface **consecutive-round streak**. When a
  `(file, category)` cluster carries a blocking finding for `N` consecutive rounds
  **and** the current round's finding in that cluster is a *new* key (not an exact
  repeat — that case is already handled by the exact-key early park), the guard
  fires for that cluster.
- When the guard fires, its action **mirrors the configured `ceiling_action`**
  (reusing the #133 early-park and #233 demote-and-advance terminals): under the
  default `park` it early-parks at `needs-human` (a human call, no silent
  advance); under `demote_and_advance` it demotes the cluster's **below-high**
  findings to advisory, records audited dispositions, files the single tracked
  follow-up issue, and advances. **High/critical findings are never demoted** by
  this guard (mirroring #233's severity floor).
- `N` is a new conservative config knob `review_policy.surface_recurrence_rounds`
  (default `3`; `0` disables the guard), registered in `RIGOR_GATING_PATHS`.

## Acceptance Criteria

- [ ] Adversarial findings are clustered across rounds by `(file + category)`, not
      only by exact `findingKey`.
- [ ] When `N` consecutive rounds raise a *new*-key blocking finding in the same
      `(file, category)` cluster that the prior round's fix already touched, the
      guard treats that cluster as diminishing returns and fires.
- [ ] When the guard fires, the cluster's findings are routed through the existing
      convergence terminal selected by `review_policy.ceiling_action`: early-park
      at `needs-human` under `park`; demote below-high findings to advisory + file
      one follow-up issue + advance under `demote_and_advance`.
- [ ] `high`/`critical` findings in a fired cluster are NEVER auto-demoted; they
      continue through the normal blocking/park path.
- [ ] The existing exact-key recurrence early park (`review-loop-recurrence`) is
      retained and takes precedence — it is evaluated first and is unchanged.
- [ ] Genuinely distinct findings on *different* `(file, category)` surfaces across
      `N` rounds do NOT trigger the guard.
- [ ] `review_policy.surface_recurrence_rounds` is accepted in config, defaults to
      `3`, rejects non-integer/negative values, disables the guard at `0`, and is
      present in `RIGOR_GATING_PATHS`.
- [ ] `extractBlockingSurfacesFromComment` is a pure function (no network/git/
      subprocess), uses a full-line-anchored marker, and chooses the LAST
      occurrence when multiple markers appear.
- [ ] Regression tests: (a) simulated whack-a-mole — 3 rounds of *new* keys in the
      same `(file, category)` → guard fires; (b) distinct findings across different
      files/categories over 3 rounds → guard does NOT fire. Each test bites (fails
      without the guard).

## Capabilities

### New Capabilities
- `review-surface-recurrence`: a `(file + category)` surface-cluster
  diminishing-returns guard that detects new-key-each-round whack-a-mole the
  exact-key recurrence guard is structurally blind to, and routes a fired cluster
  through the configured convergence terminal.

### Modified Capabilities
- `pipeline-configuration`: adds the optional `review_policy.surface_recurrence_rounds`
  knob and registers it in `RIGOR_GATING_PATHS`.

## Out of Scope

- Semantic / LLM-based finding clustering — a deterministic `(file + category)`
  heuristic is sufficient for v1.
- Changing the exact-key recurrence guard's behavior for true exact repeats
  (`review-loop-recurrence` is unchanged).
- Inventing a new convergence terminal — the fired-guard action reuses the
  existing `park` / `demote_and_advance` paths (#133, #233) selected by
  `ceiling_action`.

## Impact

- `core/scripts/review-policy.ts` — new `surfaceKey(finding)`,
  `formatBlockingSurfacesMarker`, and `extractBlockingSurfacesFromComment` pure
  helpers (mirroring `findingKey` / `pipeline-blocking-keys`).
- `core/scripts/stages/review.ts` — emit the surfaces marker in
  `formatReviewComment`; add the surface-recurrence check between the exact-key
  early-park check and the round-ceiling check.
- `core/scripts/types.ts`, `core/scripts/config.ts` — new
  `review_policy.surface_recurrence_rounds` field, default, schema, and
  `RIGOR_GATING_PATHS` entry.
- `core/test/` — new unit + regression tests for clustering, streak/threshold,
  ceiling_action-aligned action, and the two acceptance scenarios.
- No change to `review-schema.ts` (the `category` field already exists), the state
  machine edges, or the freeform (non-OpenSpec) path.
