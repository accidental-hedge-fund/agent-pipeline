## RENAMED Requirements

- FROM: ### Requirement: The `merge` sub-command is a human-only CLI surface
- TO: ### Requirement: The `merge` sub-command is an operator-authorized CLI surface

## MODIFIED Requirements

### Requirement: The `merge` sub-command is an operator-authorized CLI surface

The Pipeline CLI SHALL accept `merge` as a positional sub-command keyword that takes one pull-request number and that is never invoked by the autonomous `advance` loop. It SHALL be dispatched when the first positional argument is the string `merge` (case-sensitive). The command is an explicit operator-authorized surface: the operator MAY invoke it directly, or a disabled deployment wrapper MAY invoke it as an operator delegate after that wrapper validates an authenticated, immutable, expiring grant for the exact repository, base, issue, and action. Before invocation, the wrapper SHALL deterministically resolve that issue's one linked pull request and SHALL bind and revalidate its exact head. The `merge` command itself SHALL NOT claim to validate a Buzz event or deployment grant, and all of its existing merge gates SHALL remain in effect.

#### Scenario: Invoked directly by an operator with a PR number

- **WHEN** the operator runs `pipeline merge 42`
- **THEN** the command dispatches the merge handler with pull-request number 42 and does not advance any Pipeline stage label

#### Scenario: Invoked by a scoped operator delegate

- **WHEN** a deployment wrapper has validated an active grant for the issue, resolved its one linked pull request as 42, bound its current head, and invokes `pipeline merge 42`
- **THEN** the command SHALL apply the same mergeability, check, issue-stage, and exact-head gates as a direct operator invocation
- **AND** the advance loop SHALL remain uninvolved

#### Scenario: Missing PR number exits with a usage error

- **WHEN** the user runs `pipeline merge` with no pull-request number
- **THEN** the command SHALL exit non-zero with a usage error that states that a pull-request number is required

#### Scenario: Non-numeric argument is rejected

- **WHEN** the user runs `pipeline merge foo` where `foo` is not a positive integer
- **THEN** the command SHALL exit non-zero with an error that states that a numeric pull-request number is required
