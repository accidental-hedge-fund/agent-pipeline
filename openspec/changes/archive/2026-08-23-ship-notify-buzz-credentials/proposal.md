## Why

Ship v1.40.0 from Buzz started Tugboat and a live `--events-file` watch. Local `stage-watch.log` recorded `#1048 planning`. The Buzz channel got no stage posts. `ship-notify.sh` wrote a dedupe file and then `exit 0` because `BUZZ_CREDENTIALS_FILE` was unset. There was no `audit.log` line and no `failed/` marker. Operators saw a live watch and an empty channel.

Live Tugboat and watch processes had `BUZZ_BIN` and `BUZZ_CHANNEL`. They did not have `BUZZ_CREDENTIALS_FILE` or `BUZZ_RELAY_URL`. Those values live in `~/.config/pipeline-supervisor/env`. Hermes started the ship without that file path. Tugboat does not source the supervisor env. Watch spawn `env` already lists `PIPELINE_MATERIAL_FILTER` and does not list the Buzz credential vars. A catch-up watch with supervisor env sourced delivered `#1048` planning on the same messenger and channel.

This is why v1.39.9–v1.40.0 Tugboat `tug-*-train-running` / `tug-detach` markers exist on disk with no matching `delivered` audit rows unless a human sourced the env.

## What Changes

- **Class law, not a v1.40.0 mole.** When Buzz is intended (`SHIP_NOTIFY=1` and `BUZZ_BIN` is executable) and `BUZZ_CHANNEL` / `BUZZ_CREDENTIALS_FILE` / relay cannot be resolved, `ship-notify` SHALL NOT silent-`exit 0` after writing a dedupe file. It SHALL append `audit.log` with status `fail` or `unconfigured` and a named reason. CI / unset-messenger hosts (`BUZZ_BIN` empty or not executable) MAY still no-op with no audit and no `failed/` marker.
- **Tugboat presents Buzz vars.** Tugboat SHALL present `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL` into `ship-notify` and into the stage-watch child when those values are set on the supervisor env file or the parent process. It SHALL NOT overwrite an operator-set value. Watch spawn SHALL pass the same Buzz vars the way `env` already passes `PIPELINE_MATERIAL_FILTER`.
- **Named missing-credentials log.** If `SHIP_NOTIFY=1` and `BUZZ_BIN` is executable and credentials cannot be resolved, Tugboat SHALL log a named line (`buzz credentials missing` or equivalent). Train/ship SHALL still continue. Notify remains best-effort.
- **Tests bite.** A unit test SHALL fail if `ship-notify` is invoked with `SHIP_NOTIFY=1`, executable `BUZZ_BIN`, `BUZZ_CHANNEL` set, and no credentials file, and `audit.log` has no fail/unconfigured row. A second test SHALL fail if Tugboat watch spawn env omits `BUZZ_CREDENTIALS_FILE` when the parent has it set to a readable file.

**BREAKING** for any fixture that treats executable `BUZZ_BIN` plus missing credentials or channel as a silent success with empty `audit.log`. Empty/`SHIP_NOTIFY=0` / non-executable `BUZZ_BIN` no-ops stay silent.

Non-goals: material-filter PATH (#1212); mislabeled `argv rejected` (#1213); in-engine check-wait (#1205); deleting Tugboat or rewriting #969 so Tugboat is not installed as owner; MessagingPort / ship-auth issuer (#966–#968); hand-starting `~/.local/bin/ship-stage-watch --milestone` as the product path; changing Buzz gateway allowlists; sourcing the entire supervisor env file into Tugboat (that can retarget `REPO_DIR`).

## Acceptance criteria

- [ ] `ship-notify` invoked with `SHIP_NOTIFY=1`, executable `BUZZ_BIN`, `BUZZ_CHANNEL` set, and no readable `BUZZ_CREDENTIALS_FILE` appends `audit.log` with status `fail` or `unconfigured` and a named reason. It does not `exit 0` after a dedupe write with no audit row.
- [ ] `ship-notify` invoked with `SHIP_NOTIFY=1` and empty or non-executable `BUZZ_BIN` still exits 0, does not send, and does not invent an audit row or `failed/` marker.
- [ ] Tugboat stage-watch spawn environment includes `BUZZ_CREDENTIALS_FILE` when the parent process has that var set to a readable file. The spawn does not overwrite an operator-set value.
- [ ] Tugboat presents `BUZZ_RELAY_URL` and `BUZZ_CHANNEL` into `ship-notify` and the stage-watch child when those values are set on the parent or the supervisor env file (`~/.config/pipeline-supervisor/env` or documented equivalent).
- [ ] When `SHIP_NOTIFY=1`, `BUZZ_BIN` is executable, and credentials cannot be resolved, Tugboat logs `buzz credentials missing` (or equivalent). Train/ship still continues.
- [ ] A unit test fails if the first criterion’s `audit.log` row is missing. A second unit test fails if watch spawn env omits `BUZZ_CREDENTIALS_FILE` while the parent has a readable file. Tests inject fakes. They do not start a live train, live messenger, or live ship.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This tightens existing notify observability and Tugboat/adapter env presentation. -->

### Modified Capabilities

- `supervisor-ship-notify`: Split “unconfigured messenger” from “Buzz intended, credentials missing.” Empty or non-executable `BUZZ_BIN` remains a silent no-op. Executable `BUZZ_BIN` with missing channel, credentials file, or relay SHALL write an `audit.log` fail/unconfigured row with a named reason. Living “no invented `failed/` marker solely because the messenger is unconfigured” stays for the empty-`BUZZ_BIN` path. Notify remains best-effort (exit 0). Delivery still SHALL NOT fail the ship.
- `tugboat-thin-ship`: Tugboat SHALL present `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL` into `ship-notify` and the stage-watch child from parent env or the supervisor env file, without overwriting operator-set values. Watch spawn SHALL pass those Buzz vars the same way it already passes `PIPELINE_MATERIAL_FILTER`. Missing resolvable credentials while Buzz is intended SHALL log `buzz credentials missing` (or equivalent) and SHALL NOT fail train/ship. A regression test SHALL fail if watch spawn omits `BUZZ_CREDENTIALS_FILE` when the parent has a readable file.
- `host-neutral-progress-notify`: A ship progress adapter that posts through `ship-notify` SHALL present Buzz credential vars into that helper and into the bundled stage-watch child when they are set on the supervisor env or parent. It SHALL NOT overwrite an operator-set value. Silent intended-Buzz no-op is not the product path.

Issue #1221 named `tugboat-thin-ship` / `host-neutral-progress-notify`. Living `supervisor-ship-notify` currently legalizes silent no-op when channel or credentials are missing (`Scenario: No-op configuration does not invent failure markers`). Omitting that delta would leave contradictory living law. All three are the class surface.

## Impact

- **ship-notify:** `examples/supervisor/shell/ship-notify.sh` (~lines 96–102). After a dedupe write, intended Buzz with missing credentials/channel/relay writes audit instead of silent `exit 0`. Empty `BUZZ_BIN` stays silent. Tests in `core/test/ship-notify.test.ts`.
- **Tugboat:** `examples/supervisor/shell/tugboat.sh` `notify` and `start_train_stage_watch`. Present Buzz vars. Log `buzz credentials missing` when intended Buzz cannot resolve credentials. Do not source the whole supervisor env file. Do not fail the ship. Tests in `core/test/tugboat.test.ts`.
- **Adapter law:** `host-neutral-progress-notify` covers any later ship progress adapter so a non-Tugboat composer cannot repeat the mole.
- **Docs / template:** `examples/supervisor/hermes/env.example` already documents Buzz vars. Align comments that still say “no-ops if unset” without the intended-Buzz audit split.
- **Depends on:** none. Can land on v1.40.1 next to #969 (Hermes pack must not omit credentials wiring). Do not wait for MessagingPort.
- **Does not:** restore a PATH `--milestone` watch; fail the ship because notify is down; merge inside advance/loop; source the entire supervisor env (REPO_DIR pin stays).
- **Class vs site (engine-dogfood bar):**
  1. **Class vs site.** The site is v1.40.0 watch with `BUZZ_BIN`+`BUZZ_CHANNEL` and no `BUZZ_CREDENTIALS_FILE`. The class is: intended Buzz notify MUST leave a durable fail/unconfigured audit when credentials cannot be resolved, and any thin ship composer MUST present Buzz vars into notify children. A human-sourced catch-up watch is not the class fix.
  2. **Shared surfaces.** Audit law lives in `supervisor-ship-notify`. Composer presentation and the named missing-credentials log live in `tugboat-thin-ship`. Adapter-wide presentation lives in `host-neutral-progress-notify`.
  3. **Next identical fault.** A later `ship-notify` that silent-exits with executable `BUZZ_BIN` and no credentials file fails the audit test. A later Tugboat watch spawn that omits parent `BUZZ_CREDENTIALS_FILE` fails the extract/spawn-env test. No new mole issue for the same missing-credential silent no-op.
)
