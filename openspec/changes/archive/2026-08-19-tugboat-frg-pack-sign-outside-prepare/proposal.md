## Why

`Ship milestone v1.39.4` train completed four items, then FRG pack failed on
attempt 1. Buzz supervisor sources `~/.config/pipeline-supervisor/env`, which
sets `PIPELINE_FRG_ATTESTATION_KEY_FILE`. Tugboat invokes
`pipeline factory-release prepare` in that same process environment. Prepare
refuses both `PIPELINE_FRG_ATTESTATION_KEY` and
`PIPELINE_FRG_ATTESTATION_KEY_FILE` so a production-owned attestor can sign
outside that process. Tugboat then treats `awaiting_frg_attestation` as
pack-done without `.agent-pipeline/frg/<X.Y.Z>/latest.json` `pass: true`.
There is no attestor step (`factory-gate --from-run` with the key in a
**separate** process). Release then fail-closes on missing FRG. The 1.39.3
pass was a human unset-and-sign. That is not the Tugboat path.

## What Changes

- **Prepare child is uncredentialed.** Tugboat and the installed
  `pipeline-ship-playbook` copy SHALL invoke
  `pipeline factory-release prepare` with `PIPELINE_FRG_ATTESTATION_KEY` and
  `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in **that child**. The parent
  supervisor env MAY keep the credential. The composer SHALL NOT persist the
  key body in `state.json`.
- **Attestor is a separate process.** When prepare returns
  `awaiting_frg_attestation` (or unsigned eligible artifacts exist for the
  bound request), the composer SHALL run
  `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a child
  environment that has the producer credential. It SHALL NOT pass
  `--observations`. It SHALL NOT run that attestor inside the prepare
  process.
- **Pack-done requires attested pass.** Pack-done SHALL mean
  `latest.json` `pass: true` bound to the request `target_version` and
  `integrated_candidate.git_sha` (and `action_id` when the artifact records
  one), or prepare already returned `status: "complete"` with an open
  release PR for that version. `awaiting_frg_attestation` alone SHALL NOT
  be pack-done. This **supersedes** #1039 Decision 2.
- **Class law, not a 1.39.4 mole.** The next supervisor that sources
  `KEY_FILE` SHALL finish FRG pack without a human unsetting env.
- **Tests bite.** A Tugboat/unit test SHALL fail if prepare is invoked
  with `KEY_FILE` (or `KEY`) set, or if pack-done is declared without a
  matching `pass: true` `latest.json`.

**BREAKING** for any host or test that still treats prepare status
`awaiting_frg_attestation` as pack-done, or that invokes prepare with
attestor env inherited from the supervisor.

Non-goals: `--skip-frg` as the ship path; putting the key body into
Tugboat `state.json`; a second pack runner, grant factory, or
`pipeline ship` product path inside Tugboat; changing prepare's refuse of
attestor env (that refuse stays).

## Acceptance criteria

- [ ] Tugboat and the installed `pipeline-ship-playbook` invoke
      `pipeline factory-release prepare` with `PIPELINE_FRG_ATTESTATION_KEY`
      and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in the prepare child.
- [ ] When prepare returns `awaiting_frg_attestation` (or unsigned eligible
      artifacts exist for the bound request), the composer runs
      `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a child
      env that has the producer credential and **not** in the prepare
      process.
- [ ] Pack-done requires `latest.json` `pass: true` bound to the request
      candidate SHA (and version; and `action_id` when recorded).
      `awaiting_frg_attestation` alone is not pack-done.
- [ ] A Tugboat/unit test fails if prepare is invoked with `KEY_FILE` or
      `KEY` set in that child, or if pack-done is declared without a
      matching `pass: true` `latest.json`.
- [ ] A second `Ship milestone` after train-complete can finish FRG pack
      without a human unsetting attestor env.
- [ ] The composer does not write the key body into `state.json`.
- [ ] `--skip-frg` remains an operator escape with a logged reason. It is
      not the default ship path.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change.
      `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat, playbook, and FRG law. -->

### Modified Capabilities

- `tugboat-thin-ship`: Replace pack-done so `awaiting_frg_attestation`
  alone is not success. Prepare SHALL run with attestor env unset.
  After unsigned artifacts exist, Tugboat SHALL compose
  `factory-gate --from-run` in a separate credentialed child. Pack-done
  SHALL require bound `latest.json` `pass: true` (or complete with an
  open release PR). Tugboat SHALL NOT persist the key body in
  `state.json`.
- `supervisor-ship-playbook`: The installed alternate playbook SHALL
  use the same uncredentialed-prepare + out-of-process attestor +
  `pass: true` pack-done compose. It SHALL NOT keep a second pack
  protocol that treats unsigned wait as done.
- `factory-reliability-gate`: Ship-path pack composers SHALL keep
  production attestation out of the prepare process. Unsigned
  `awaiting_frg_attestation` SHALL NOT be release-eligible pack-done.
  The next identical supervisor-env fault SHALL not need a new mole
  issue.

## Impact

- **Composers:** `examples/supervisor/shell/tugboat.sh`,
  `examples/supervisor/shell/pipeline-ship-playbook.sh`, and shared
  `examples/supervisor/shell/frg-pack-helpers.sh`
  (`classify_frg_pack_tick` and the prepare/attestor invoke helpers).
- **Tests:** `core/test/tugboat.test.ts` (and any playbook source
  assertion that currently treats `awaiting_frg_attestation` as done or
  forbids `factory-gate` in the pack phase). Tests inject I/O / inspect
  source or fixtures. They start no live pack.
- **Docs / skill:** `docs/runbooks/ship-milestone.md` pack-done
  paragraph; FRG runbook ship-path attestor sequence if it still says
  unsigned wait is pack-done.
- **Engine:** Prepare's `CANDIDATE_LOOP_DENIED_FRG_ENV` refuse stays.
  Factory-gate already mints HMAC when `PIPELINE_FRG_ATTESTATION_KEY` is
  present. Do not add `--skip-frg` as the ship path. Do not put the key
  body in Tugboat state.
- **Depends on:** living #1037 prepare protocol and #1039 pack phase
  (this change corrects pack-done and adds the missing attestor compose).
- **Does not:** authorize merge/tag/promote/install in the pack phase;
  invent `pass: true`; add a grant factory or second pack runner;
  reverse papercut backlog policy (#538).
