## ADDED Requirements

### Requirement: Train advance-wave ready SHALL emit the live loop_run_handoff events path on stderr

Train SHALL emit a machine-readable JSON line on stderr whose `kind` is `loop_run_handoff` and whose `events` field is the absolute `events.jsonl` path from that live handoff when `pipeline train` attaches a successful advance-wave loop (lock held, run ready, before first item dispatch of that wave). Train SHALL flush that line so a supervisor reading the train stderr capture can parse it while train is still running. Train SHALL NOT write that handoff object to `train --json` stdout. Nested `single` / loop handoff, status, and terminal JSON objects SHALL still NOT appear on that stdout stream. Human diagnostics MAY remain on stderr in addition to the JSON line.

#### Scenario: Advance-wave ready includes absolute events on stderr

- **WHEN** a JSON train starts an advance-wave loop that becomes ready
- **THEN** train stderr SHALL contain one JSON line with `kind` equal to `loop_run_handoff`
- **AND** that object SHALL include an absolute `events` path for that run
- **AND** a consumer SHALL be able to parse that path without scraping prose

#### Scenario: Train JSON stdout stays one train_status

- **WHEN** a JSON train emits the advance-wave `loop_run_handoff` on stderr
- **THEN** `train --json` stdout SHALL still be exactly one unfenced JSON object whose `kind` is `train_status`
- **AND** that stdout SHALL NOT contain a `loop_run_handoff` object

#### Scenario: Handoff is available before train completes

- **WHEN** the advance-wave loop is ready and train is still dispatching items
- **THEN** the stderr `loop_run_handoff` line SHALL already have been flushed
- **AND** a concurrent supervisor SHALL be able to read `events` without waiting for the final `train_status`
