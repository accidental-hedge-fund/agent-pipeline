## MODIFIED Requirements

### Requirement: Train SHALL mint a durable train-level run ID and generic run-store directory

Train SHALL create a run directory under the generic run-store root `.agent-pipeline/runs/<train-run-id>/` before the first advance wave for each admitted live (non-`--dry-run`) `pipeline train` invocation. The run ID SHALL use a `train-` prefix and a filesystem-safe UTC timestamp with millisecond precision so it cannot collide with per-issue advance IDs of the form `<issue>-<timestamp>`. The directory SHALL contain `events.jsonl` (append-only) in the same layout `pipeline logs` already reads. `run.json` SHALL identify the run as a train (selector and merge mode, plus ordered issues when known) and SHALL NOT present a single work-list issue as if this were a one-issue advance run. A missing selector that the command already refuses SHALL NOT create a run directory. A `--dry-run` invocation SHALL NOT create a train run directory, even when the selector is valid.

#### Scenario: Train run directory exists before the first wave

- **WHEN** `pipeline train --issues 10,11` is admitted and begins work
- **THEN** `.agent-pipeline/runs/train-<timestamp>/events.jsonl` SHALL exist before the first advance-wave call
- **AND** the basename SHALL start with `train-`
- **AND** it SHALL NOT equal an advance run id of the form `10-<timestamp>`

#### Scenario: run.json is not a fake single-issue advance record

- **WHEN** a train run directory is initialized for issues 10 and 11
- **THEN** `run.json` SHALL mark the run as a train
- **AND** it SHALL NOT set `issue` solely to `10` as the run's identity the way an advance run for issue 10 does

#### Scenario: Refused selector creates no run

- **WHEN** `pipeline train` is invoked with neither `--issues` nor `--milestone`
- **THEN** the command SHALL exit non-zero as it does today
- **AND** it SHALL NOT create a train run directory

#### Scenario: Dry-run creates no run

- **WHEN** `pipeline train --issues 10,11 --dry-run` is admitted and prints a plan
- **THEN** the command SHALL NOT create a train run directory
- **AND** it SHALL NOT write `events.jsonl`
