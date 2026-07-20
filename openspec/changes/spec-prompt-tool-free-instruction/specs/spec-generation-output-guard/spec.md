## ADDED Requirements

### Requirement: The spec-generation prompt SHALL declare the harness is tool-free

The `intake` and `sweep` spec-generation prompt templates SHALL each contain an
explicit instruction stating that the spec-generation harness has no tools available —
no file reads, greps, shell, or repository exploration — and that the model MUST write
the complete spec in a single pass directly from the provided description, without
attempting to ground it by exploring the repository. This instruction SHALL be
single-sourced as one shared constant (in `core/scripts/prompts/index.ts`) injected
into both templates through a shared placeholder, in the same manner as the existing
shared review blocks (`SEVERITY_RUBRIC`, `CONFIDENCE_CALIBRATION_BLOCK`), so the two
prompts cannot drift. The presence of the instruction in both built prompts SHALL be
drift-guarded by a test. This requirement adds an up-front constraint to the prompt
and SHALL NOT alter the lean, tool-free harness invocation (`--tools ""` +
`--strict-mcp-config`) nor the output-extraction, capture-shaped classification, or
single-retry behavior of the guard.

#### Scenario: Built intake prompt declares the tool-free constraint

- **WHEN** the `intake` spec-generation prompt is built for any description
- **THEN** the rendered prompt SHALL contain the shared tool-free instruction stating
  that no tools (file reads, greps, shell, or repo exploration) are available
- **AND** the rendered prompt SHALL instruct the model to write the spec in one pass
  directly from the provided description

#### Scenario: Built sweep prompt declares the tool-free constraint

- **WHEN** the `sweep` re-spec prompt is built for any existing issue
- **THEN** the rendered prompt SHALL contain the identical shared tool-free instruction
  present in the intake prompt

#### Scenario: Instruction is single-sourced and drift-guarded

- **WHEN** the shared tool-free instruction constant is compared against the built
  intake and sweep prompts
- **THEN** each built prompt SHALL embed the shared constant byte-for-byte
- **AND** a test SHALL fail if either template omits the shared placeholder

#### Scenario: Concrete-code description carries the constraint without a caller preamble

- **WHEN** a description that names concrete file paths and function names (e.g. the
  #421 description verbatim) is passed to the `intake` spec-generation prompt builder
- **THEN** the rendered prompt SHALL contain the tool-free instruction without the
  caller supplying any additional "you have no tools" preamble text
