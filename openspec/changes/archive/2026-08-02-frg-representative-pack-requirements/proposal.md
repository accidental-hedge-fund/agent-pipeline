## Why

The first mandatory FRG pass (v1.29.1) was minted from two synthetic comment-only pack items
(#749/#750) with `Engine-class rate: n/a`, proving only that the release machinery can tag—not
that the factory is reliable. None of the failure classes that broke v1.29.0 (OpenSpec archive
coherence, worktree capacity cascade, CI recovery, review-fix cycles) are reachable from
comment-only items, and `auto-tag-release.yml` does not check FRG evidence at all, so a
hand-authored release commit can bypass the gate. This change strengthens the gate so a
release-eligible FRG pass requires a representative pack, a always-computable engine-class rate,
a release-over-release trend ledger, scenario observations via a documented CLI surface, and a
tag-path FRG guard.

## What Changes

- **Representative pack composition (release-eligible gate)** — enforce that a release-eligible
  FRG pass exercises a real OpenSpec-bearing item, a real blocking-finding → fix → re-review
  cycle, concurrency N≥2 with worktree contention, and the recovery/composition classes called
  out in the #757 reconciliation upserts (managed worktree dirt/missing, process death +
  restart/hydration, forge HTTP 5xx with bounded backoff, pending/red CI recovery, same-HEAD
  no-op re-entry, concurrent capacity + live-run coexistence). Clean-only comment packs (#749/
  #750 class) SHALL NOT yield release-eligible pass; migrate operators off those fixtures.
- **Computable engine-class rate** — when ≥1 pack item was processed, `engine_class_rate` SHALL
  be a defined number in `[0, 1]`, never `null` / `n/a`. Spec defines the denominator (processed
  pack items). Zero engine-class outcomes report `0`, not “not applicable.”
- **FRG trend ledger** — each scored Layer B evidence run appends a durable release-over-release
  record so K and the max engine-class rate become empirically reviewable. Runbook documents how
  current bootstrap values (K=2, max rate 25%) were derived and that changing them is out of
  scope until the ledger accumulates history.
- **Tag-path FRG guard** — `auto-tag-release.yml` SHALL verify a passing FRG evidence artifact
  for the version being tagged before creating/pushing the tag (closes the hand-authored release
  commit bypass).
- **Scenario observation CLI** — live scenario observations SHALL be supplyable through a
  documented `pipeline factory-gate` CLI surface (flags and/or observation file); ad-hoc
  in-process module scripting is not the operator path.
- **Waiver refresh** — Layer A waivers that cite closed issues (notably `release-plan-row` →
  closed #730) SHALL be refreshed: either a biting hermetic test lands or the waiver points at a
  still-open tracking issue.
- **#787 controller exercise** — the representative pack SHALL drive the production autonomous
  recovery controller through one-item and multi-item entry points; recovery success, exhaustion,
  resumes, and elapsed time by canonical reason code feed the computable engine-class rate and
  trend ledger. Release-eligible pass requires zero false `human_authority` / product-judgment
  projections and bounded convergence for every injected recoverable class.

**BREAKING** (for operators of FRG, not for product consumers): release-eligible FRG evidence
that would previously pass with only clean comment-only items and/or `engine_class_rate: null`
will fail under the strengthened criteria. Threshold *values* (K=2, 25%) are **not** changed in
this issue.

## Acceptance Criteria

- [ ] Release-eligible FRG evidence for a pack that contains only comment-only / clean no-op
      items (no OpenSpec change, no fix→re-review cycle, no N≥2 capacity stress) is rejected
      (`pass: false` or refused as non-representative), with a machine-readable reason naming the
      missing composition dimensions.
- [ ] A release-eligible pass requires observed evidence that the pack included: (a) ≥1 item that
      carried a real OpenSpec change through archive/coherence paths, (b) ≥1 item that traversed a
      blocking finding → fix → re-review cycle, and (c) concurrent run with worktree contention at
      N≥2 (`capacity_stress_n` or equivalent observed concurrency).
- [ ] When `scoreboard.item_count ≥ 1`, `scoreboard.engine_class_rate` is a number in `[0, 1]`
      (never `null`); FRG PR section and CLI output never print `Engine-class rate: n/a` for such
      runs. Denominator is documented in the living/spec runbook as processed pack item count.
- [ ] Each successful Layer B evidence write appends a trend-ledger entry keyed by version and
      `run_id` (immutable append; prior entries retained). Operators can inspect release-over-
      release K, ready-clean counts, engine-class rate, and recovery aggregates without
      reconstructing history by hand.
- [ ] FRG runbook documents derivation of current K=2 and max engine-class rate 0.25 as
      bootstrap/provisional values (not empirically derived from multi-release trend data) and
      states that tightening values is a follow-on once the ledger has history.
- [ ] On a detected release merge, `auto-tag-release.yml` fails closed (no tag push) when FRG
      evidence for that version is missing, unparsable, or `pass: false`; succeeds only when a
      release-eligible pass artifact for that version is present and validated.
- [ ] Scenario observations for required non-auto-scored pack scenarios can be supplied via a
      documented CLI flag/file on `pipeline factory-gate` (runbook names the surface); unit tests
      cover the parsing path without ad-hoc module imports from operators.
- [ ] Layer A waiver inventory no longer cites closed #730 for `release-plan-row` (test lands or
      open tracking issue); other closed-issue waivers are similarly refreshed.
- [ ] Representative pack inventory (runbook + driver) names recovery/composition classes for
      missing/dirty managed worktrees, process death + restart/hydration, forge HTTP 5xx bounded
      backoff, pending/red CI recovery, same-HEAD no-op re-entry, concurrent capacity pressure and
      live-run coexistence, and production #787 controller paths (one-item and multi-item).
- [ ] Release-eligible pass requires zero false product-judgment / `human_authority` projections
      for injected recoverable classes, and bounded convergence (or typed exhaustion feeding the
      engine-class scoreboard) for each injected class; recovery aggregates appear on the scoreboard
      and/or trend ledger.
- [ ] Legacy clean-only pack issues #749/#750 are closed or explicitly retired in the runbook as
      non-representative fixtures (migration note).
- [ ] `npm run ci` green; `plugin/` regenerated when `core/` changes land (implementation phase).
- [ ] No auto-merge path is introduced; FRG still never merges or creates tags as a side effect of
      scoring (tag remains `auto-tag-release.yml` / human release ownership).

## Capabilities

### New Capabilities

_(none — strengthens existing FRG and auto-tag capabilities)_

### Modified Capabilities

- `factory-reliability-gate`: Representative pack composition requirements; computable
  engine-class rate with defined denominator; trend ledger; scenario-observation CLI surface;
  waiver refresh; recovery-class inventory and #787 controller exercise feeding scoreboard/ledger;
  rejection of clean-only packs for release-eligible pass.
- `release-auto-tag-on-merge`: Tag path SHALL verify passing FRG evidence for the version before
  creating/pushing the annotated tag.

## Impact

- **Specs:** deltas on `factory-reliability-gate` and `release-auto-tag-on-merge`.
- **Code (implementation phase, not this proposal step):** `core/scripts/factory-reliability-gate.ts`
  scoring/validation; CLI options on `pipeline factory-gate`; trend ledger write path under
  `.agent-pipeline/frg/`; Layer A tests + waiver inventory; `.github/workflows/auto-tag-release.yml`
  + drift-guard tests; `docs/factory-reliability-gate-runbook.md`; `plugin/` mirror regen.
- **Process:** operators retire #749/#750-style fixtures; every release Layer B must use a
  representative pack; auto-tag fails without FRG pass even if release PR was hand-crafted.
- **Does not:** change K or max engine-class rate numeric values; re-scope synthetic pack
  auto-close (#754); auto-merge; replace product milestones with FRG.
- **Siblings / context:** follow-on to #723/#735; reconciliation upserts 2026-07-31 and
  post-#787 2026-08-01; out-of-scope threshold tightening once trend data exists.
