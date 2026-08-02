# plan-revision-output-contract Specification

## Purpose
TBD - created by archiving change plan-revision-fenced-section-tolerance. Update Purpose after archive.
## Requirements
### Requirement: The plan-revision prompt SHALL specify an unfenced, single-header acknowledgement section

The `plan_revision` prompt template SHALL instruct the harness that the `## Feedback
Incorporated` section is emitted as plain Markdown in the response body: it SHALL state that the
section MUST NOT be wrapped in a code fence, that the `## Feedback Incorporated` header MUST
appear exactly once in the output, and that the header MUST appear at the **start of a line**
(not glued to preamble text on the same line). The template SHALL NOT contain a fenced code block
whose content is a `## Feedback Incorporated` header, because models copy such an example
verbatim and produce a fenced, duplicated-header section.

Any format illustration SHALL be rendered as plain Markdown lines that are not copyable as a
fenced block, while still showing the `[ADDRESSED]` / `[DEFERRED]` tag shape.

#### Scenario: Rendered prompt states the unfenced, single-header, line-start constraints

- **WHEN** the `plan_revision` prompt is rendered for a plan revision
- **THEN** its text SHALL state that the `## Feedback Incorporated` section must not be placed inside a code fence
- **AND** its text SHALL state that the `## Feedback Incorporated` header must appear exactly once
- **AND** its text SHALL state that the `## Feedback Incorporated` header must appear at the start of a line

#### Scenario: Prompt contains no fenced acknowledgement-header example

- **WHEN** the `plan_revision` prompt template is inspected
- **THEN** no fenced code block in it SHALL contain a `## Feedback Incorporated` header line

#### Scenario: Format illustration is preserved

- **WHEN** the `plan_revision` prompt is rendered
- **THEN** it SHALL still show the `[ADDRESSED]` and `[DEFERRED]` tag shape as an example of the required bullet format

#### Scenario: Contract is drift-guarded by a test

- **WHEN** the acknowledgement-format wording (including the line-start constraint) is removed from the `plan_revision` template
- **THEN** the prompt output-contract test suite SHALL fail

### Requirement: Plan-revision acknowledgement verification SHALL consume the shared stage-output contract layer

Plan-revision acknowledgement verification SHALL use the versioned stage-output contract
`plan-revision.ack@1` (or a successor) and the shared format-repair policy for the
machine-checkable `## Feedback Incorporated` section. Prompt template wording requirements in
this capability remain in force and SHALL stay drift-guarded; this requirement does not replace
those prompt constraints. Pure shape failures after the shared repair budget is exhausted
SHALL terminal as `harness-contract` under `pipeline/stage-diagnostic@1` rather than solely as
product `needs-human`.

#### Scenario: Prompt contract and validation contract both apply

- **WHEN** a plan-revision round runs
- **THEN** the rendered prompt SHALL still state the unfenced, single-header, line-start
  acknowledgement constraints required by this capability
- **AND** the resulting stdout SHALL be validated through `plan-revision.ack@1` before the
  revised plan is posted

#### Scenario: Exhausted shape failure is not product needs-human alone

- **WHEN** plan-revision stdout fails acknowledgement validation after shared repair exhaustion
- **THEN** the terminal diagnostic reason SHALL be `harness-contract`
- **AND** SHALL NOT be solely `needs-human` for that pure shape failure

