## ADDED Requirements

### Requirement: Stage accounting records sanitized prompt size

For every harness invocation that emits a stage accounting record, the pipeline SHALL record numeric prompt-size telemetry when the prompt string is available. The record SHALL include `prompt_chars` and `prompt_estimated_tokens` as non-negative integers. The pipeline SHALL NOT persist raw prompt text, prompt excerpts, prompt hashes that can be used as content identifiers, responses, transcripts, local usage-log paths, or secrets as part of this telemetry.

#### Scenario: Harness invocation records prompt size
- **WHEN** a harness invocation receives a prompt and emits a `stage_accounting` event
- **THEN** the event SHALL include `prompt_chars` equal to the prompt length
- **AND** `prompt_estimated_tokens` SHALL be a non-negative estimate derived from prompt length

#### Scenario: Prompt content remains absent
- **WHEN** the prompt contains issue text, code, or secret-looking strings
- **THEN** no persisted accounting artifact SHALL contain the raw prompt text or an excerpt of it
- **AND** the persisted prompt telemetry SHALL be limited to numeric size fields
