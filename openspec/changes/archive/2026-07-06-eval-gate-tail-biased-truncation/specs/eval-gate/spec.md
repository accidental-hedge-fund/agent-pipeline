## MODIFIED Requirements

### Requirement: eval outcome is recorded on the issue/PR as a comment

After each eval run (pass or fail, gate or advisory), the stage SHALL post a `## Eval Gate` comment on the issue containing: mode, outcome (PASS/FAIL), elapsed time, and an excerpt of the combined stdout/stderr output bounded to `MAX_COMMENT_OUTPUT` (2000) source characters. When the output exceeds the bound the excerpt SHALL be produced by the tail-biased elision strategy defined in "Output excerpts preserve the summary tail", not by keeping only the leading characters.

#### Scenario: comment posted on pass

- **WHEN** the eval command exits 0
- **THEN** a comment beginning with `## Eval Gate` SHALL be posted on the issue
- **AND** the comment SHALL state the outcome as PASS
- **AND** the comment SHALL include elapsed time and a stdout excerpt bounded to ≤2000 source characters

#### Scenario: comment posted on fail

- **WHEN** the eval command exits non-zero
- **THEN** a comment beginning with `## Eval Gate` SHALL be posted on the issue
- **AND** the comment SHALL state the outcome as FAIL
- **AND** the comment SHALL include elapsed time and a stdout/stderr excerpt bounded to ≤2000 source characters

## ADDED Requirements

### Requirement: Output excerpts preserve the summary tail

When the combined eval output exceeds `MAX_COMMENT_OUTPUT` characters, the excerpt posted to the issue SHALL preserve the **tail** of the output (where eval harnesses print their pass/fail summary) rather than only the leading characters. The excerpt SHALL also include a leading **head** portion (command-invocation and setup context) followed by an explicit middle-elision marker before the tail portion. The marker SHALL indicate that intervening content was dropped (for example, by stating the number of characters removed) so the reader knows the excerpt is not contiguous. The head and tail source characters shown SHALL together not exceed `MAX_COMMENT_OUTPUT`; the marker text itself is not counted against that budget.

When the combined output is at or below `MAX_COMMENT_OUTPUT` characters, the excerpt SHALL equal the output verbatim with no elision marker added.

#### Scenario: over-limit output keeps the end-of-run summary

- **WHEN** the eval output exceeds `MAX_COMMENT_OUTPUT` characters
- **AND** the pass/fail summary appears in the final characters of the output
- **THEN** the posted excerpt SHALL contain those final characters (the summary tail)
- **AND** the posted excerpt SHALL contain a leading head portion followed by a middle-elision marker before the tail portion
- **AND** the head plus tail source characters shown SHALL not exceed `MAX_COMMENT_OUTPUT`

#### Scenario: within-limit output is unchanged

- **WHEN** the eval output is at or below `MAX_COMMENT_OUTPUT` characters
- **THEN** the posted excerpt SHALL equal the output verbatim
- **AND** no elision marker SHALL be added

### Requirement: Tail-biased excerpting is uniform across all failure paths

The tail-biased excerpting strategy SHALL be applied identically to every path that posts eval output: gate-mode failure, advisory-mode failure, timeout failure, and spawn/runner error. No failure path SHALL keep only the leading characters of the output.

#### Scenario: gate-mode failure uses tail-biased excerpt

- **WHEN** the eval command fails in `gate` mode and its output exceeds `MAX_COMMENT_OUTPUT`
- **THEN** the blocking message SHALL contain the output's summary tail via the tail-biased excerpt

#### Scenario: advisory-mode failure uses tail-biased excerpt

- **WHEN** the eval command fails in `advisory` mode and its output exceeds `MAX_COMMENT_OUTPUT`
- **THEN** the recorded result comment SHALL contain the output's summary tail via the tail-biased excerpt

#### Scenario: timeout failure uses tail-biased excerpt

- **WHEN** the eval command times out and its captured output exceeds `MAX_COMMENT_OUTPUT`
- **THEN** the timeout blocking message SHALL contain the output's summary tail via the tail-biased excerpt

#### Scenario: spawn/runner error uses tail-biased excerpt

- **WHEN** the eval command cannot be executed (spawn/runner error) and its captured output exceeds `MAX_COMMENT_OUTPUT`
- **THEN** the runner-error blocking message SHALL contain the output's summary tail via the tail-biased excerpt
