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
