## MODIFIED Requirements

### Requirement: A detached launch exposes the same run-store run directory

When `pipeline run <N> --detach` is used, the launcher SHALL pin a
`.agent-pipeline/runs/<run-id>` run-store identity and pass it to the inner run (via
`--run-id`) so both share one run directory, and SHALL report that run-id/path to the caller.
The pinned run-store directory SHALL be rooted at the **resolved repository root** — the git
root of the resolved `--repo-path`, or of the current working directory — and SHALL NOT be
derived from an unvalidated start directory; when no repository root can be resolved, the
launcher SHALL refuse the launch rather than pin a run-store path (see the detached-launcher
capability). The detached run's `events.jsonl` and `terminal.log` — not the wrapper's
`pipeline.log`/`sentinel.json` — are the machine-readable Pipeline Desk contract.
`--json-events` SHALL be forwarded to the inner run when set.

#### Scenario: detached launch reports the run-store run directory

- **WHEN** `pipeline run <N> --detach` is invoked
- **THEN** the launcher SHALL pin a run-store run-id and forward it to the inner run
- **AND** the inner run SHALL use that same `.agent-pipeline/runs/<run-id>` directory
- **AND** the launcher SHALL report the run-store path so a desktop consumer can read
  `events.jsonl`/`terminal.log` without parsing the wrapper's `pipeline.log`

#### Scenario: detached run exposes the run store through a machine-readable pointer

- **WHEN** `pipeline run <N> --detach` is invoked
- **THEN** the launcher SHALL write a machine-readable `run-store.json` into the wrapper
  directory (which the caller captures from stdout) containing the run-store run id and the
  absolute `events.jsonl`/`terminal.log` paths
- **AND** a caller SHALL be able to discover `events.jsonl` from that pointer alone, without
  parsing any human-readable prose

#### Scenario: --json-events is forwarded to a detached run

- **WHEN** `pipeline run <N> --detach --json-events` is invoked
- **THEN** the inner detached run SHALL receive `--json-events`

#### Scenario: run store is pinned at the repository root, not the launch directory

- **WHEN** `pipeline run <N> --detach` is invoked from a subdirectory of a git checkout
- **THEN** the pinned run-store directory SHALL be `<git-root>/.agent-pipeline/runs/<run-id>`
- **AND** SHALL NOT be `<subdirectory>/.agent-pipeline/runs/<run-id>`

#### Scenario: an unresolvable repository yields no run-store path at all

- **WHEN** `pipeline run <N> --detach` is invoked where no git repository can be resolved from
  the start directory
- **THEN** the launcher SHALL NOT pin or report any `.agent-pipeline/runs/<run-id>` path
- **AND** SHALL NOT create a `run-store.json` pointer
