## ADDED Requirements

### Requirement: Durable post-pilot FRG generation SHALL start or resume a request-bound pack loop

For every release version after v1.33.0, the durable FRG generator SHALL start
or resume one `factory-gate` pack loop bound to the active prepare request.
When no request-bound loop exists, the generator SHALL create or reuse pack
issues from the checked-in `factory-gate-v1` templates so the item count meets
the pack manifest minimum, allocate the candidate-track run id, persist
`factory-release-binding.json` on that loop (request fingerprint, candidate
git SHA, target version, pack/manifest identity) together with a non-null
`loop_run_id` on the pack instance, and only then spawn or resume the loop.
A failed detached spawn SHALL fail that tick and SHALL leave the request
bound to the same `loop_run_id` so a later invoke can resume it. While that
bound loop is not terminal, the generator SHALL return a machine-readable
in-progress status and SHALL NOT treat the missing terminal loop as
`missing_generator` or `pack_loop_missing`. A re-invoke of the same request
SHALL resume the same `loop_run_id` and SHALL NOT start a second unbound pack.
The generator SHALL NOT adopt an unbound newest `factory-gate` loop as the
bound run or as release-eligible evidence.

#### Scenario: First prepare with no bound loop dispatches a candidate pack loop

- **WHEN** durable FRG generation runs for a post-1.33 version
- **AND** no `factory-release-binding.json` matches the request fingerprint,
  candidate SHA, version, and manifest
- **THEN** the generator SHALL create or reuse pack issues from
  `factory-gate-v1` templates that meet the manifest minimum item count
- **AND** it SHALL persist a non-null `loop_run_id` on the pack instance
  together with a matching `factory-release-binding.json` before spawn
- **AND** it SHALL then dispatch one durable loop on the candidate engine track
  with the pack work-list or the `factory-gate` label
- **AND** it SHALL return in-progress status without inventing `pass: true`

#### Scenario: Second prepare resumes the same bound loop

- **WHEN** a later invoke uses the same prepare request
- **AND** the pack instance already records `loop_run_id` `L` with a matching
  binding
- **THEN** the generator SHALL resume `L`
- **AND** it SHALL NOT start another pack loop

#### Scenario: Unbound newest factory-gate loop is not adopted

- **WHEN** an unbound newest `factory-gate` loop exists
- **AND** no `factory-release-binding.json` matches the active request
- **THEN** the generator SHALL NOT adopt that unbound loop as the bound run
- **AND** it SHALL start or resume only a request-bound pack loop

#### Scenario: Crash after persist before spawn resumes the same bound run

- **WHEN** the generator has persisted pack-instance `loop_run_id` `L` and a
  matching `factory-release-binding.json`
- **AND** the process stops before spawn confirms
- **THEN** a later invoke of the same request SHALL resume `L`
- **AND** it SHALL NOT start a second unbound pack

#### Scenario: Failed detached spawn is retried on the same bound run

- **WHEN** detached spawn fails at startup (including missing `PIPELINE_BIN`)
- **THEN** that tick SHALL NOT return in-progress as if the loop were running
- **AND** a later invoke of the same request SHALL resume the same
  `loop_run_id`
- **AND** it SHALL NOT start a second unbound pack

### Requirement: Terminal pack-loop scoring SHALL use factory-gate from-run without observations

When the request-bound pack loop is terminal, the durable generator SHALL
score that run with `pipeline factory-gate --for <target-version> --from-run
<loop_run_id>` or the in-process equivalent that implements the same scorer
contract. The score invocation SHALL NOT pass `--observations` or any
caller-authored observations file. Hybrid v2 scoring SHALL apply: required-live
ids MUST come from the candidate pack loop; Layer A-allowed ids MAY prove from
a TAP hash on the same candidate SHA. The generator SHALL NOT invent scenario
statuses, metrics, receipts, or `pass: true`.

#### Scenario: Terminal loop is scored from the bound run id

- **WHEN** the request-bound pack loop `L` is terminal for version `1.39.0`
- **THEN** the generator SHALL invoke factory-gate scoring for `1.39.0` with
  `--from-run L` (or the in-process equivalent)
- **AND** that invocation SHALL omit `--observations`

#### Scenario: Synthetic observations cannot unlock a pass

- **WHEN** a caller or work directory supplies an observations file
- **THEN** the terminal score path SHALL ignore that file
- **AND** only runner-derived hybrid v2 evidence MAY contribute to
  release-eligible pass

### Requirement: Release-eligible latest.json pass SHALL be written only on a genuine scorer pass

The durable generator SHALL write `.agent-pipeline/frg/<version>/latest.json`
with `pass: true` only when the factory-gate scorer produces a genuine
release-eligible pass for that version, candidate, pack, and bound
`loop_run_id`. A fail score SHALL remain `pass: false`. A fail result MAY
write `latest.json` with `pass: false`. The generator SHALL NOT rewrite a fail
into a pass, and SHALL NOT treat a fail `latest.json` as release-eligible.

#### Scenario: Genuine pass writes release-eligible latest.json

- **WHEN** factory-gate scoring of the bound terminal loop yields
  release-eligible `pass: true`
- **THEN** the generator MAY write `.agent-pipeline/frg/<version>/latest.json`
  with `pass: true` for that version

#### Scenario: Fail stays fail

- **WHEN** factory-gate scoring of the bound terminal loop yields
  `pass: false`
- **THEN** any written `latest.json` SHALL keep `pass: false`
- **AND** release preparation SHALL NOT treat that artifact as
  release-eligible
