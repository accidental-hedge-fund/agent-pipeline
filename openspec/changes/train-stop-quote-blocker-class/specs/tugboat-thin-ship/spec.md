## ADDED Requirements

### Requirement: Failed train notify detail SHALL preserve train-produced stop class and reason text

When the train phase fails and the train blocker sidecar, train capture, or `train_status.blocker` contains structured stop or block diagnostic text produced by train (for example a `loop_run_stopped.reason` token such as `supervisor_no_progress`, a `loop_item_blocked.class` token, an issue number, or a blocker_kind / comment first line), Tugboat’s failed-phase state and notify detail SHALL include that text (or a faithful prefix of it). Tugboat SHALL NOT collapse the operator-visible train failure detail to an exit-only phrase when that richer train-produced text is present in the blocker or capture. Tugboat remains a thin reader of train output and SHALL NOT become a second loop-event diagnosis engine; enrichment of missing structured evidence remains train’s responsibility under `integrated-train-mode`.

#### Scenario: Structured train blocker reaches notify

- **WHEN** train fails and `train.json.blocker` (or the equivalent train capture blocker field) contains `supervisor_no_progress` and an issue number
- **THEN** the failed train state/notify detail SHALL include `supervisor_no_progress` and that issue number
- **AND** it SHALL NOT be only an exit-only phrase such as `pipeline single exited with code 1` or `train exit 1`

#### Scenario: Exit-only train blocker is not rewritten into a fake class

- **WHEN** train fails and the train blocker text is only an exit code / exit-only phrase with no structured class
- **THEN** Tugboat SHALL still surface that blocker or capture text as available
- **AND** it SHALL NOT invent a stop class name for notify
