## ADDED Requirements

### Requirement: Optional material-only events follow SHALL reuse the shared material filter when implemented

When a material-only events follow path is implemented (for example `pipeline logs <run-id> --events --follow --material`, and optionally the same flag on `pipeline loop logs … --events --follow`), the CLI SHALL apply the same shared material-filter rules used by host skill packaging (advance and loop material kinds and spam suppression) and SHALL remain read-only without holding a run-liveness lock. When the flag is absent, existing unfiltered `--events` behavior SHALL remain unchanged. A skill-side material filter script alone is sufficient for the host-neutral progress-notify capability; this engine flag is optional UX sugar.

#### Scenario: Unfiltered events follow remains default

- **WHEN** `pipeline logs <run-id> --events --follow` is invoked without a
  material-only flag
- **THEN** the command SHALL continue to stream full `events.jsonl` lines as
  today
- **AND** SHALL NOT silently drop non-material kinds

#### Scenario: Material flag uses shared filter rules when present

- **WHEN** a material-only events follow flag is implemented and invoked
- **THEN** stdout SHALL include only lines selected by the shared material
  filter rules
- **AND** the run store `events.jsonl` file SHALL remain complete and unmodified

#### Scenario: Material follow stays read-only

- **WHEN** material-only events follow is running
- **THEN** the command SHALL NOT create or hold a `pipeline-*.lock` run-liveness
  reservation
- **AND** SHALL remain classified as a read-only observation command
