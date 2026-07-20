# spec-generation-output-guard Specification

## Purpose
TBD - created by archiving change spec-generation-output-guard. Update Purpose after archive.
## Requirements
### Requirement: Spec-output extraction SHALL isolate the final spec document

The spec-generation output guard SHALL expose an extraction function that takes
the raw harness output and returns the substring beginning at the final spec
document — the region starting at the spec title (`# <title>`) or, absent a
title, the first required section heading (`## Summary`) — discarding any text
that precedes it. Leading narration (e.g. "Let me check the relevant code…") and
text-shaped tool-call blocks (e.g. `**Tool: bash**` followed by a fenced
`` ```json `` command block) that appear before the spec SHALL be removed. When
the raw output already begins with the spec and contains no leading narration,
the extraction SHALL return it unchanged (aside from surrounding whitespace).
Both the `sweep` and `intake` spec-generation paths SHALL route harness output
through this extraction before section validation, so the extracted body — not
the raw transcript — is what reaches validation.

#### Scenario: Narration and a tool-call block precede the spec

- **WHEN** the raw harness output is a narration line, then a `**Tool: bash**`
  block with a fenced `` ```json `` command, then the final spec beginning at
  `# <title>` with all four required sections
- **THEN** the extraction function SHALL return a body that starts at the spec
  title
- **AND** the returned body SHALL contain `## Summary`, `## User story`,
  `## Acceptance criteria`, and `## Out of scope`
- **AND** the returned body SHALL NOT contain the `**Tool: bash**` block or the
  narration line

#### Scenario: Clean spec output is returned unchanged

- **WHEN** the raw harness output begins with `# <title>` and the four required
  sections with no leading narration
- **THEN** the extraction function SHALL return the same spec body (modulo
  leading/trailing whitespace)

#### Scenario: Extracted body is what reaches section validation

- **WHEN** a transcript-shaped harness output is processed by the `sweep` or
  `intake` spec-generation path
- **THEN** the value passed to the section-validation contract SHALL be the
  extracted spec body, not the raw harness output

### Requirement: The guard SHALL classify capture-shaped output distinctly from genuine content failures

The spec-generation output guard SHALL expose a classifier that, given a raw or
extracted harness output that fails section validation, reports whether the
failure is **capture-shaped**. Output SHALL be classified capture-shaped when,
after extraction, the required sections are still absent AND the output contains
narration/tool-call markers (a `**Tool:` marker, a fenced `` ```json `` block
containing a `"command"` key, or a leading conversational preamble such as
"Let me "). Output that fails validation without any such markers — a
valid-looking but genuinely incomplete spec — SHALL NOT be classified
capture-shaped.

#### Scenario: Tool-call artifacts present and no valid spec extracted

- **WHEN** extraction yields no region containing all four required sections
- **AND** the output contains a `**Tool: bash**` block or a fenced
  `` ```json `` block with a `"command"` key
- **THEN** the classifier SHALL report the failure as capture-shaped

#### Scenario: Incomplete spec without capture markers is not capture-shaped

- **WHEN** the output is a plain spec that is missing `## Out of scope` and
  contains no narration or tool-call markers
- **THEN** the classifier SHALL NOT report the failure as capture-shaped

### Requirement: The spec-generation caller SHALL retry once on capture-shaped failure

The spec-generation caller (`sweep` and `intake`) SHALL retry the harness call
exactly once, and only once, when the first call produces output the guard
classifies as capture-shaped, before recording the issue as blocked. If the retry produces a spec
that passes extraction and section validation, the caller SHALL proceed with that
spec. If the retry is also capture-shaped or otherwise invalid, the caller SHALL
record the issue as blocked using the existing missing-sections error. A failure
that is NOT capture-shaped (a genuine content failure) SHALL block immediately
with no retry, so no extra model call is spent on output that will not improve.
The retry SHALL be bounded to at most one additional call per issue.

#### Scenario: First call capture-shaped, retry succeeds

- **WHEN** the first harness call for an issue returns capture-shaped output
- **AND** the single retry returns a valid four-section spec
- **THEN** the caller SHALL proceed with the retried spec
- **AND** the harness SHALL have been invoked exactly twice for that issue

#### Scenario: Both calls capture-shaped

- **WHEN** the first harness call and the single retry both return
  capture-shaped output
- **THEN** the caller SHALL record the issue as blocked
- **AND** the harness SHALL NOT be invoked a third time for that issue

#### Scenario: Genuine content failure is not retried

- **WHEN** the first harness call returns a spec that fails validation but is not
  capture-shaped
- **THEN** the caller SHALL record the issue as blocked without a retry
- **AND** the harness SHALL have been invoked exactly once for that issue

### Requirement: The spec-generation harness invocation SHALL run tool-free

The real dependency implementations SHALL invoke the harness with the lean,
tool-free contract for both the `sweep` and `intake` spec-generation calls
(`realSweepDeps().runHarness`, `realIntakeDeps().runHarness`) — passing the
option that appends `--tools ""` and
`--strict-mcp-config` to the underlying `invoke()` call — so the model is never
granted built-in tools or MCP servers during spec generation. This guarantee
SHALL be drift-guarded by a test.

#### Scenario: Sweep spec-generation invokes lean

- **WHEN** `realSweepDeps().runHarness` is called
- **THEN** the underlying `invoke()` call SHALL receive the lean option
  (`--tools ""` + `--strict-mcp-config` applied)

#### Scenario: Intake spec-generation invokes lean

- **WHEN** `realIntakeDeps().runHarness` is called
- **THEN** the underlying `invoke()` call SHALL receive the lean option
  (`--tools ""` + `--strict-mcp-config` applied)

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

