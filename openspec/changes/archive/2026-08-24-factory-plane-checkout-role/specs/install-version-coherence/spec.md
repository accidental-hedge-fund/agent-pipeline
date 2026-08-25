## ADDED Requirements

### Requirement: Doctor engine-track identity SHALL use checkout role not GitHub owner/name

`pipeline doctor` check `install:engine-track` SHALL obtain factory-control context from checkout role (live factory control checkout / control worktree), not from `config.repo` equal to `accidental-hedge-fund/agent-pipeline`. On a non-control clone of that GitHub repository, with two-track policy inactive, the check SHALL pass even when a leftover clone pin has `frg_run_id` `no-frg-1.39.1`. On the live factory control checkout, the check SHALL still fail closed under pinned intent when the live pin is `no-frg-*` or has null/empty `frg_evidence_path`.

A unit test SHALL fail if doctor identity treats a non-control clone of `accidental-hedge-fund/agent-pipeline` as pinned and `install:engine-track` / `evaluateEngineTrackCheck` fails on `no-frg-1.39.1`. A second unit test SHALL fail if factory-control checkout context accepts a `no-frg-*` pin as production-quality. Tests SHALL inject I/O and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Non-control clone leftover no-frg pin does not fail doctor

- **WHEN** `pipeline doctor` runs in a non-control clone of `accidental-hedge-fund/agent-pipeline`
- **AND** `config.repo` is `accidental-hedge-fund/agent-pipeline`
- **AND** no explicit `--engine-track` / `engine_track` is set
- **AND** factory-plane `REPO_DIR` and `AGENT_PIPELINE_FACTORY_CONTROL` are unset
- **AND** the clone has `.agent-pipeline/production-engine-pin.json` with `frg_run_id` `no-frg-1.39.1`
- **THEN** `install:engine-track` SHALL have status `"pass"`
- **AND** SHALL NOT fail solely for that leftover marker

#### Scenario: Clone GitHub-name plus leftover pin regression is hermetic

- **WHEN** a unit test injects `config.repo` `accidental-hedge-fund/agent-pipeline`, inactive two-track intent, and a readable pin with `frg_run_id` `no-frg-1.39.1` under a non-control checkout
- **THEN** `evaluateEngineTrackCheck` / `install:engine-track` SHALL have status `"pass"`
- **AND** the same suite SHALL fail if that result is `"fail"` solely because of GitHub owner/name plus the leftover marker
- **AND** no real network, git, or subprocess call SHALL occur

#### Scenario: Factory-control checkout still fails a no-frg pin

- **WHEN** a unit test injects factory-control checkout context and pinned intent
- **AND** the live pin has `frg_run_id` `no-frg-1.39.1` or null `frg_evidence_path`
- **THEN** `evaluateEngineTrackCheck` / `install:engine-track` SHALL have status `"fail"`
- **AND** the same suite SHALL fail if that result is `"pass"`
- **AND** no real network, git, or subprocess call SHALL occur

## MODIFIED Requirements

### Requirement: Factory doctor install:engine-track SHALL fail closed on a no-frg production pin

On the live factory control checkout, `pipeline doctor` check `install:engine-track` SHALL fail
when pinned-track intent applies and the live production pin is not production-quality: its
`frg_run_id` starts with `no-frg-`, or `frg_evidence_path` is null or empty. The check SHALL
fail even when the installed/running version matches the pin version and tag-install
provenance is otherwise coherent. Detail and remediation SHALL name the `no-frg-*` / null
evidence defect and SHALL instruct a non-skip promote from a real FRG pass (or an explicit
`--skip-frg` only when the operator intends a non-production-quality pin).

The check SHALL NOT fail solely for this marker when two-track factory policy is inactive
(ordinary non-factory product host, including a non-control clone of
`accidental-hedge-fund/agent-pipeline`). Under explicit candidate soak intent, the check SHALL
still report the marker in detail and SHALL NOT fail solely because the pin is `no-frg-*`.

This rule is fail-closed because default promote already requires FRG after the Tugboat
FRG ship path (#1039). A warn-only result is not sufficient on the factory pinned track.
GitHub owner/name SHALL NOT be what activates this fail-closed path.

#### Scenario: Factory pinned doctor fails a no-frg pin

- **WHEN** `pipeline doctor` runs on the live factory control checkout under pinned-track intent
- **AND** the live production pin has `frg_run_id` `no-frg-1.37.0` or `frg_evidence_path` null
- **THEN** `install:engine-track` SHALL have status `"fail"`
- **AND** the detail SHALL name the `no-frg-*` or null-evidence defect
- **AND** the remediation SHALL instruct promote from a real FRG pass

#### Scenario: Matching install does not hide a no-frg pin

- **WHEN** pinned-track intent applies on the live factory control checkout
- **AND** the installed/running version matches the pin version
- **AND** the pin `frg_run_id` starts with `no-frg-`
- **THEN** `install:engine-track` SHALL still have status `"fail"`
- **AND** SHALL NOT pass solely because version and tag-install provenance match

#### Scenario: Non-factory doctor does not fail solely for no-frg

- **WHEN** `pipeline doctor` runs on a non-factory product repository host
- **AND** two-track factory policy is inactive
- **AND** a readable pin has `frg_run_id` `no-frg-1.37.0`
- **THEN** `install:engine-track` SHALL NOT fail solely for that marker

#### Scenario: Non-control clone of this GitHub repo does not fail solely for no-frg

- **WHEN** `pipeline doctor` runs in a non-control clone of `accidental-hedge-fund/agent-pipeline`
- **AND** two-track factory policy is inactive
- **AND** a readable clone pin has `frg_run_id` `no-frg-1.39.1`
- **THEN** `install:engine-track` SHALL NOT fail solely for that marker
- **AND** SHALL NOT treat GitHub owner/name as factory-control identity

#### Scenario: Candidate soak reports the marker without failing for it

- **WHEN** `pipeline doctor` runs with explicit candidate soak intent
- **AND** the live pin has `frg_run_id` `no-frg-1.37.0`
- **THEN** the check SHALL report the `no-frg-*` marker in detail
- **AND** SHALL NOT fail solely because the pin is `no-frg-*`

#### Scenario: Production-quality pin still passes when install matches

- **WHEN** `pipeline doctor` runs on the live factory control checkout under pinned-track intent
- **AND** the live pin has a real FRG `frg_run_id` and a non-null `frg_evidence_path`
- **AND** the install matches the pin under existing track-coherence rules
- **THEN** `install:engine-track` SHALL have status `"pass"`
