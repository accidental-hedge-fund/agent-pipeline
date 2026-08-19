## Context

See `proposal.md` for why. Current law and code:

- `pipeline factory-release prepare` refuses
  `PIPELINE_FRG_ATTESTATION_KEY` and
  `PIPELINE_FRG_ATTESTATION_KEY_FILE` in its own process
  (`CANDIDATE_LOOP_DENIED_FRG_ENV`). That refuse stays. Candidate-loop
  spawn already sanitizes those vars. The wrapper process is a
  different leak: Buzz sources `~/.config/pipeline-supervisor/env`
  into Tugboat, then Tugboat calls prepare in that env.
- Living `tugboat-thin-ship` pack-done includes prepare status
  `awaiting_frg_attestation`. `classify_frg_pack_tick` prints `done`
  for that status. The pack-phase source test forbids attestor /
  HMAC markers. #1039 Decision 2 chose that on purpose: wait for
  `complete` would hide attestation and open the release PR inside
  pack.
- Factory-gate mints release-eligible `pass: true` only when
  `PIPELINE_FRG_ATTESTATION_KEY` is present. Without the key, prepare
  can still return `awaiting_frg_attestation` with unsigned artifacts.
  `pipeline release` then fail-closes on missing FRG.
- The 1.39.3 FRG pass was: prepare **without** the key; then
  `factory-gate --from-run` **with** the key in a separate process.
  v1.39.4 `playbook.log` 2026-08-18T19:57:30Z is the site:
  `FAIL: FRG pack failed (attempt 1)` because prepare refused
  `KEY_FILE`.

**Conflict (do not average):** #1039 pack-done law and
"pack phase SHALL NOT submit attestation" contradict #1133 and
contradict factory-reliability-gate "no key → no `pass: true`".
This change supersedes #1039 Decision 2. Unsigned wait is a
signal to run the attestor child, not pack-done.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is Tugboat v1.39.4 attempt 1 with
   inherited `KEY_FILE`, plus `classify_frg_pack_tick` treating
   `awaiting_frg_attestation` as done. The class is: a ship-path FRG
   pack composer that inherits production attestor env into prepare
   and treats unsigned wait as pack-done.
2. **Shared surfaces.** Uncredentialed prepare child, credentialed
   `factory-gate --from-run` attestor child, pack-done = bound
   `latest.json` `pass: true`. Law lives in `tugboat-thin-ship`,
   `supervisor-ship-playbook`, and `factory-reliability-gate`. Shared
   helpers (`frg-pack-helpers.sh` / inlined Tugboat copies) stay in
   sync. No new human-authority class: prepare-refuse-on-KEY is an
   engine compose defect, not `needs-human`.
3. **Next identical fault.** Any later supervisor that sources
   `KEY_FILE` still packs, because compose always unsets for prepare
   and always signs in the attestor child. Tests fail if prepare
   inherits `KEY_FILE` or if awaiting is pack-done. No new mole
   issue.

## Goals / Non-Goals

**Goals:**

- Per-process env isolation: prepare child uncredentialed; attestor
  child credentialed.
- Pack-done only on bound `latest.json` `pass: true` (or complete +
  open release PR).
- Keep Tugboat a thin composer of existing CLI verbs.
- Same compose on the installed playbook copy.

**Non-Goals:**

- `--skip-frg` as the ship path.
- Persisting the key body in `state.json`.
- Changing prepare's refuse of attestor env.
- Waiting for prepare `status: "complete"` as pack-done (that tick
  still opens the release PR after attestation).
- A second pack runner, grant factory, or `pipeline ship` product
  path inside Tugboat.
- Expanding in-engine `pipeline ship` FRG auto-generate in this
  change (ship-adapter already names the attestor-then-retry
  protocol; Tugboat/playbook is the live Buzz path).

## Decisions

### 1. Unset attestor env only in the prepare child

**Choice:** Invoke prepare as a subprocess whose environment deletes
`PIPELINE_FRG_ATTESTATION_KEY` and
`PIPELINE_FRG_ATTESTATION_KEY_FILE` (equivalent: `env -u` those
names). Do not unset them in the Tugboat parent, or the attestor
child would lose the credential.

**Why:** Prepare must not see the key. The attestor child must.
Parent supervisor env can keep `KEY_FILE`.

**Alternatives considered:**

- Unset in the parent before pack, restore after → rejected; a
  crash leaves the parent without the key, and it is easy to
  forget restore.
- Teach prepare to ignore inherited `KEY_FILE` → rejected; the
  refuse is the production-owned attestor contract. Do not weaken
  it so a wrapper can hold the secret in-process.

### 2. Attestor compose is `factory-gate --from-run` in a child env

**Choice:** When prepare returns `awaiting_frg_attestation` (or
unsigned eligible artifacts exist and bound `pass: true` is
missing), run:

`pipeline factory-gate --for <X.Y.Z> --from-run <loop>`

with no `--observations`. `<loop>` comes from prepare JSON
(`loop_run_id` or `frg.loop_run_id`). The child inherits / presents
the producer key. Tugboat does not implement HMAC, a grant factory,
or a second scorer.

When the supervisor supplied only `KEY_FILE`, the attestor child
SHALL present that file as `PIPELINE_FRG_ATTESTATION_KEY` (factory-gate
today loads the body env, not the file path). The file contents go
into that child env only, never into `state.json`.

**Why:** That is the 1.39.3 hand path. Factory-gate already mints
the MAC when the key is present. Prepare already scored unsigned
artifacts without the key.

**Alternatives considered:**

- Re-invoke prepare after a human attests → rejected; that is the
  current stall. #1133 requires no human unset.
- Wait for prepare `complete` → rejected; that opens the release PR
  inside pack and needs attestation Tugboat must not own as a
  signer.
- Put the key into prepare so in-process scoring mints `pass: true`
  → rejected; prepare refuses that env so the candidate loop cannot
  inherit the secret.

### 3. Classifier: awaiting without bound pass:true is not done

**Choice:** Change `classify_frg_pack_tick` so
`awaiting_frg_attestation` without matching `latest.json`
`pass: true` is **not** `done`. Introduce an `attest` (or
equivalent) verdict so the wait loop runs the attestor child
instead of sleeping as `in_progress` or succeeding as `done`. After
the attestor child exits, re-read `latest.json` and require bound
`pass: true` for pack-done. `pass: false` remains fail-before-success.
Keep helper text in sync between `tugboat.sh` and
`frg-pack-helpers.sh`.

**Why:** Mapping awaiting → `retry` would spin prepare without
signing. Mapping awaiting → `done` is the bug.

**Alternatives considered:**

- Keep awaiting as done and hope release fail-closes → rejected;
  v1.39.4 already died at pack because prepare refused, and even a
  successful unsigned wait would fail later at release.
- Inline attestor in `ship_one` and leave classify treating
  awaiting as done → rejected; the classifier is the tested
  pack-done gate and would still lie.

### 4. Missing attestor credential is pack-fail, not skip-frg

**Choice:** If unsigned artifacts exist and the attestor child has
no producer credential, fail the frg-pack phase with a named
reason. Do not pass `--skip-frg`. Do not park as `needs-human`.

**Why:** Missing supervisor key is a compose/config defect. Skip
remains an explicit logged operator escape.

### 5. Docs follow pack-done = bound pass:true

**Choice:** Update `docs/runbooks/ship-milestone.md` (and Hermes
skill pack-done text if it still lists `awaiting_frg_attestation`
as pack-done). Default sequence stays train → FRG pack → release.
Pack-done text SHALL name bound `latest.json` `pass: true` and the
out-of-process attestor.

**Why:** Operators copying the runbook would recreate #1039
Decision 2.

## Risks / Trade-offs

- **[Risk] Attestor child leaks the key into logs or state.json.** →
  Mitigation: spec and tests forbid the key body in `state.json`.
  Capture attestor stderr as today; do not echo the env. Do not
  write `KEY` / `KEY_FILE` contents into request JSON (already
  forbidden).
- **[Risk] Factory-gate `--from-run` with the key re-scores and
  flips a fail to pass.** → Mitigation: persist already refuses
  rewriting `pass: false` to `pass: true`. Classifier still
  fail-closes on `pass: false` before success.
- **[Risk] Stale installed `~/.local/bin/tugboat` keeps the old
  classifier.** → Mitigation: existing install-parity / doctor
  refresh path. This change does not add a new doctor check unless
  implementation needs one to bite the old awaiting-is-done binary.
- **[Trade-off] Tugboat now composes factory-gate.** Thinness still
  holds: one existing CLI verb, no second scorer. Update the pack
  source assertion that currently forbids attestor markers so it
  allows `factory-gate --from-run` and still forbids grant-factory /
  key-in-state / invent-pass.

## Migration Plan

1. Land composer + helper + test + docs on this branch. No engine
   schema change is required.
2. Operators refresh `~/.local/bin/tugboat` and, if installed,
   `pipeline-ship-playbook` / `frg-pack-helpers.sh` from
   `examples/supervisor/shell/`.
3. Next `Ship milestone` after train-complete runs uncredentialed
   prepare, then credentialed `factory-gate --from-run`, then
   release when `latest.json` is bound `pass: true`.

Rollback: revert the composer/docs change. Pack-done would again
treat awaiting as success and prepare would again inherit
`KEY_FILE`. That is the defect.

## Open Questions

None that block specs or tasks. Verdict string (`attest` vs
another token) is an implementation detail as long as awaiting
without bound `pass: true` is not `done`.
