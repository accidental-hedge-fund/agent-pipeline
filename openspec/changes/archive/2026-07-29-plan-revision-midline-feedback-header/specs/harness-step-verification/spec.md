## MODIFIED Requirements

### Requirement: Plan-revision output includes machine-checkable feedback acknowledgement

The plan-revision harness output SHALL contain a `## Feedback Incorporated` section with at
least one `[ADDRESSED]` or `[DEFERRED]` bullet item per feedback point from the plan review.
The pipeline SHALL verify the presence of this section before posting the revised plan as an
issue comment.

The verification SHALL be tolerant of the Markdown wrappers models actually emit. Before
locating the section, the verifier SHALL neutralise code-fence delimiter lines (``` ``` ``` and
`~~~`) so that content inside a fence is scanned as ordinary lines. The verifier SHALL also
accept a **mid-line or preamble-glued** `## Feedback Incorporated` header: when that header
token appears not at line start, the verifier SHALL normalise it to a line-start heading (or
otherwise treat it as an equivalent section header) before extraction, so a semantically
present acknowledgement is not reported as missing solely because of header placement.

The verifier SHALL consider **every** occurrence of the `## Feedback Incorporated` header, not
only the first, taking each occurrence's section to run until the next level-2 heading after
it; the acknowledgement requirement is satisfied when **any** such section contains at least
one tagged item. Tag matching SHALL remain anchored to the start of a line within a section,
so a mention of `[ADDRESSED]` in surrounding prose does not satisfy the gate.

The advisory feedback-coverage count SHALL be the greatest tagged-item count found in any single
section, so that a duplicated header does not double-count the same bullets.

When verification still fails after normalisation (missing section, or header present with no
line-start tagged items), the planning stage SHALL treat the failure as a **retryable
output-contract failure**: it SHALL perform at least one automatic format-repair re-prompt of
the plan-revision harness before applying a terminal block. The repair prompt SHALL instruct
the implementer to emit `## Feedback Incorporated` exactly once as a line-start level-2
heading with line-start `[ADDRESSED]` / `[DEFERRED]` bullets. Only after the bounded
format-repair budget is exhausted MAY the stage block without posting the revised plan. The
terminal block for exhausted format-repair SHALL use `needs-human` disposition (not a new
blocker class and not an immediate pre-retry `needs-human`).

#### Scenario: Plan revision includes acknowledgement section

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line
- **THEN** the step SHALL post the revised plan as an issue comment and proceed

#### Scenario: Mid-line or preamble-glued header with tagged items is accepted

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains the text `## Feedback Incorporated` glued to the end of a non-empty preamble on the same line (not line-anchored)
- **AND** at least one subsequent line-start `[ADDRESSED]` or `[DEFERRED]` item appears under that section
- **THEN** the verification SHALL succeed
- **AND** the step SHALL post the revised plan as an issue comment and proceed
- **AND** the step SHALL NOT report `"Plan revision output is missing required ## Feedback Incorporated section"`

#### Scenario: Fenced section with a duplicated header is accepted

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains a bare `## Feedback Incorporated` header followed by a fenced block whose first line repeats that header and whose remaining lines are `[ADDRESSED]` / `[DEFERRED]` bullets
- **THEN** the verification SHALL succeed
- **AND** the step SHALL post the revised plan as an issue comment and proceed

#### Scenario: Tagged items inside a code fence under a single header are accepted

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains one `## Feedback Incorporated` header whose tagged bullets all appear inside a code fence
- **THEN** the verification SHALL succeed

#### Scenario: Duplicated header does not inflate the coverage count

- **WHEN** the same three tagged bullets are reachable from two occurrences of the `## Feedback Incorporated` header
- **THEN** the advisory coverage comparison SHALL use a tagged-item count of three, not six

#### Scenario: Pure output-contract failure retries before needs-human

- **WHEN** the plan-revision harness exits 0
- **AND** after normalisation its stdout still lacks a valid `## Feedback Incorporated` section with at least one line-start tagged item
- **AND** the format-repair retry budget for this plan-revision step has not been exhausted
- **THEN** the step SHALL re-invoke the plan-revision harness with a format-repair instruction
- **AND** SHALL NOT call `setBlocked` with `needs-human` for that failure until the retry budget is exhausted

#### Scenario: Format-repair success proceeds

- **WHEN** a format-repair re-prompt produces stdout that passes acknowledgement verification
- **THEN** the step SHALL post the revised plan as an issue comment and proceed
- **AND** SHALL NOT leave the issue blocked for the prior contract failure

#### Scenario: Plan revision lacks acknowledgement section after retries — step blocks

- **WHEN** the plan-revision harness exits 0
- **AND** after normalisation and exhaustion of the format-repair retry budget its stdout does NOT contain a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line
- **THEN** the step SHALL block with reason: `"Plan revision output is missing required ## Feedback Incorporated section"`
- **AND** the terminal block disposition SHALL be `needs-human`
- **AND** SHALL NOT post the revised plan

#### Scenario: Header present but no tagged items anywhere — step blocks after retries

- **WHEN** the plan-revision harness exits 0
- **AND** after normalisation and exhaustion of the format-repair retry budget its stdout contains one or more `## Feedback Incorporated` headers but no section under any of them contains a line-anchored `[ADDRESSED]` or `[DEFERRED]` item, fenced or unfenced
- **THEN** the step SHALL block with reason: `"Plan revision ## Feedback Incorporated section has no [ADDRESSED] or [DEFERRED] items"`
- **AND** SHALL NOT post the revised plan
