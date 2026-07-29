## MODIFIED Requirements

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
