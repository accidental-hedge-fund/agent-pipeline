## Why

Policy (#1036) and the bound pack generator (#1037) are on base, but no
post-1.33 version has an **honest** `.agent-pipeline/frg/<ver>/latest.json`
with `pass: true` from the automated pack driver. The 1.34 ship-kill was a
hard Factory Reliability Gate (FRG) with no pack. Flipping Tugboat /
`release` off `--skip-frg` without that proof recreates the same kill.
Parent tracker: #1035.

This is a **class** gate, not a one-release mole. The class is: a ship-path
`--skip-frg` default restore SHALL stay blocked until a machine-checkable
honest post-1.33 FRG pass exists from `factory-gate --from-run` of a
request-bound **candidate** pack. The next identical flip request uses that
same checker. It does not need a new mole issue.

## What Changes

- **Produce one honest post-1.33 FRG pass.** Run the #1037 bound pack path
  (`factory-release prepare` → candidate-track `factory-gate` loop →
  `factory-gate --for <ver> --from-run <loop_run_id>`) against a **candidate**
  engine. Do **not** use the product v1.39 milestone work-list.
- **Honest `latest.json` contract.** The written
  `.agent-pipeline/frg/<ver>/latest.json` SHALL have `pass: true`, a real
  `run_id` / `frg_run_id`, a candidate git SHA, required-live ids that are
  not `not_observed`, and Layer A-allowed ids (if used) proven only by TAP
  hashes bound to that candidate SHA. Hybrid v2 from #1036 applies. No
  hand-edited `--observations` file.
- **Cite evidence on #1038.** A comment on this issue SHALL name the
  evidence path and `frg_run_id`.
- **No-waive.** If the pack cannot pass honestly, this issue stays open.
  A fail `latest.json` SHALL remain `pass: false`. The Tugboat child
  (#1039) SHALL NOT start from a waiver.
- **Keep `--skip-frg` as the default.** This change does not flip Tugboat,
  auto-tag, or pin defaults. It only records the honest-pass precondition
  those later children consume.

## Acceptance Criteria

- [ ] A post-1.33 `.agent-pipeline/frg/<ver>/latest.json` exists with
      `pass: true` produced by `factory-gate --for <ver> --from-run
      <bound-loop_run_id>` (or the in-process equivalent). The score path
      does not pass `--observations`.
- [ ] That artifact names a non-empty `run_id` / `frg_run_id`, a candidate
      git SHA, a non-empty bound `loop_run_id`, and pack identity
      `factory-gate-v1`.
- [ ] Required-live ids (`clean-item-throughput`, `blocker-taxonomy`,
      `empty-depends-on-stack-honesty`, and the required OpenSpec-bearing
      composition item) are not `not_observed`.
- [ ] Layer A-allowed ids, if used, cite TAP hashes bound to the same
      candidate SHA. Unknown `layer_a` ids are refused.
- [ ] The scored work-list is the request-bound candidate pack, not the
      product v1.39 milestone.
- [ ] A comment on issue #1038 cites the evidence path and `frg_run_id`.
- [ ] A fail score does not rewrite `pass: true`, does not close this
      issue, and does not unlock the Tugboat `--skip-frg` flip (#1039).
- [ ] A machine-checkable honest-pass helper (wrapping
      `isReleaseEligibleFrgPass` plus the post-1.33 / from-run / no-
      observations checks) returns true only for that contract. Unit tests
      bite the fail cases (pre-1.33-only, `not_observed` required-live,
      missing TAP, fabricated observations, product-milestone work-list)
      and fail without the production check. Tests inject I/O.
- [ ] Tugboat, auto-tag, and pin defaults are unchanged. Default
      `--skip-frg` remains until #1039 consumes this precondition.
- [ ] `plugin/` is regenerated after any `core/` edit. `npm run ci` is
      green.

## Capabilities

### New Capabilities

<!-- None. This extends existing FRG and Tugboat law. -->

### Modified Capabilities

- `factory-reliability-gate`: A ship-path `--skip-frg` default restore
  SHALL stay blocked until one post-1.33 honest `latest.json` `pass: true`
  exists from `--from-run` of a request-bound candidate pack. Required-live
  SHALL not be `not_observed`. Layer A-allowed SHALL cite candidate-SHA
  TAP hashes. Fail stays fail. Evidence path + `frg_run_id` SHALL be cited
  on the tracking issue.
- `tugboat-thin-ship`: The thin composer SHALL keep its current default
  `--skip-frg` policy until that honest-pass precondition is satisfied.
  This change does not add the later FRG pack phase.

## Impact

- **Specs:** deltas on living `factory-reliability-gate` and
  `tugboat-thin-ship`. Hybrid v2 scoring and the #1037 generator stay as
  they are. This change adds the dogfood proof and the skip-frg restore
  precondition those later children read.
- **Code (implementation, not this proposal step):** a machine-checkable
  honest-pass helper next to `isReleaseEligibleFrgPass` in
  `core/scripts/factory-reliability-gate.ts`; tests in
  `core/test/factory-reliability-gate.test.ts` (or a sibling). Operational
  run of `factory-release prepare` on a candidate engine to write
  `.agent-pipeline/frg/<ver>/latest.json`. Comment on #1038. Regenerate
  `plugin/` after any core edit.
- **Docs:** `docs/factory-reliability-gate-runbook.md` states that the
  Tugboat `--skip-frg` default stays until this honest pass exists.
- **Depends on:** #1037 (bound pack generator on base). Policy #1036 is
  already on base. Parent tracker #1035. Blocks #1039.
- **Does not:** change Tugboat default / `--skip-frg`; auto-tag or pin
  `no-frg-*`; accept fabricated observations; score a product milestone
  as FRG; add merge/tag/promote/install authority; add live process-kill
  or forge-5xx injection.
