## MODIFIED Requirements

### Requirement: The pipeline SHALL expose a `doctor` command that runs all preflight checks

The pipeline CLI SHALL expose a `doctor` subcommand. When invoked without `--harness-smoke`, it
SHALL run every declared **static** preflight check, collect results, print a per-check pass/fail
summary with remediation text for each failing check, and exit with code 0 when all checks pass or
code 1 when any check fails. Those static checks SHALL be deterministic and SHALL NOT invoke a
language model or consume inference tokens.

When `--harness-smoke` is passed, doctor SHALL still run the static preflight checks and SHALL
additionally run the opt-in dynamic harness-smoke path defined by the `doctor-harness-smoke`
capability. Dynamic harness smoke MAY invoke language models (approximately one cheap model call
per unique configured treatment) and is an explicit, documented exception to the model-free static
doctor rule. Default doctor (no `--harness-smoke`) remains model-free.

#### Scenario: All checks pass — doctor exits 0

- **WHEN** `pipeline doctor` is run and every check returns a passing result
- **THEN** the command SHALL print a summary listing each check as passing
- **AND** SHALL exit with code 0

#### Scenario: One or more checks fail — doctor exits 1 with remediation

- **WHEN** `pipeline doctor` is run and at least one check returns a failing result
- **THEN** the command SHALL print a summary listing each check's result
- **AND** each failing check SHALL include at least one sentence of actionable remediation text describing the corrective action
- **AND** SHALL exit with code 1

#### Scenario: Default doctor performs no model calls

- **WHEN** `pipeline doctor` is invoked without `--harness-smoke`
- **THEN** it SHALL NOT invoke a language model or consume inference tokens

#### Scenario: Opt-in harness smoke may invoke models

- **WHEN** `pipeline doctor --harness-smoke` is invoked
- **THEN** the static preflight checks SHALL remain model-free
- **AND** the harness-smoke path MAY perform cheap model-consuming canned prompts for configured
  treatments as specified by `doctor-harness-smoke`
- **AND** help or summary text SHALL make that cost expectation visible to the operator
