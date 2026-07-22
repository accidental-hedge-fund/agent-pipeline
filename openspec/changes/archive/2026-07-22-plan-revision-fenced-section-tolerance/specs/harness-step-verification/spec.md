## MODIFIED Requirements

### Requirement: Plan-revision output includes machine-checkable feedback acknowledgement

The plan-revision harness output SHALL contain a `## Feedback Incorporated` section with at
least one `[ADDRESSED]` or `[DEFERRED]` bullet item per feedback point from the plan review.
The pipeline SHALL verify the presence of this section before posting the revised plan as an
issue comment.

The verification SHALL be tolerant of the Markdown wrappers models actually emit. Before
locating the section, the verifier SHALL neutralise code-fence delimiter lines (``` ``` ``` and
`~~~`) so that content inside a fence is scanned as ordinary lines. The verifier SHALL consider
**every** occurrence of the `## Feedback Incorporated` header, not only the first, taking each
occurrence's section to run until the next level-2 heading after it; the acknowledgement
requirement is satisfied when **any** such section contains at least one tagged item. Tag
matching SHALL remain anchored to the start of a line within a section, so a mention of
`[ADDRESSED]` in surrounding prose does not satisfy the gate.

The advisory feedback-coverage count SHALL be the greatest tagged-item count found in any single
section, so that a duplicated header does not double-count the same bullets.

#### Scenario: Plan revision includes acknowledgement section

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line
- **THEN** the step SHALL post the revised plan as an issue comment and proceed

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

#### Scenario: Plan revision lacks acknowledgement section — step blocks

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout does NOT contain a `## Feedback Incorporated` section with at least one `[ADDRESSED]` or `[DEFERRED]` line
- **THEN** the step SHALL block with reason: `"Plan revision output is missing required ## Feedback Incorporated section"`
- **AND** SHALL NOT post the revised plan

#### Scenario: Header present but no tagged items anywhere — step blocks

- **WHEN** the plan-revision harness exits 0
- **AND** its stdout contains one or more `## Feedback Incorporated` headers but no section under any of them contains a line-anchored `[ADDRESSED]` or `[DEFERRED]` item, fenced or unfenced
- **THEN** the step SHALL block with reason: `"Plan revision ## Feedback Incorporated section has no [ADDRESSED] or [DEFERRED] items"`
- **AND** SHALL NOT post the revised plan
