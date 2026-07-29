## Context

Pre-merge is a multi-gate stage (`core/scripts/stages/pre_merge.ts`): CI (GitHub or
local), mergeability / conflict recovery, review-SHA / delta recheck, OpenSpec validate
and archive, and various fail-closed paths. Operators only see a high overall
needs-human rate on the factory scoreboard.

Today’s durable signals:

| Signal | What it carries | Gap for this issue |
| --- | --- | --- |
| `blocker_set` event | `reason` free-text only | No kind, no stage, no closed class |
| `human_intervention` | coarse `HumanInterventionKind` + `stage` | Pre-merge CI and delta-review both often map through `needs-human` → `product-judgment-required` |
| `BlockerKind` on `setBlocked` | closed set with recipes | Pre-merge CI failure and delta-review frequently pass `"needs-human"` rather than a distinct kind |
| Scoreboard `blocker_rate_by_kind` | counts interventions by kind across all stages | Not pre-merge-scoped |
| Scoreboard `needs_human_rate` | `finalState === "needs-human"` | Run-final, not “pre-merge entry ended needs-human” |

Issue #683 asks for a durable class breakdown of pre-merge → needs-human/blocked and a
scoreboard (or equivalent) aggregate preferred over comment scraping.

## Goals / Non-Goals

**Goals:**

- Closed, stable reason classes for pre-merge off-ramps that operators can prioritize
  against (CI, delta-review, conflict, OpenSpec, residual).
- Every pre-merge blocked/needs-human path records the class on the run event stream.
- Scoreboard (existing window/`--json`/`--bucket` surfaces) exposes total pre-merge
  needs-human rate and per-class breakdown.
- Dogfood query documented as a one-liner over `pipeline scoreboard`.
- Backward-tolerant aggregation for older runs missing the new fields.

**Non-Goals:**

- Papercut auto-file when a class exceeds N% (follow-up; avoid noisy GitHub issues).
- Changing which conditions block at pre-merge or relaxing review/CI rigor.
- Scraping issue comments or PR check-run APIs at report time.
- A new top-level CLI command if scoreboard can carry the metric (prefer extending
  scoreboard).
- Replacing `HumanInterventionKind` or the durable-loop `DurableBlockerClass` taxonomy
  (different scopes: intervention taxonomy vs durable-loop recovery vs this pre-merge
  operator metric).

## Decisions

### 1. Closed class set: `PreMergeOfframpClass`

Introduce a small closed string enum used only for pre-merge off-ramp metrics (and
recorded on events). Minimum members:

| Class | Meaning | Primary pre-merge sources |
| --- | --- | --- |
| `ci-failed` | CI / local test-gate failure after recovery budget | GitHub checks fail; local inline gate fail |
| `delta-review` | Review-SHA / delta recheck left blocking findings or ceiling | Delta review block paths |
| `merge-conflict` | Unresolved merge conflict / rebase failure | Early conflict + post-CI conflict recovery |
| `openspec-invalid` | OpenSpec structural validation failed | `openspec-invalid` BlockerKind paths |
| `openspec-stale-delta` | Stale OpenSpec delta vs code | consistency guard |
| `other` | Residual pre-merge needs-human (missing PR, head-drift misconfig, fail-closed catch-alls, unmapped) | Default when no finer class applies |

Rationale: aligns with operator language in the issue (“CI failed vs delta-review vs
conflict vs OpenSpec vs other”) and with existing `BlockerKind` where it already
distinguishes (`merge-conflict`, `openspec-invalid`, `openspec-stale-delta`). Avoids
expanding `HumanInterventionKind` (factory-debt taxonomy) or `DurableBlockerClass`
(durable-loop recovery policy).

Alternative considered: only fix `BlockerKind` on every `setBlocked` and aggregate
scoreboard by `stage=pre-merge` + kind. Rejected as sole approach because (a)
`blocker_set` still lacks kind/stage today, and (b) CI vs delta-review both need distinct
classes while many paths currently pass `"needs-human"`. Still do improve `BlockerKind`
where it is wrong (e.g. CI → not generic needs-human) so recipes and intervention mapping
stay coherent; map those kinds into `PreMergeOfframpClass` for the scoreboard key.

### 2. Enrich durable events at write time; never scrape comments at read time

When pre-merge returns `status: "blocked"` (or transitions to needs-human at pre-merge),
the orchestrator emission path SHALL persist:

- `stage: "pre-merge"` (already present on `human_intervention`)
- `offramp_class` (or equivalent field name) on a durable event — preferred home:
  **additive fields on `blocker_set`**: `stage`, `blocker_kind`, `offramp_class`
- Keep writing `human_intervention` as today (ordering preserved).

Scoreboard aggregation SHALL prefer `blocker_set` events where `stage === "pre-merge"`
and `offramp_class` is present. Fallback for historical lines:

1. If `stage === "pre-merge"` and `blocker_kind` is present, map kind → class.
2. Else if a same-run `human_intervention` with `stage === "pre-merge"` exists without
   class, count under `other` (or a diagnostic-tagged residual), not free-text NLP.
3. Never parse issue comment bodies for class.

Rationale: issue explicitly prefers durable run events / correction ledger over comment
scraping. Additive event fields keep `schema_version: 1` (same pattern as other additive
scoreboard fields).

### 3. Denominator: pre-merge *entries* in the window, not all runs

Define:

- **Pre-merge entry**: an included run that has evidence of entering pre-merge in the
  window (a `stage_start` for `pre-merge`, or a pre-merge `blocker_set` / accounting
  record — implementation picks one primary signal and tests pin it).
- **Pre-merge needs-human off-ramp**: a pre-merge entry that recorded a pre-merge
  blocked/needs-human off-ramp event with a class (or residual).

Metrics:

- `pre_merge_needs_human_rate`: numerator = count of pre-merge needs-human off-ramps
  (distinct events or one per run entry — pin **one off-ramp event per blocking
  transition**, not de-dupe away repeated genuine blocks across re-entries); denominator
  = pre-merge entries.
- `pre_merge_needs_human_by_class`: counts and rates per `PreMergeOfframpClass` with the
  **same denominator** (pre-merge entries), so class rates are comparable; sum of class
  counts equals the total off-ramp numerator when residual is included.

Zero-denominator: ratios `null` (existing scoreboard rule).

Alternative considered: denominator = all included runs. Rejected — inflates the rate
with runs that never reached pre-merge and hides pre-merge-specific pressure.

### 4. Expose via existing `pipeline scoreboard`, not a new command

Add to `ScoreboardMetrics` (and human/HTML renderers) additive keys, e.g.:

```json
"pre_merge_needs_human": {
  "rate": { "numerator": N, "denominator": D, "ratio": r | null },
  "by_class": {
    "ci-failed": { "count": c, "rate": { ... } },
    ...
  }
}
```

Compose with `--bucket`: each period’s `metrics` reuses the same reducer (existing
bucket design). No new CLI surface required for dogfood day:

```bash
pipeline scoreboard --days 1 --json | jq '.metrics.pre_merge_needs_human'
```

Document that one-liner in README / scoreboard help.

### 5. Surgical pre-merge instrumentation, not a broad taxonomy rewrite

Implementation discipline:

- Add `PreMergeOfframpClass` + pure mapper from `(BlockerKind | path tag) → class`.
- On every pre-merge `setBlocked` / blocked return, pass an explicit `BlockerKind` when
  one exists; set `offramp_class` on the event emission path (orchestrator receives
  `blockerKind` already on many `StageResult`s — ensure CI and delta paths set it).
- Prefer mapping at emission (single place in `pipeline-run.ts` when writing
  `blocker_set`) over duplicating class strings at every `setBlocked` call site; stage
  code still must return accurate `blockerKind` / reason for the mapper.
- Unit tests with fixture events only (no network/git).

### 6. Follow-up only: papercut threshold on class %

Design leaves a stub note: once dogfood shows `ci-failed` (or other) rates are stable and
actionable, a later change may add `papercuts` config for auto-file when class rate
exceeds N% over a window. Not part of tasks for this change.

## Risks / Trade-offs

- **[Risk] Historical runs under-count fine classes** → Mitigation: residual `other` +
  diagnostics; document that class breakdown is trustworthy for runs after this lands.
- **[Risk] Over-fitting many micro-classes** → Mitigation: keep the closed set small;
  residual absorbs rare paths.
- **[Risk] Double-counting multi-block runs** → Mitigation: count each recorded off-ramp
  event; document definition; tests with multi-event fixtures.
- **[Risk] Diverging from BlockerKind recipes** → Mitigation: improve kinds where wrong
  (CI) so recipes match class; mapper is the single bridge.
- **[Risk] Confusing with DurableBlockerClass** → Mitigation: distinct name
  (`PreMergeOfframpClass`), documented non-goal, no durable-loop policy change.

## Migration Plan

1. Land additive event fields + accurate pre-merge kinds/classes (write path).
2. Land scoreboard aggregation + tests + docs (read path).
3. No backfill of old events required; old windows remain valid with residual bucket.
4. Rollback: remove scoreboard keys and stop writing additive fields; older consumers
   already ignore unknown event fields.

## Open Questions

None blocking. Implementation may choose the exact JSON key names
(`offramp_class` vs `class`) as long as they are stable, documented in the scoreboard
schema surface, and covered by tests. Prefer `offramp_class` to avoid colliding with
correction `failure_class` or durable-loop class vocabulary.
