## ADDED Requirements

### Requirement: An append-only issue-level evidence history artifact records every finalized run

The pipeline SHALL maintain an append-only, issue-scoped evidence history artifact at
`.agent-pipeline/history/issue-<N>.jsonl` (one JSON object per line). At finalization, after
the run's `summary.json` and the legacy `<stateDir>/<issue>/evidence.json` are written,
`finalizeRun()` SHALL append exactly one line to this artifact for the run being finalized.
Appending SHALL never read, rewrite, reorder, or truncate previously written lines. The
artifact SHALL be created on its first write if absent.

#### Scenario: entry appended at finalization

- **WHEN** `finalizeRun()` finalizes a run for issue N
- **THEN** exactly one new line SHALL be appended to `.agent-pipeline/history/issue-<N>.jsonl`
- **AND** the artifact SHALL be created if it did not already exist

#### Scenario: re-run appends rather than replaces

- **WHEN** the pipeline finalizes a second run for issue N that already has history
- **THEN** a new line SHALL be appended for the second run
- **AND** the line recorded for the first run SHALL remain present and unchanged

#### Scenario: N finalized runs yield exactly N entries

- **WHEN** issue N has been finalized N times
- **THEN** `.agent-pipeline/history/issue-<N>.jsonl` SHALL contain exactly N entries
- **AND** each entry SHALL carry its own run id, per-stage timings, and outcome

---

### Requirement: Each history entry carries the run's identity, per-stage timings, and outcome

Each line of the issue-level history artifact SHALL be a JSON object containing: `schema_version`
(integer), `run_id` (the filesystem-safe run-directory identifier for the run), `issue`, `pr`
(or `null`), `branch` (or `null`), `final_state`, `finalized_at`, and `stages` — an array with
one entry per recorded stage, each carrying `stage`, `enteredAt`, `exitedAt`, `durationMs`, and
`outcome`. The `run_id` SHALL match the run-directory identifier used by that run's
`summary.json`, so a history entry joins back to its run directory.

#### Scenario: entry contains identity and per-stage timing

- **WHEN** a run for issue N is finalized
- **THEN** its history entry SHALL contain `run_id`, `issue`, `final_state`, and `finalized_at`
- **AND** SHALL contain a `stages` array with one entry per recorded stage
- **AND** each stage entry SHALL contain `stage`, `enteredAt`, `exitedAt`, `durationMs`, and
  `outcome`

#### Scenario: run_id joins to the run directory

- **WHEN** a history entry is written for a run
- **THEN** its `run_id` SHALL equal the run-directory identifier used by that run's
  `summary.json` (the basename of `.agent-pipeline/runs/<run-id>/`)

---

### Requirement: History artifact writes are sanitized and non-fatal

Each history line SHALL be serialized through the same field-level sanitization applied to
`summary.json` (deep sanitization, secret redaction, and the write-time injection denylist)
so that no secret, token, or injected content reaches the artifact. Writing the history entry
SHALL satisfy the non-fatal I/O contract of `run-artifact-conventions`: any error from the
append SHALL be caught, logged as a warning, and SHALL NOT propagate — `finalizeRun()` SHALL
still complete and still write `summary.json` and the legacy `evidence.json`.

#### Scenario: history write error does not fail finalization

- **WHEN** appending to `.agent-pipeline/history/issue-<N>.jsonl` throws an error
- **THEN** `finalizeRun()` SHALL still complete
- **AND** `summary.json` and the legacy `<stateDir>/<issue>/evidence.json` SHALL still be
  written
- **AND** a warning SHALL be logged with the error detail

#### Scenario: secrets are redacted from history entries

- **WHEN** the finalized bundle contains a value matching the secret pattern
- **THEN** that value SHALL be redacted in the written history line, as it is in `summary.json`

---

### Requirement: The issue-level history artifact does not change legacy evidence semantics

The issue-level history artifact SHALL be an additional, separate file; it SHALL NOT replace or
alter the legacy `<stateDir>/<issue>/evidence.json` write. The legacy per-issue evidence bundle
SHALL continue to be written and to reflect the most recent run, so existing consumers (e.g.
`pipeline N --summary`) continue to work unchanged.

#### Scenario: legacy evidence.json unchanged by the history artifact

- **WHEN** a run is finalized and the history line is appended
- **THEN** `<stateDir>/<issue>/evidence.json` SHALL still be written with the finalized run's
  bundle content
- **AND** `pipeline N --summary` SHALL read the legacy path (or run-directory summary) exactly
  as before this change
