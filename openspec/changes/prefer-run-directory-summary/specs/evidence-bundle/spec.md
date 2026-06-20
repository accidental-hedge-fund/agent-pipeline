## MODIFIED Requirements

### Requirement: A human-readable summary can be printed from the bundle
The pipeline CLI SHALL support a `--summary <issueNumber>` flag. When this flag is present, the CLI SHALL resolve the evidence bundle for the given issue using the following priority order, print a human-readable summary (at minimum: run identity, per-stage outcome table, review verdict list, override list, and final state), and exit without entering the dispatch loop.

**Bundle resolution priority for `--summary <issueNumber>`:**
1. The CLI SHALL scan `.agent-pipeline/runs/` for all run directories whose run-id begins with `<issueNumber>-` (i.e. `listRunIds(repoDir)` filtered by issue prefix, sorted by mtime descending) and read `summary.json` from the most-recent matching entry.
2. If no run-directory `summary.json` is readable for the issue (absent, corrupt, or parse error), the CLI SHALL fall back to `<stateDir>/<issueNumber>/evidence.json` (the legacy path).
3. If neither location yields a readable bundle, the CLI SHALL exit non-zero and print an error message that names both the run-directory path and the legacy path.

A `summary.json` that exists but cannot be parsed (corrupt JSON or missing required fields) SHALL be treated as absent for fallback purposes — the CLI SHALL not crash and SHALL proceed to the legacy fallback.

**Exact run selection:** The CLI SHALL additionally accept `pipeline summary <run-id>` as a positional sub-command (no issue number, no `--summary` flag). When invoked with a run-id argument, the CLI SHALL read `summary.json` from `.agent-pipeline/runs/<run-id>/` and print the human-readable summary. The `--domain` flag SHALL NOT affect this path; the run directory is located from the repo root alone.

#### Scenario: --summary prints from run-directory summary.json when available
- **WHEN** `pipeline --summary 147` is invoked
- **AND** `.agent-pipeline/runs/` contains at least one directory matching `147-*` with a readable `summary.json`
- **THEN** the CLI SHALL read `summary.json` from the most-recent such directory (by mtime)
- **AND** the output SHALL include the `runId`, `issue`, `branch`, each stage name and its `outcome`, and `finalState`

#### Scenario: --summary falls back to legacy path when no run-directory summary exists
- **WHEN** `pipeline --summary 147` is invoked
- **AND** no `147-*/summary.json` is readable under `.agent-pipeline/runs/`
- **AND** `<stateDir>/147/evidence.json` exists and is valid
- **THEN** the CLI SHALL read and print the legacy bundle without error
- **AND** the process SHALL exit with code 0

#### Scenario: --summary treats corrupt run-directory summary.json as absent
- **WHEN** `pipeline --summary 147` is invoked
- **AND** the latest `147-*/summary.json` under `.agent-pipeline/runs/` exists but contains invalid JSON
- **THEN** the CLI SHALL fall back to the legacy `<stateDir>/147/evidence.json`
- **AND** SHALL NOT crash or emit an unhandled exception

#### Scenario: --summary exits non-zero with informative error when no bundle found
- **WHEN** `pipeline --summary 147` is invoked
- **AND** no readable bundle exists at either the run-directory or legacy location
- **THEN** the process SHALL exit with a non-zero code
- **AND** the error message SHALL name both the run-directory path (`.agent-pipeline/runs/147-*/summary.json`) and the legacy path

#### Scenario: --summary exits zero when bundle exists
- **WHEN** `pipeline --summary <N>` is invoked and a bundle exists for issue N (at either location)
- **THEN** the process SHALL exit with code 0

#### Scenario: --summary exits non-zero when no bundle
- **WHEN** `pipeline --summary <N>` is invoked and no bundle exists for issue N
- **THEN** the process SHALL exit with a non-zero code and print an error message

#### Scenario: pipeline summary <run-id> reads exact run directory
- **WHEN** `pipeline summary <run-id>` is invoked with a known run-id
- **AND** `.agent-pipeline/runs/<run-id>/summary.json` exists and is valid
- **THEN** the CLI SHALL print the human-readable summary from that file
- **AND** the process SHALL exit with code 0

#### Scenario: pipeline summary <run-id> exits non-zero for unknown run-id
- **WHEN** `pipeline summary <run-id>` is invoked with a run-id that has no matching directory or lacks a `summary.json`
- **THEN** the process SHALL exit with a non-zero code and print an error message naming the expected path

#### Scenario: pipeline summary <run-id> is domain-independent
- **WHEN** `pipeline summary <run-id>` is invoked without a `--domain` flag
- **THEN** the CLI SHALL locate the run directory from the repo root (`.agent-pipeline/runs/<run-id>/`) without consulting any domain config
