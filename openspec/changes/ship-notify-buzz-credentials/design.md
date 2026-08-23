## Context

See `proposal.md` for why. Current law and code:

- Living `supervisor-ship-notify` Scenario "No-op configuration does not invent failure markers" treats missing messenger **binary, channel, or credentials** as one silent no-op. `ship-notify.sh` writes a dedupe file, then `exit 0` when `BUZZ_CHANNEL` is empty or `BUZZ_CREDENTIALS_FILE` is empty or not a file. No `audit.log` line. No `failed/` marker.
- Empty/`SHIP_NOTIFY=0` / non-executable `BUZZ_BIN` is the CI path. That silent no-op stays.
- Tugboat `notify()` execs `SHIP_NOTIFY_BIN` in the Tugboat process env. `start_train_stage_watch` uses `env` and already sets `REPO_DIR`, `SHIP_NOTIFY_BIN`, `PIPELINE_SUPERVISOR_STATE`, `PIPELINE_MATERIAL_FILTER`. It does not set Buzz vars. `env` without `-i` still inherits parent env, so a parent that already has credentials would pass them. v1.40.0 Tugboat itself never had `BUZZ_CREDENTIALS_FILE`.
- Hermes started the ship without sourcing `~/.config/pipeline-supervisor/env`. Tugboat does not source that file. Living `tugboat-thin-ship` pins `REPO_DIR` at start and refuses factory-control. Sourcing the whole env file can retarget `REPO_DIR`.
- Catch-up with sourced supervisor env delivered `#1048` planning on the same messenger and channel.
- Living `host-neutral-progress-notify` already requires adapters to present an installed material-filter. It does not require Buzz credential presentation. Notify remains observational (no stage gate).

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is v1.40.0 watch with `BUZZ_BIN`+`BUZZ_CHANNEL` and no `BUZZ_CREDENTIALS_FILE`. The class is: intended Buzz notify MUST leave a durable fail/unconfigured audit when credentials cannot be resolved, and any thin ship composer MUST present Buzz vars into notify children. A human-sourced catch-up watch is not the class fix.
2. **Shared surfaces.** Audit law lives in `supervisor-ship-notify`. Composer presentation and the named missing-credentials log live in `tugboat-thin-ship`. Adapter-wide presentation lives in `host-neutral-progress-notify`.
3. **Next identical fault.** A later `ship-notify` that silent-exits with executable `BUZZ_BIN` and no credentials file fails the audit test. A later Tugboat watch spawn that omits parent `BUZZ_CREDENTIALS_FILE` fails the spawn-env test. No new mole issue for the same missing-credential silent no-op.

## Goals / Non-Goals

**Goals:**

- Intended Buzz (`SHIP_NOTIFY=1` + executable `BUZZ_BIN`) with missing channel or credentials file writes `audit.log` fail/unconfigured plus a named reason.
- Empty or non-executable `BUZZ_BIN` stays a silent CI no-op.
- Tugboat fills unset Buzz vars from the supervisor env file without sourcing the whole file, then presents them to `ship-notify` and stage-watch. Operator-set values win.
- Watch spawn `env` lists Buzz vars the same way it already lists `PIPELINE_MATERIAL_FILTER`.
- Named Tugboat log when intended Buzz cannot resolve credentials. Train/ship continues.

**Non-Goals:**

- Sourcing the entire supervisor env into Tugboat.
- Treating empty `BUZZ_RELAY_URL` alone as unconfigured if channel and credentials are present (the send gate today does not require relay; presentation still passes relay when set).
- Inventing a `failed/` marker solely for the empty-`BUZZ_BIN` path.
- Failing the ship because notify is down.
- MessagingPort, gateway allowlists, `--milestone` watch, deleting Tugboat.

## Decisions

### 1. Split silent no-op: empty binary vs intended Buzz missing credentials

**Choice:** `SHIP_NOTIFY=0` or empty/non-executable `BUZZ_BIN` remains silent (no audit, no `failed/` marker, exit 0). Executable `BUZZ_BIN` with empty `BUZZ_CHANNEL` or empty/unreadable `BUZZ_CREDENTIALS_FILE` SHALL append `audit.log` with status `fail` or `unconfigured` and a named reason (for example `buzz credentials missing` or `buzz channel missing`). Exit remains 0. Dedupe write may still happen before the audit; the silent hole is the missing audit, not the dedupe file.

**Why:** Living law mixed CI hosts with a host that already had `BUZZ_BIN` and `BUZZ_CHANNEL`. Operators then saw a live watch and an empty channel. AC 1 requires audit for the intended-Buzz case. AC 1 also allows CI no-op. The bite test is executable `BUZZ_BIN` + channel set + no credentials file → audit row.

**Alternatives considered:**

- Audit every missing-credentials call including empty `BUZZ_BIN` → rejected. CI and unset-messenger hosts would grow noise `unconfigured` rows. Living law and AC 1 keep that path silent.
- Also write `failed/` markers for intended-Buzz missing credentials → optional, not required. AC 1 names `audit.log`. Living “no invented failure marker solely because the messenger is unconfigured” stays for empty `BUZZ_BIN`. A marker for intended-Buzz MAY be added later; this change requires audit.
- Treat empty `BUZZ_RELAY_URL` as unconfigured even when channel and credentials exist → rejected. Current send proceeds and exports empty relay. Expanding the send gate could drop posts that a CLI-default relay still delivers. Tugboat still presents `BUZZ_RELAY_URL` when the parent or supervisor env has it (the v1.40.0 presentation hole).

### 2. Fill unset Buzz vars from the supervisor env file; do not source the whole file

**Choice:** When Tugboat starts (and before notify/watch), if `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, or `BUZZ_CHANNEL` is unset or empty in the process, Tugboat SHALL read that key from the supervisor env file (`$XDG_CONFIG_HOME/pipeline-supervisor/env` or `$HOME/.config/pipeline-supervisor/env`) and export it. Tugboat SHALL NOT overwrite a non-empty operator/parent value. Tugboat SHALL NOT `source` the whole file. Parse only those keys (and MAY also fill unset `BUZZ_BIN` the same way). Do not eval unquoted values beyond `KEY=VALUE` assignment. A leading `~/` on supervisor-env `BUZZ_CREDENTIALS_FILE` SHALL be rewritten to `$HOME/` as a prefix substitution only (quoted later expansion does not tilde-expand).

**Why:** Hermes started the ship without that file path. Tugboat never sourced it. A catch-up that sourced the file delivered immediately. Sourcing the whole file can change `REPO_DIR` after pin (forbidden) or change `ALLOW_MERGE` / `PIPELINE`. Filling only Buzz keys is the surgical class fix. Parent/operator values still win.

**Alternatives considered:**

- Source the whole `~/.config/pipeline-supervisor/env` at Tugboat start → rejected. Living REPO_DIR pin and factory-control refuse. #969 may still wire Hermes to source the file; Tugboat must not depend on that as the only path.
- Require Hermes pack (#969) to source the file and leave Tugboat unchanged → rejected. Class-over-site: a later composer that does not inherit Hermes env repeats the mole. This issue says it can land next to #969, not wait for it.
- Reconstruct credentials from `BUZZ_BIN` / channel only → rejected. The credential file is required for send.

### 3. Watch spawn `env` lists Buzz vars like `PIPELINE_MATERIAL_FILTER`

**Choice:** `start_train_stage_watch` SHALL pass `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL` on the `env` line (same style as `PIPELINE_MATERIAL_FILTER="$filter"`). Tugboat `notify()` keeps inheriting process env after the fill in Decision 2. Tugboat SHALL NOT overwrite an operator-set value. Tests extract that spawn env.

**Why:** AC 2 and AC 4 require the watch spawn env to include `BUZZ_CREDENTIALS_FILE` when the parent has a readable file. Inheritance alone is true for `env` without `-i`, but the v1.39.10 material-filter hole showed that an explicit `env` list is the extractable contract. Listing Buzz vars makes the same class of test possible.

**Alternatives considered:**

- Rely on `env` inheritance only (no explicit keys) → rejected. AC 4’s second test fails if spawn env omits `BUZZ_CREDENTIALS_FILE`. Inheritance is not visible in the `env` argv the tests extract.
- Pass Buzz vars only to `notify()`, not to watch → rejected. Stage posts go watch → `SHIP_NOTIFY_BIN`. Watch is a separate process. If Tugboat filled its env but watch spawn used a sanitized env later, posts would still die.

### 4. Named `buzz credentials missing` log; do not fail the ship

**Choice:** If `SHIP_NOTIFY=1` and `BUZZ_BIN` is executable and credentials cannot be resolved (empty or unreadable `BUZZ_CREDENTIALS_FILE`), Tugboat SHALL log `buzz credentials missing` (or equivalent). Train/ship SHALL continue. Do not log that line for empty `BUZZ_BIN`. Do not treat it as `stage-watch argv rejected` or as a live watch failure.

**Why:** AC 3. Operators watching Tugboat logs need a named line, not only an audit row under the notify state dir. Notify stays observational (`supervisor-ship-notify`).

**Alternatives considered:**

- Fail the train phase when credentials are missing → rejected. Delivery SHALL NOT gate ship. A CI host with a leftover executable `BUZZ_BIN` and no credentials file must not STOP a ship.
- Log only inside `ship-notify` and not in Tugboat → rejected. AC 3 names Tugboat. The v1.40.0 operator-visible surface was Tugboat/watch logs plus an empty channel.

### 5. Regression tests inject fakes; they do not start Buzz

**Choice:** Extend `core/test/ship-notify.test.ts` with a fixture: `SHIP_NOTIFY=1`, executable fake `BUZZ_BIN`, `BUZZ_CHANNEL` set, no credentials file → `audit.log` contains fail/unconfigured. Keep the existing empty-`BUZZ_BIN` silent test. Extend `core/test/tugboat.test.ts` so watch spawn env includes `BUZZ_CREDENTIALS_FILE` when the parent has a readable file (same extract/spawn pattern as #1212). Tests SHALL NOT start a live train, live messenger, or live ship.

**Why:** AC 4. Unit tests inject I/O. A live Buzz post is not the gate.

**Alternatives considered:**

- End-to-end live ship with Buzz → rejected. Out of scope and not a unit seam.

## Risks / Trade-offs

- **[Risk] Supervisor env file parse is naive and executes values.** → Mitigation: read only named keys; treat the file as `KEY=VALUE` lines; do not `source`; do not eval.
- **[Risk] Filling Buzz vars from the env file after `pin_repo_dir` still does not touch `REPO_DIR`.** → Mitigation: the filler never writes `REPO_DIR`. Spec forbids sourcing the whole file.
- **[Risk] Dedupe write still happens before the unconfigured audit, so operators see a notify/material-* file and may think the post landed.** → Mitigation: audit row is the required signal. Spec does not require moving dedupe after the configured-send check; it requires the audit. Implementation MAY check configuration before dedupe; either order is fine if audit exists.
- **[Risk] Stale installed `~/.local/bin/tugboat` / `ship-notify` keep the silent path.** → Mitigation: install/parity already covers pack content. This change’s unit tests gate the repo examples. Operators still refresh the install pack. Do not kill or restart an in-flight v1.40.0 as the fix.
- **[Trade-off] Empty `BUZZ_RELAY_URL` is presented when set and is not a new unconfigured-audit case.** If a later send fails because relay is empty, existing fail-all audit/marker law already records that. The v1.40.0 hole was missing credentials, not a new relay send-gate.

## Migration Plan

1. Land `ship-notify` intended-Buzz audit, Tugboat Buzz-var fill/presentation, named missing-credentials log, and tests on this branch.
2. Merge. Next `Ship milestone` uses candidate Tugboat after train-complete re-exec for later phases. Train-phase watch on the next ship uses the process-start Tugboat; operators who still run v1.40.0 Tugboat will keep silent no-op until that binary is refreshed or the next promote installs this SHA.
3. Do not kill or restart in-flight v1.40.0 as the fix. A human-sourced catch-up watch remains a one-off, not the product path.

Rollback: revert the notify/composer/test/spec change. Intended Buzz with missing credentials would again silent-`exit 0` after a dedupe write.

## Open Questions

None. Audit status token MAY be `fail` or `unconfigured`. Specs accept either. Fail-reason token MAY be `buzz credentials missing` or a documented equivalent.
