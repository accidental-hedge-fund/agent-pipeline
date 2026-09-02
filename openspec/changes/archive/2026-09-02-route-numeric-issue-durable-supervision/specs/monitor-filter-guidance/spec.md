## MODIFIED Requirements

### Requirement: Run-store event follow SHALL be the primary host monitoring contract

`core/scripts/host-skill.ts` and every generated host SKILL SHALL use structured run-store event follow as the primary monitoring contract. The default numeric `pipeline <N>` path and the `pipeline single` / `pipeline loop` path SHALL retain the handoff `loop_run_id` and follow `pipeline loop logs <loop-run-id> --events --follow`; after `loop_item_advance_linked`, they SHALL retain that event's `pipeline_run_id` value as `advance_run_id` and also follow `pipeline logs <advance-run-id> --events --follow`. Public numeric drive SHALL NOT use a top-level `advance_run_handoff` as its canonical follow identity. The compact contract SHALL direct human-visible progress from the applicable streams through the shared material filter or an equivalent `--material` surface. It SHALL NOT recommend the broad stdout alternation `"^\[pipeline\]|^\[exit code|FAILED|timed out|blocked label|approved|needs-attention|→ "` as the primary filter. Durable docs MAY retain the legacy issue-scoped stdout grep `^\[pipeline\] #<N>: ` as a diagnostic for legacy logs, but each generated one-pager SHALL carry only the structured retained-id follow guidance and a durable-doc pointer.

#### Scenario: Tight filter used in Monitor command

- **WHEN** an operator arms a host follow for a default numeric drive
- **THEN** the compact one-pager SHALL name the retained-id loop command and the shared material filter
- **AND** it SHALL NOT recommend the broad stdout alternation as the primary filter
- **AND** after linkage it SHALL also name the retained-id linked-advance command
- **AND** it SHALL NOT present a top-level `advance_run_handoff` as the canonical numeric identity

#### Scenario: Concrete substitution example provided

- **WHEN** the compact contract or durable docs show a structured follow example
- **THEN** the example SHALL use an explicit `<loop-run-id>` / `<advance-run-id>` or concrete retained durable ids
- **AND** it SHALL distinguish primary `pipeline loop logs` from linked-advance `pipeline logs`
- **AND** it SHALL NOT claim `pipeline status <N>` discovers either id
