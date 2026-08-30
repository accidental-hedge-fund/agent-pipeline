# supervisor-ship-playbook Specification

## Purpose
Defines how the chain-to-existing-tools supervisor ship playbook evaluates captured `pipeline train --json` output for train completeness before later ship phases, so mixed prose-plus-JSON streams do not false-fail a truly complete train.

## Requirements

### Requirement: Train completion gate SHALL evaluate the last train_status even when non-JSON prose precedes it

After the ship playbook runs `pipeline train` with JSON mode and captures stdout to the train capture file, the train completion gate SHALL decode JSON values from that capture without requiring the entire file to be a single pure JSON document. The gate SHALL locate `train_status` objects (objects whose `kind` is `train_status`) by scanning the stream, including cases where human-readable prose appears before the JSON. When more than one such object is present, the gate SHALL use the **last** one. When a decoded JSON value is an array, the gate SHALL consider objects inside that array the same way. The gate SHALL treat the train as complete only when that selected `train_status` has `complete` equal to true and has no blocker. When those conditions hold, the playbook SHALL NOT exit solely because whole-stream JSON parse of the capture file failed, and SHALL proceed past the train phase. When the selected status is incomplete or carries a blocker, the gate SHALL fail closed and SHALL NOT advance to later ship phases (release, publication wait, engine-promote).

#### Scenario: Mixed prose then complete train_status passes

- **WHEN** the train capture file contains non-JSON human-readable text followed by a `train_status` object with `complete` true and no blocker
- **THEN** the ship playbook train completion gate SHALL evaluate the train as complete
- **AND** it SHALL NOT exit with a false failure whose detail is only that the train JSON is not complete

#### Scenario: Pure JSON complete train_status still passes

- **WHEN** the train capture file is only a single `train_status` object with `complete` true and no blocker
- **THEN** the ship playbook train completion gate SHALL evaluate the train as complete

#### Scenario: Incomplete train_status fails closed

- **WHEN** the last decoded `train_status` has `complete` false or is missing
- **THEN** the ship playbook train completion gate SHALL fail the train phase
- **AND** it SHALL NOT proceed to release or engine-promote for that run

#### Scenario: Blocker on last train_status fails closed with captured detail

- **WHEN** the last decoded `train_status` has a non-null blocker
- **THEN** the ship playbook train completion gate SHALL fail the train phase
- **AND** it SHALL write the blocker value to the playbook's existing blocker side file for that capture (the path used today for train completion detail)

#### Scenario: Last train_status wins over earlier ones

- **WHEN** the capture contains more than one `train_status` object and only the last has `complete` true with no blocker
- **THEN** the gate SHALL evaluate completeness from the last `train_status`
- **AND** it SHALL NOT fail solely because an earlier `train_status` was incomplete

#### Scenario: No train_status yields incomplete

- **WHEN** the train capture file contains no decodable `train_status` object
- **THEN** the ship playbook train completion gate SHALL evaluate the train as not complete
- **AND** it SHALL fail closed

### Requirement: Ship playbook engine-promote phase SHALL default install host to all

When the chain-to-existing-tools supervisor ship playbook reaches the engine-promote phase and the operator has not set `ENGINE_PROMOTE_HOST`, the playbook SHALL resolve the promote install host to `all` and SHALL invoke `pipeline engine-promote` with an explicit `--host all` (together with the existing promote flags such as `--for`). Default promote argv SHALL omit `--skip-frg`. The playbook SHALL NOT default `ENGINE_PROMOTE_HOST` or the promote `--host` argument to `codex` alone when the operator left the host unset.

#### Scenario: Unset ENGINE_PROMOTE_HOST yields --host all

- **WHEN** the ship playbook runs engine-promote for a published version
- **AND** `ENGINE_PROMOTE_HOST` is unset in the playbook environment
- **THEN** the playbook SHALL invoke engine-promote with `--host all`
- **AND** it SHALL NOT invoke engine-promote with `--host codex` solely because the environment variable was unset

#### Scenario: Playbook documentation matches the all default

- **WHEN** an operator reads the ship playbook environment documentation for `ENGINE_PROMOTE_HOST`
- **THEN** the documented default SHALL be `all` (not `codex`)

### Requirement: Ship playbook engine-promote phase SHALL honor ENGINE_PROMOTE_HOST override

When the operator sets `ENGINE_PROMOTE_HOST` to a single valid install host (`codex`, `claude`, `grok`, or `opencode`) or to `all`, the ship playbook SHALL pass that exact value as `--host` to `pipeline engine-promote` and SHALL NOT replace a single-host override with `all`.

#### Scenario: ENGINE_PROMOTE_HOST=codex scopes playbook promote

- **WHEN** the ship playbook runs engine-promote
- **AND** `ENGINE_PROMOTE_HOST` is set to `codex`
- **THEN** the playbook SHALL invoke engine-promote with `--host codex`
- **AND** it SHALL NOT rewrite the host to `all`

#### Scenario: ENGINE_PROMOTE_HOST=claude scopes playbook promote

- **WHEN** the ship playbook runs engine-promote
- **AND** `ENGINE_PROMOTE_HOST` is set to `claude`
- **THEN** the playbook SHALL invoke engine-promote with `--host claude`

### Requirement: Ship playbook promote host default SHALL be regression-tested

The ship playbook's default promote host resolution (unset → `all`, set → override) SHALL be covered by an automated check (script fixture, static assertion against the playbook source default, or extracted pure helper) that fails if the unset default reverts to `codex`.

#### Scenario: Regression fails if playbook default reverts to codex

- **WHEN** the automated check for ship playbook promote host resolution runs against a playbook whose unset default is `codex`
- **THEN** the check SHALL fail
- **AND** the same check SHALL pass when the unset default is `all` and an explicit override is still honored

### Requirement: Legacy installed codex-only ship playbook SHALL fail doctor preflight

When an installed chain-to-existing-tools ship playbook is present at the documented install path (`~/.local/bin/pipeline-ship-playbook` or equivalent) and its source still uses the pre-multi-host unset default `HOST="${ENGINE_PROMOTE_HOST:-codex}"`, and the operator has not set `ENGINE_PROMOTE_HOST` in the environment, doctor preflight SHALL fail closed with remediation that requires one of: reinstalling/refreshing the playbook from the repo example, invoking the versioned repo playbook path directly, or exporting `ENGINE_PROMOTE_HOST=all` for the ship run. Absence of an installed playbook SHALL skip the check (not every host uses the chain playbook). When the operator has set `ENGINE_PROMOTE_HOST`, the check SHALL NOT fail solely for the legacy default shape.

#### Scenario: Legacy installed playbook without override fails doctor

- **WHEN** doctor runs and `~/.local/bin/pipeline-ship-playbook` exists
- **AND** that file contains the unset default `ENGINE_PROMOTE_HOST:-codex`
- **AND** `ENGINE_PROMOTE_HOST` is unset in the doctor environment
- **THEN** the `supervisor:ship-playbook-promote-host` check SHALL fail
- **AND** remediation SHALL name refresh, versioned-repo invocation, or `ENGINE_PROMOTE_HOST=all`

#### Scenario: Missing installed playbook skips the check

- **WHEN** doctor runs and no installed ship playbook is present at the documented path
- **THEN** the promote-host playbook check SHALL skip
- **AND** doctor SHALL NOT fail solely because the chain playbook is unused

#### Scenario: Legacy fixture regression fails pure helper without override

- **WHEN** unit tests evaluate a fixture playbook body whose unset default is `codex` with no `ENGINE_PROMOTE_HOST` override
- **THEN** the evaluation SHALL report fail
- **AND** the same evaluation SHALL report pass for a body whose unset default is `all`

### Requirement: Chain ship playbook SHALL NOT be the primary Option 1 Buzz ship path

When documentation describes Option 1 thin ship for agent-box / Buzz (`Ship milestone vX.Y.Z`), it SHALL name Tugboat as the primary composer. The chain-to-existing-tools playbook (`pipeline-ship-playbook`) MAY remain documented as an alternate composition for hosts that still install it, but Option 1 primary install and Hermes phrase mapping SHALL NOT present the playbook as the default Buzz ship path in competition with Tugboat.

#### Scenario: Option 1 docs de-primary the playbook

- **WHEN** an operator reads Option 1 ship install or Hermes ship-phrase documentation after this change
- **THEN** the primary path SHALL be Tugboat
- **AND** any remaining playbook instructions SHALL be labeled alternate/legacy (or equivalent) rather than the sole recommended Buzz path

#### Scenario: Playbook-specific doctor checks remain for hosts that still install it

- **WHEN** a host still has an installed `pipeline-ship-playbook` with a legacy codex-only promote default and no `ENGINE_PROMOTE_HOST` override
- **THEN** the existing `supervisor:ship-playbook-promote-host` doctor check SHALL continue to fail closed
- **AND** that check SHALL NOT be removed solely because Tugboat is primary

### Requirement: Ship playbook default release and promote argv SHALL omit skip-frg

The documented alternate chain playbook SHALL invoke `pipeline release` and `pipeline engine-promote` without `--skip-frg` on the default path. If the playbook remains installed, it SHALL compose the same `factory-release prepare` request/re-invoke sequence before release, or fail closed when release finds no Factory Reliability Gate (FRG) evidence. The playbook SHALL NOT keep hard-coded `--skip-frg` as its default and SHALL NOT add a grant factory or a second pack protocol.

#### Scenario: Default playbook release argv has no skip-frg

- **WHEN** the ship playbook enters release prepare
- **AND** no operator skip escape is active
- **THEN** the release invocation SHALL NOT include `--skip-frg`

#### Scenario: Default playbook promote argv has no skip-frg

- **WHEN** the ship playbook enters engine-promote
- **AND** no operator skip escape is active
- **THEN** the promote invocation SHALL NOT include `--skip-frg`

#### Scenario: Missing FRG fail-closes the alternate path

- **WHEN** the playbook reaches release and no `latest.json` `pass: true` exists for that version
- **AND** no operator skip escape is active
- **THEN** release SHALL fail closed
- **AND** the playbook SHALL NOT invent a pass or silently add `--skip-frg`

### Requirement: Installed skip-frg ship composer SHALL fail doctor preflight

Doctor preflight SHALL fail closed when an installed Tugboat or
chain-to-existing-tools ship playbook is present at a documented install path
(`~/.local/bin/tugboat`, `~/.local/bin/pipeline-ship-playbook`, or equivalent) and
its default release or promote argv still hard-codes `--skip-frg` (the pre-#1039
skip-frg playbook). Remediation SHALL require refreshing the composer from the repo
example (or invoking the versioned repo path). Absence of an installed composer
SHALL skip the check. When the operator escape is active for that doctor process
(`--skip-frg` / documented env with a logged reason), the check SHALL NOT fail
solely for the escape path existing in the source.

A unit or doctor test SHALL fail if the installed-composer evaluator accepts a body
whose default release or promote argv still contains `--skip-frg`.

#### Scenario: Installed playbook with hard-coded skip-frg fails doctor

- **WHEN** doctor runs and `~/.local/bin/pipeline-ship-playbook` exists
- **AND** that file's default release or promote argv hard-codes `--skip-frg`
- **AND** no operator skip escape is active in the doctor environment
- **THEN** the skip-frg composer check SHALL fail
- **AND** remediation SHALL name refresh from the repo example

#### Scenario: Installed Tugboat with hard-coded skip-frg fails doctor

- **WHEN** doctor runs and an installed Tugboat exists at the documented path
- **AND** that file's default release or promote argv hard-codes `--skip-frg`
- **THEN** the skip-frg composer check SHALL fail
- **AND** remediation SHALL name refresh from `examples/supervisor/shell/tugboat.sh`

#### Scenario: Missing installed composer skips the check

- **WHEN** doctor runs and no installed Tugboat or ship playbook is present
- **THEN** the skip-frg composer check SHALL skip
- **AND** doctor SHALL NOT fail solely because the host does not use thin ship

#### Scenario: Fixture regression fails the old skip-frg playbook

- **WHEN** unit tests evaluate a fixture composer body whose default release or
  promote argv contains `--skip-frg`
- **THEN** the evaluation SHALL report fail
- **AND** the same evaluation SHALL report pass for a body whose default argv omits
  `--skip-frg` and retains a logged-reason escape

### Requirement: Ship playbook C0 wait SHALL adopt the shared ship-release check-wait recipe

The chain-to-existing-tools ship playbook SHALL apply the shared `ship-release-check-wait` classifier and bounded rerun recipe during the C0 wait before `pipeline release finish`. The playbook SHALL poll with a valid `gh pr checks --json` field set that includes `bucket` and `link` and SHALL NOT request a non-existent `conclusion` field. On classification `rerun`, the playbook SHALL request `gh run rerun --failed` and resume the existing wait loop. On classification `fail`, the playbook SHALL mark release-finish failed and SHALL NOT invoke `pipeline release finish`. The playbook SHALL NOT keep a divergent “any settled fail is immediately terminal” policy.

#### Scenario: Playbook first test fail reruns then waits

- **WHEN** the playbook’s wait helper classifies the release PR checks as `rerun`
- **AND** rerun budget remains
- **THEN** the playbook SHALL request `gh run rerun --failed`
- **AND** it SHALL continue waiting
- **AND** it SHALL NOT write release-finish `failed` on that poll

#### Scenario: Playbook terminal fail does not call finish

- **WHEN** the shared wait helper reports `fail`
- **THEN** the playbook SHALL mark the release-finish phase failed
- **AND** it SHALL NOT invoke `pipeline release finish`

#### Scenario: Playbook green after rerun calls finish

- **WHEN** the playbook has requested one rerun for a `test` fail
- **AND** a later poll reports checks green
- **THEN** the playbook SHALL invoke `pipeline release finish` for that same PR

### Requirement: Ship playbook release-finish fail detail SHALL prefer the checks sidecar over leftover train warns

When the playbook marks release-finish failed because the shared waiter classified `fail`, the playbook SHALL enrich state and notify from the checks-fail sidecar (PR, check name, bucket or state, run URL, last failed test title when present). The lead reason SHALL NOT be a leftover `[pipeline] tester-evidence:` line or a `trusted-surface blocked` warn from an earlier train item.

#### Scenario: Playbook STOP names the check URL

- **WHEN** the playbook STOPs release-finish after a terminal `test` fail
- **AND** the checks sidecar includes an Actions run URL
- **THEN** the failed state/notify detail SHALL include that check name and run URL
- **AND** it SHALL NOT lead with `tester-evidence` or `trusted-surface blocked`

### Requirement: Ship playbook FRG pack SHALL unset attestor env and sign outside prepare

The documented alternate chain playbook SHALL compose the same Factory Reliability Gate (FRG) pack isolation as Tugboat. The playbook SHALL invoke `pipeline factory-release prepare` with `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset in the prepare child. When prepare returns `status: "awaiting_frg_attestation"` or unsigned eligible artifacts exist for the bound request, the playbook SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a separate child that has the producer credential. Pack-done SHALL require `.agent-pipeline/frg/<X.Y.Z>/latest.json` `pass: true` bound to the request candidate SHA (and version; and `action_id` when recorded), or prepare `status: "complete"` with an open release PR for that version. Prepare status `awaiting_frg_attestation` alone SHALL NOT be pack-done. Unsigned eligible omitted-HMAC `latest.json` `pass: false` SHALL be `attest`, not pack-fail. A prior candidate's signed `latest.json` `pass: false` SHALL NOT fail a current in-progress unsigned-eligible tick. The playbook SHALL NOT persist the FRG key body in `state.json`. The playbook SHALL NOT keep a second pack protocol that treats unsigned wait as done.

Shared pack helpers used by Tugboat and the playbook SHALL stay in sync for request writing, pack-tick classification, and attestor compose.

#### Scenario: Playbook prepare child unsets KEY_FILE

- **WHEN** the parent environment has `PIPELINE_FRG_ATTESTATION_KEY_FILE` set
- **AND** the ship playbook invokes `pipeline factory-release prepare`
- **THEN** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY` unset
- **AND** that prepare child SHALL have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset

#### Scenario: Playbook awaiting is not pack-done

- **WHEN** the ship playbook classify helper sees prepare status `awaiting_frg_attestation`
- **AND** `latest.json` is missing or is not bound `pass: true`
- **THEN** the helper SHALL NOT report pack-done

#### Scenario: Playbook attestor child is outside prepare

- **WHEN** prepare returns `status: "awaiting_frg_attestation"` for version `1.39.0` with bound `loop_run_id` `L`
- **THEN** the playbook SHALL invoke `pipeline factory-gate --for 1.39.0 --from-run L` in a child other than prepare
- **AND** that child SHALL have the producer credential

#### Scenario: Playbook in-progress unsigned eligible artifacts are attested

- **WHEN** prepare returns `status: "in_progress"` for version `1.39.0`
- **AND** the prepare result includes unsigned eligible artifacts
- **AND** the bound pack `loop_run_id` is `L`
- **AND** no matching `latest.json` `pass: true` exists
- **THEN** the playbook SHALL invoke `pipeline factory-gate --for 1.39.0 --from-run L` in a child other than prepare
- **AND** that child SHALL have the producer credential
- **AND** the classify helper SHALL NOT report wait-only retry for that tick

#### Scenario: Playbook stale signed failing latest.json does not fail a newer unsigned-eligible tick

- **WHEN** `.agent-pipeline/frg/1.39.5/latest.json` has `pass: false` with HMAC present bound to a prior candidate SHA
- **AND** prepare returns `status: "in_progress"` for a new request for version `1.39.5`
- **AND** the prepare result includes unsigned eligible artifacts
- **AND** no matching `latest.json` `pass: true` exists for the new candidate
- **THEN** the helper SHALL report `attest`
- **AND** it SHALL NOT report pack-fail

#### Scenario: Playbook unsigned eligible omitted-HMAC pass false is attest

- **WHEN** the ship playbook classify helper sees prepare status `awaiting_frg_attestation`
- **AND** `latest.json` has `pass: false` because HMAC was omitted
- **AND** the bound pack is structurally eligible
- **THEN** the helper SHALL report `attest`
- **AND** it SHALL NOT report pack-fail

#### Scenario: Playbook helpers stay in sync with Tugboat

- **WHEN** an automated check compares Tugboat and `frg-pack-helpers.sh` pack helpers
- **THEN** request writing, pack-tick classification, and attestor compose SHALL match
- **AND** the check SHALL fail if the playbook copy still treats `awaiting_frg_attestation` as done
- **AND** the check SHALL fail if either copy still treats unsigned eligible omitted-HMAC `pass: false` as `fail`
- **AND** the check SHALL fail if either copy classifies in-progress unsigned eligible artifacts as `fail` because a prior candidate's signed `pass: false` remains in `latest.json`

### Requirement: Ship playbook SHALL be a thin launcher that inherits Tugboat ship-end

The documented alternate chain playbook SHALL exec `$REPO_DIR/examples/supervisor/shell/tugboat.sh` and SHALL NOT retain a second ship-end compose implementation. After that exec, Tugboat SHALL invoke `factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, and `release ensure-tag` using the candidate engine after train is complete or resumed complete. Tugboat SHALL NOT invoke `git tag` or `gh release create`. Train SHALL remain on the production-pin CLI.

When the installed playbook is selected for ship-end and is not that launcher, doctor or the ship-end identity check SHALL fail closed.

#### Scenario: Playbook release uses the candidate CLI

- **WHEN** the ship playbook finishes train for version `1.39.5`
- **AND** process-start `$PIPELINE` is production pin `1.39.4`
- **THEN** the playbook SHALL have exec'd repo Tugboat
- **AND** Tugboat SHALL invoke `pipeline release` via the candidate engine
- **AND** it SHALL NOT invoke release via the `1.39.4` binary

#### Scenario: Stale installed playbook is not an accepted ship-end composer

- **WHEN** `~/.local/bin/pipeline-ship-playbook` is a full stale compose (not a launcher to repo `tugboat.sh`)
- **AND** the ship still uses that installed playbook for FRG or release
- **THEN** doctor or the ship-end identity check SHALL fail
- **AND** remediation SHALL name refresh from the candidate launcher or exec of `$REPO_DIR/examples/supervisor/shell/tugboat.sh`

#### Scenario: Inherited Tugboat path includes ensure-tag

- **WHEN** the playbook execs repo Tugboat for a ship that has merged the release PR
- **THEN** that Tugboat path SHALL invoke candidate `release ensure-tag` before `wait-release`
- **AND** the playbook SHALL NOT keep a second compose that waits for GitHub Release without that invoke

### Requirement: Playbook ship-end identity check SHALL share the Tugboat gate

The playbook SHALL be subject to the same doctor or unit check as Tugboat: fail when ship-end CLI `commit_sha` does not equal the candidate SHA being released; fail when a selected playbook is not a launcher to repo Tugboat; skip when the playbook is not installed and not used.

#### Scenario: Playbook source regression fails if it is not a launcher

- **WHEN** an automated check inspects `examples/supervisor/shell/pipeline-ship-playbook.sh`
- **AND** that file is not a thin exec of `$REPO_DIR/examples/supervisor/shell/tugboat.sh`
- **THEN** the check SHALL fail

### Requirement: Ship playbook FRG pack wait SHALL inherit Tugboat live-loop wait

The documented alternate chain playbook SHALL inherit Tugboat's Factory Reliability Gate (FRG) pack wait law. Because the playbook execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh`, wait-until-terminal while the bound pack loop is live SHALL apply to a playbook-started ship. Live SHALL mean the same authoritative pack-loop liveness status Tugboat reads from prepare JSON `liveness`. A non-terminal ledger SHALL NOT prove live. The playbook SHALL NOT keep a second pack wait that fails the ship at the CI poll cap while prepare status is `in_progress` and the bound loop is live. Shared pack helpers used by Tugboat and the playbook SHALL stay in sync if wait-continue vs wait-fail classification is shared. Unreadable identity evidence SHALL consume the bounded observation window and then fail closed in those shared helpers. It SHALL NOT count as live after that window.

#### Scenario: Playbook-started ship does not fail a live pack at 20 minutes

- **WHEN** the ship playbook execs Tugboat for milestone `v1.39.5`
- **AND** prepare returns `status: "in_progress"` for a live bound pack loop
- **AND** 20 minutes of wait ticks have elapsed
- **THEN** the ship SHALL NOT mark `frg-pack` failed for wait-budget exhaustion
- **AND** it SHALL keep `state.json` at `frg-pack` / `running`

#### Scenario: Playbook does not keep a second short FRG wait

- **WHEN** an automated check inspects the playbook source and Tugboat wait helpers
- **THEN** the playbook SHALL NOT implement a second FRG wait loop that copies `RELEASE_WAIT_*` as live-loop pack-fail
- **AND** wait-continue vs wait-fail SHALL match Tugboat when those helpers are shared

#### Scenario: Shared helpers treat unreadable liveness as wait-continue

- **WHEN** shared pack helpers classify wait-continue vs wait-fail
- **AND** bound-loop identity evidence is unreadable or malformed
- **AND** the bounded observation window has not expired
- **THEN** the decision SHALL be continue
- **AND** Tugboat and the playbook helpers SHALL match

#### Scenario: Shared helpers treat unreadable identity as fail-closed after the observation window

- **WHEN** shared pack helpers classify wait-continue vs wait-fail
- **AND** bound-loop identity evidence is unreadable or malformed
- **AND** the bounded observation window has expired
- **THEN** the decision SHALL be fail closed with a typed observer or identity error
- **AND** Tugboat and the playbook helpers SHALL match
- **AND** the decision SHALL NOT be continue-as-live

### Requirement: Hermes supervisor SKILL SHALL NOT default a second production pin path

The in-repo Hermes/Buzz supervisor SKILL (`examples/supervisor/hermes/SKILL.md` and any generated or installed copy the product owns) SHALL NOT default `AGENT_PIPELINE_PRODUCTION_PIN` to `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json`. Unset SHALL remain unset so Tugboat can bind `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. `examples/supervisor/hermes/env.example` SHALL NOT document a second live pin path. If that file shows `AGENT_PIPELINE_PRODUCTION_PIN`, the value SHALL be the control-checkout pin. A unit test SHALL fail if the SKILL or `env.example` still defaults or documents the Hermes-state pin path. A later packaging template SHALL NOT reintroduce that second path.

#### Scenario: SKILL has no Hermes-state pin default

- **WHEN** `examples/supervisor/hermes/SKILL.md` is read
- **THEN** it SHALL NOT contain a default assignment of `AGENT_PIPELINE_PRODUCTION_PIN` to `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json`
- **AND** it SHALL NOT instruct the host to export that Hermes-state path when the env is unset

#### Scenario: env.example has no second live pin path

- **WHEN** `examples/supervisor/hermes/env.example` is read
- **THEN** it SHALL NOT document `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json` as a live pin
- **AND** if `AGENT_PIPELINE_PRODUCTION_PIN` is shown, the value SHALL be `$REPO_DIR/.agent-pipeline/production-engine-pin.json` or an equivalent control-checkout pin

#### Scenario: Drift-guard test fails on Hermes-state default

- **WHEN** unit tests read the in-repo Hermes SKILL and `env.example`
- **THEN** the tests SHALL fail if either file defaults or documents the Hermes-state pin path
- **AND** no real network, git, or subprocess call SHALL occur
