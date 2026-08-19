# #1133 Revised plan — Tugboat FRG pack unsets attestor env and signs outside prepare

## Status

- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [x] Implementation
- [x] Tests (CLI-stub first; prove they fail on current compose)
- [x] Docs + OpenSpec task/design precision
- [x] `node scripts/build.mjs` if any `core/` file changes (test-only; no plugin regen)
- [x] `npm run ci`

## Locked decisions (post plan-review)

1. Prepare child: `env -u PIPELINE_FRG_ATTESTATION_KEY -u PIPELINE_FRG_ATTESTATION_KEY_FILE`. Parent keeps supervisor env.
2. Attestor child: only `PIPELINE_FRG_ATTESTATION_KEY`. Read `KEY_FILE` in memory when `KEY` is absent. Unset `KEY_FILE` in that child. Never write the key body to `state.json`, request JSON, or logs.
3. Classifier: `awaiting_frg_attestation` without bound `latest.json` `pass: true` prints `attest`, not `done`.
4. `loop_run_id` comes only from the parsed prepare result. Missing or empty id is pack-fail. Do not attest `in_progress`. Do not pick an unbound newest loop.
5. After attestor, re-read `latest.json`. Pack-done requires bound `pass: true` (or `complete` + verified open matching release PR). Attestor success without a valid bound artifact is pack-fail.
6. Tests are a runnable PATH stub of `pipeline`, not source-only greps. Source sync stays as a second check.
7. Playbook source is `examples/supervisor/shell/pipeline-ship-playbook.sh` plus sibling `frg-pack-helpers.sh`. Install is a copy to `~/.local/bin`, not a generated mirror.
