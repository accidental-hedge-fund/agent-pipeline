## ADDED Requirements

### Requirement: The explicit issue-list selector SHALL be invocable end-to-end from the CLI

The top-level CLI positional guard SHALL allow `pipeline loop` (and the host
`pipeline:loop` form that maps to it) to accept one or more issue-number positionals
after the `loop` keyword, so that an explicit issue list reaches loop argument
normalization and becomes a `work-list` selector. No CLI-layer guard SHALL reject a
multi-issue list with an "unexpected argument(s)" error before preflight runs. The
operator SHALL NOT be forced to invent a temporary label or range solely because the
documented issue-list form is unreachable.

The number of issue positionals accepted at the dispatcher SHALL be at least large enough
to cover any work-list that `--range` may expand (the existing `MAX_RANGE_SPAN` ceiling).
Token shape validation (digits only), mutual exclusion with other selectors and with
`--resume`, and empty-selector rules SHALL remain the responsibility of loop argument
normalization — not of the top-level arity guard.

#### Scenario: Multi-issue positionals are not rejected as unexpected arguments

- **WHEN** the operator runs `pipeline loop 649 551 541 334` (with no other selector flags)
- **THEN** the CLI SHALL NOT exit with code 2 for unexpected positional arguments naming
  `551`, `541`, or `334`
- **AND** the loop command handler SHALL receive the positional issues
  `["649", "551", "541", "334"]`
- **AND** argument normalization SHALL produce a selector of type `work-list` with that
  value

#### Scenario: A single issue positional is a one-element work-list

- **WHEN** the operator runs `pipeline loop 649` with no selector flags
- **THEN** argument normalization SHALL produce a selector of type `work-list` with value
  `["649"]`
- **AND** the invocation SHALL NOT be treated as a plain advance of issue 649

#### Scenario: Non-numeric positionals still fail in loop normalization

- **WHEN** the operator runs `pipeline loop 649 not-an-issue`
- **THEN** the command SHALL exit non-zero with an error that names the invalid token as
  not an issue number
- **AND** the failure SHALL come from loop argument normalization (or an equivalent
  loop-owned validation path), not from a generic "unexpected argument(s)" rejection of a
  valid multi-issue list shape

#### Scenario: Issue-list mutual exclusion with other selectors is unchanged

- **WHEN** the operator combines positional issues with another selector flag
  (`--milestone`, `--label`, `--range`, or `--roadmap-slice`) or with `--resume`
- **THEN** argument normalization SHALL reject the combination with a non-zero exit
- **AND** the error SHALL name the conflict using the existing multi-selector / resume
  rules

#### Scenario: Other commands keep their positional caps

- **WHEN** a non-`loop` command that is subject to the shared extra-positionals guard is
  invoked with more positionals than its existing cap
- **THEN** the CLI SHALL still reject the extras with exit code 2
- **AND** only the `loop` command gains multi-issue positional capacity under this change
