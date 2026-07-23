## Why

Issue #499 gave the pipeline an append-only `correction_event` ledger; issue #500 added the
control compiler that clusters recurring corrections by their deterministic `correction_key`
and files reusable-control proposals. But the learning loop is still open: nothing measures
whether a shipped control actually *stops* the correction from recurring. Creating a rule, a
skill/rubric, an eval, or a gate is not success — success is that the same expert correction
class stops recurring after the control is effective. Today closing the proposal issue or
merging some PR leaves no durable, auditable link between a `correction_key` and the control
that was supposed to resolve it, and `pipeline scoreboard` cannot report recurrence before vs.
after a control, so the pipeline cannot tell learning apart from merely generating more backlog
and documentation.

This change closes the loop with two additions:

1. A **durable, explicit, audited control-attribution record** that links a `correction_key` to
   the control that resolved it — its control type, the issue/PR, the effective commit or
   release, a timestamp, and a disposition (`implemented`, `human-owned`, `rejected`,
   `superseded`). Attribution is written only by an explicit, authority-bounded command; closing
   an issue or merging an arbitrary PR never silently marks a control effective.
2. **Repeat-correction metrics in `pipeline scoreboard`**: total corrections, distinct
   correction classes, repeated-class count/rate, corrections per ready-to-deploy item,
   time-to-control, and post-control recurrence measured only over subsequent *eligible* run
   exposure — clearly distinguishing `no recurrence observed` from `insufficient post-control
   evidence`. Metrics group by repository, stage, harness/model, source kind, failure class, and
   proposed/implemented control type, show rolling-window trends, and list the top still-recurring
   classes with evidence pointers.

The report reports **temporal attribution and recurrence evidence, not causality**: it never
claims a control *caused* a drop, it surfaces superseded and rolled-back controls, and it stays
strictly read-only.

## What Changes

- Add a `control-attribution` capability: a `control_attribution` record type (append-only,
  sanitized, idempotent by a stable `attribution_id`) that links a `correction_key` to a control
  — `control_type` (one of the five #500 control levels), `disposition` (`implemented` |
  `human-owned` | `rejected` | `superseded`), `issue`, `pr`, `effective_commit`,
  `effective_release`, `effective_at`, `attributed_at`, an optional `supersedes` pointer, and a
  bounded `evidence_ref`.
- Write attribution only through an explicit, audited command surface
  (`pipeline correction attribute`) that is authority-bounded exactly like `pipeline correction
  record`: it mutates no GitHub state, needs no gh auth, appends exactly one sanitized record,
  and is never wired to advance/unblock/override/merge/deploy. Closing an issue or merging a PR
  never writes an attribution.
- Extend `pipeline scoreboard` (read-only) to read `correction_event` records and
  `control_attribution` records and report, in human and `--json` form: total corrections
  (distinct `correction_id`), distinct correction classes (distinct `correction_key`),
  repeated-class count and rate, corrections per ready-to-deploy item, time-to-control, and
  post-control recurrence per attributed class.
- Measure post-control recurrence only over **subsequent eligible run exposure** — included runs
  that started after the control's `effective_at` and that exercised the correction class's
  stage — and classify each attributed class as `recurred`, `no_recurrence_observed`, or
  `insufficient_post_control_evidence` (zero eligible post-control runs). Never conflate the
  last two.
- Add a `--corrections-by <dimension>` grouping flag (one of `repo`, `stage`, `harness`,
  `model`, `source_kind`, `failure_class`, `proposed_control`, `implemented_control`), validated
  like the existing `--by` flag, and surface rolling-window trends (via the existing `--bucket`)
  plus a top-still-recurring-classes list with sanitized evidence pointers.
- Dedup corrections by `correction_id` so replayed/duplicate deliveries count once; surface
  malformed, partial, old-schema, and missing-attribution artifacts as stable diagnostics rather
  than silent skew or crashes.

## Capabilities

### New Capabilities

- `control-attribution`: the `control_attribution` record contract (bounded `control_type` and
  `disposition` enums, `correction_key` linkage, effective commit/release/timestamp lineage,
  supersession pointer, sanitized `evidence_ref`), its stable/idempotent `attribution_id`, the
  explicit audited write surface (`pipeline correction attribute`) with a `record`-equivalent
  authority boundary, the guarantee that no issue-close or PR-merge implies attribution, the
  non-fatal sanitized write, and the malformed/old-schema-tolerant read contract.

### Modified Capabilities

- `factory-scoreboard`: add repeat-correction metrics (totals, distinct classes, repeated-class
  count/rate, corrections per ready-to-deploy item), control attribution + post-control
  recurrence over eligible exposure with the three-way recurrence classification and
  time-to-control, the `--corrections-by` grouping dimensions, rolling-window trends and the
  top-still-recurring-classes list, the non-causal / superseded-and-rolled-back reporting
  discipline, and the correction-id dedup + malformed-artifact diagnostics — all additive to the
  existing read-only, zero-denominator-null scoreboard contract.

## Impact

- `core/scripts/correction.ts` — a `control_attribution` record type + validator, a stable
  `deriveAttributionId` helper, and an `emitControlAttribution` writer mirroring the
  `emitCorrectionEvent` sanitization/non-fatal discipline.
- `core/scripts/pipeline.ts` + `core/scripts/command-registry.ts` — the `pipeline correction
  attribute` sub-command dispatch and its registry entry (`mutatesGitHub: false`,
  `needsGhAuth: false`).
- `core/scripts/scoreboard.ts` — a recurrence aggregator that reads `correction_event` and
  `control_attribution` records, computes the recurrence metrics, joins attributions by
  `correction_key`, evaluates eligible post-control exposure, and renders the human/JSON/HTML
  sections; the `--corrections-by` flag validated like `--by`.
- `core/test/` — regression fixtures proving falling recurrence after a gate, continued
  recurrence after a documentation-only control, zero-exposure/insufficient-evidence, duplicate
  delivery, and control supersession/rollback.
- `plugin/` mirror regenerated. No state-machine edge, review verdict, blocking, or routing
  decision reads attribution or recurrence data — the scoreboard only reads, and attribution is
  an out-of-band audited command.

## Acceptance Criteria

Observable, falsifiable outcomes that make #501 done:

- [ ] A control proposal can be resolved with a durable `control_attribution` record linking
      `correction_key`, `control_type`, issue/PR, an effective commit or release, a timestamp,
      and a `disposition` of `implemented`, `human-owned`, `rejected`, or `superseded`.
- [ ] Attribution is written only by the explicit audited command; a test proves that closing an
      issue or merging an arbitrary PR writes no attribution and never marks a control effective.
- [ ] `pipeline scoreboard` reports, in human and `--json` form: total corrections, distinct
      correction classes, repeated-class count and rate, corrections per ready-to-deploy item,
      time-to-control, and recurrence after an attributed control.
- [ ] Correction metrics can be grouped by repository, stage, harness/model, source kind,
      failure class, and proposed/implemented control type via `--corrections-by`, validated like
      the existing `--by` flag.
- [ ] Post-control recurrence is evaluated only over subsequent eligible run exposure, and each
      attributed class is classified `recurred`, `no_recurrence_observed`, or
      `insufficient_post_control_evidence`; a zero-exposure class is never reported as
      `no_recurrence_observed`.
- [ ] The report shows rolling-window trends (via `--bucket`) and a top-still-recurring-classes
      list with sanitized evidence pointers.
- [ ] Replayed/duplicate `correction_id`s count once; malformed, partial, old-schema, and
      missing-attribution artifacts produce stable diagnostics rather than silent skew or crashes.
- [ ] The output claims temporal attribution and recurrence evidence only — never causality —
      and surfaces superseded and rolled-back controls rather than hiding them.
- [ ] The scoreboard remains read-only: it changes no issues, labels, branches, controls, or run
      artifacts.
- [ ] Regression fixtures prove: falling recurrence after a gate, continued recurrence after a
      documentation-only control, zero-exposure/insufficient-evidence handling, duplicate
      delivery, and control supersession; `npm run ci` is green and the `plugin/` mirror is
      regenerated and committed.
