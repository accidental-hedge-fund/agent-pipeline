## Why

`Ship milestone v1.39.5` finished its Factory Reliability Gate (FRG) pack
loop clean (#1143 and #1144 `ready-to-deploy`, composition all pass).
`factory-release prepare` then scored without the HMAC key (correct:
uncredentialed candidate process). It wrote
`.agent-pipeline/frg/1.39.5/latest.json` with `pass: false` and note
`release-eligible attestation omitted`. Prepare returned `status: failed`
and `defect_class: frg_not_eligible`. Tugboat classified `pass: false`
as pack-fail before `awaiting_frg_attestation` / attestor. It never ran
`factory-gate --from-run`. A later out-of-process attestor produced
`pass: true` with HMAC on candidate `a949c581`. The pack was eligible.
Classify was wrong. #1133 unset KEY on prepare and added an `attest`
path. It does not cover this unsigned `pass: false` shape.

## What Changes

- **Prepare treats omitted HMAC as attestation wait.** When the bound pack
  is terminal, scoreboard and composition are structurally eligible, and
  the only missing piece is HMAC, `pipeline factory-release prepare` SHALL
  return `status: "awaiting_frg_attestation"` with unsigned artifact
  identities. It SHALL NOT return `status: "failed"` or
  `defect_class: "frg_not_eligible"` for that case.
- **Tugboat attests unsigned eligible `pass: false`.** Shared pack-tick
  classify (`classify_frg_pack_tick` in Tugboat and `frg-pack-helpers.sh`)
  SHALL emit `attest` for that tick. It SHALL run
  `pipeline factory-gate --for <X.Y.Z> --from-run <bound-loop>` in a
  **separate** child that has `PIPELINE_FRG_ATTESTATION_KEY`. It SHALL NOT
  pass KEY/KEY_FILE into prepare.
- **Omitted-attestation `pass: false` is not pack-fail.** Pack-fail stays
  for real ineligible scoreboards (composition missing, required scenarios
  fail, wrong pack, engine-class over threshold).
- **Pack-done still requires attested pass.** Pack-done SHALL require
  `latest.json` `pass: true` bound to the request candidate SHA (and
  version; and `action_id` when recorded), or prepare `status: "complete"`
  with an open release PR. Unsigned wait is not pack-done.
- **Class law, not a 1.39.5 mole.** The next `Ship milestone` after a
  terminal eligible pack SHALL finish FRG pack without a human attestor
  command.

**BREAKING** for any host or test that treats unsigned eligible
`latest.json` `pass: false` as pack-fail, or that treats prepare
`failed` / `frg_not_eligible` as the honest outcome when HMAC is the
only missing piece. This **supersedes** the #1039 / #1133 clause that
evaluates any `pass: false` before `awaiting_frg_attestation`.

Non-goals: `--skip-frg` as the ship path; committing `.agent-pipeline/frg/`
(gitignored by #1127); putting the key body into Tugboat `state.json`;
claiming unsigned `pass: true`.

## Acceptance criteria

- [ ] When the bound pack is terminal, scoreboard/composition are
      structurally eligible, and HMAC is the only missing piece, prepare
      returns `status: "awaiting_frg_attestation"` and does not return
      `status: "failed"` or `defect_class: "frg_not_eligible"`.
- [ ] Tugboat classify emits `attest` for that tick (unsigned eligible
      `latest.json` `pass: false`, or prepare `awaiting_frg_attestation`
      with that unsigned `pass: false`). It does not emit `fail`.
- [ ] The attestor child is `pipeline factory-gate --for <X.Y.Z>
      --from-run <bound-loop>` in a process other than prepare. That
      child has `PIPELINE_FRG_ATTESTATION_KEY`. Prepare still has
      KEY/KEY_FILE unset.
- [ ] Real ineligible scoreboards still pack-fail (`frg_not_eligible` /
      classify `fail`). Omitted-HMAC `pass: false` is not that class.
- [ ] Pack-done requires `latest.json` `pass: true` bound to the request
      candidate SHA. Unsigned wait is not pack-done.
- [ ] A unit/tugboat test fails if unsigned eligible `pass: false` is
      classified `fail`, or if prepare reports `failed` for omitted HMAC
      only. The test injects fixtures and does not start a live pack.
- [ ] A second `Ship milestone` after pack-loop complete finishes FRG
      pack without a human attestor command.
- [ ] `--skip-frg` remains an operator escape. It is not the default
      ship path. The composer does not write the key body into
      `state.json`.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same
      change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat, playbook, FRG, prepare, and ship-coordinator law. -->

### Modified Capabilities

- `tugboat-thin-ship`: pack-tick classify and pack-fail law. Unsigned
  eligible `pass: false` is `attest`, not fail-close. Any-`pass: false`
  first is superseded for omitted HMAC only.
- `supervisor-ship-playbook`: shared pack helpers stay in sync with
  Tugboat. Same unsigned-eligible `attest` classify.
- `factory-reliability-gate`: structural eligibility vs attested
  `pass: true`. Ship-path composers treat omitted-HMAC unsigned
  evidence as attestor input, not pack-fail. Real ineligible
  scoreboards stay fail-closed.
- `release-sub-command`: `factory-release prepare` returns
  `awaiting_frg_attestation` when the terminal pack is structurally
  eligible and HMAC is omitted. It does not map that case to
  `failed` / `frg_not_eligible`.
- `ship-coordinator`: in-engine `pipeline ship` applies the same
  class. Prepare `failed` for omitted HMAC only is not pack-fail.

## Impact

- `core/scripts/factory-release-prepare.ts` — terminal-score eligibility
  and public JSON status when HMAC is omitted.
- `core/scripts/factory-reliability-gate.ts` — structural eligibility
  must not treat attested-`pass: false` as structural fail when HMAC is
  the only missing piece.
- `examples/supervisor/shell/tugboat.sh` and
  `examples/supervisor/shell/frg-pack-helpers.sh` —
  `classify_frg_pack_tick` order and omitted-HMAC discriminator.
- `core/scripts/stages/ship-adapter.ts` — in-engine pack tick if prepare
  `failed` is still the observed shape; same class as Tugboat.
- Tests: `core/test/factory-release-prepare.test.ts`,
  `core/test/tugboat.test.ts`, and ship-adapter classify tests.
- Docs: `docs/runbooks/ship-milestone.md`,
  `docs/factory-reliability-gate-runbook.md` if they still treat unsigned
  `pass: false` as pack-fail.
- Mirror: `plugin/` after any `core/` edit.
- No new CLI verb. No new env var. No grant schema. No merge-in-advance.
