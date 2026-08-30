## Purpose

Gives implement and plan prompts a stop-at-first-rung reuse ladder so unattended agents reuse
existing code, stdlib, or native features before they invent a helper, wrapper, or dependency.

## ADDED Requirements

### Requirement: The implementing prompt SHALL place a 7-rung ladder after read-first and before writing

The implementing prompt SHALL instruct the harness to read the touched code first, then stop at
the first holding rung of this ordered ladder, then write: (1) does this need to exist — skip
(YAGNI); (2) already in this codebase — reuse; (3) stdlib does it — use it; (4) native platform
feature — use it; (5) already-installed dependency — use it, and never add a new dependency for
what a few lines can do; (6) one line — one line; (7) only then, the minimum that works. The
ladder SHALL NOT replace reading the touched code.

#### Scenario: implementing prompt contains read-first then the seven rungs

- **WHEN** the implementing prompt is built for any issue
- **THEN** the prompt SHALL instruct the harness to read the touched code before applying the ladder
- **AND** the prompt SHALL list all seven rungs in that order
- **AND** the ladder block SHALL appear before the write / implement instructions

#### Scenario: ladder is not a substitute for reading

- **WHEN** the implementing prompt is built
- **THEN** the prompt SHALL state that the harness stops at the first holding rung after reading
- **AND** SHALL NOT present skip-the-read as a valid rung

### Requirement: The implementing prompt SHALL forbid unrequested abstractions and caller-local bug guards

The implementing prompt SHALL forbid unrequested abstractions, including a one-implementation
interface, a factory for one product, and a config key for a constant. The implementing prompt
SHALL instruct that a bug fix addresses the root cause at the shared function, not a guard in
every named caller.

#### Scenario: no-unrequested-abstractions rule is present

- **WHEN** the implementing prompt is built
- **THEN** the prompt SHALL forbid a one-implementation interface, a factory for one product, and a config key for a constant

#### Scenario: bug fix is at the shared function

- **WHEN** the implementing prompt is built
- **THEN** the prompt SHALL instruct the harness to fix the root cause at the shared function rather than adding a guard in every named caller

### Requirement: Planning prompts SHALL prefer the first holding rung so the plan does not invent a layer

The freeform planning prompt SHALL include a one-liner, after its existing read-in-scope-code
instruction, telling the planner to prefer the first holding rung of the reuse ladder so the
plan does not specify a custom layer the implementer then has to build. The OpenSpec planning
prompt SHALL include the same one-liner so proposal and design artifacts do not invent that
layer.

#### Scenario: freeform planning prompt includes the first-holding-rung one-liner

- **WHEN** the freeform planning prompt is built
- **THEN** the prompt SHALL tell the planner to prefer the first holding rung after reading in-scope code
- **AND** SHALL tell the planner not to invent a custom layer for the implementer to build

#### Scenario: OpenSpec planning prompt includes the same one-liner

- **WHEN** the OpenSpec planning prompt is built
- **THEN** the prompt SHALL tell the planner to prefer the first holding rung
- **AND** SHALL tell the planner not to invent a custom layer in the OpenSpec proposal or design

### Requirement: Ladder intensity SHALL be always full with no mode switch

The pipeline SHALL apply the full ladder on every implementing and planning invocation. The
pipeline SHALL NOT add a config key or prompt mode for `off`, `lite`, `full`, or `ultra`. The
implementing prompt SHALL NOT instruct the harness to ship a one-liner and challenge the rest of
the issue.

#### Scenario: no intensity config key

- **WHEN** pipeline configuration and prompt templates are inspected after this change
- **THEN** no `off|lite|full|ultra` intensity key SHALL be present
- **AND** the implementing and planning prompts SHALL still contain the ladder or one-liner without an operator-selected mode

#### Scenario: ultra-style issue shrinking is forbidden

- **WHEN** the implementing prompt is built
- **THEN** the prompt SHALL NOT tell the harness to ship only a one-liner and defer or challenge the rest of the issue

### Requirement: Fix-round prompts SHALL NOT receive the 7-rung ladder

Fix-round prompts SHALL remain under the existing surgical-fix discipline and SHALL NOT include
the 7-rung YAGNI ladder from this capability. This requirement applies to the standard fix,
test-fix, eval-fix, and visual-fix prompts.

#### Scenario: standard fix prompt omits the ladder

- **WHEN** the standard fix prompt is built
- **THEN** the returned prompt SHALL NOT contain the 7-rung YAGNI ladder

#### Scenario: other fix-round prompts omit the ladder

- **WHEN** the test-fix, eval-fix, or visual-fix prompt is built
- **THEN** the returned prompt SHALL NOT contain the 7-rung YAGNI ladder

### Requirement: Pipeline test bar, trailers, and completeness rules SHALL remain in force

The implementing prompt SHALL still require unit tests for new features and a regression test
for bug fixes. The implementing prompt SHALL still require git trailers on commits. The
implementing prompt SHALL NOT treat tests as YAGNI and SHALL NOT replace existing completeness,
DNR / needs-human, design-gate, or papercut instructions with a three-line output contract.

#### Scenario: tests are not YAGNI

- **WHEN** the implementing prompt is built
- **THEN** the prompt SHALL still require tests for new or changed behavior
- **AND** SHALL NOT state that YAGNI applies to tests

#### Scenario: trailers and completeness remain

- **WHEN** the implementing prompt is built
- **THEN** the prompt SHALL still instruct git trailers on commits
- **AND** SHALL still retain the existing completeness / DNR / design-gate / papercut instruction slots

### Requirement: Safety and explicitly requested work SHALL NOT be simplified away

The implementing prompt SHALL forbid simplifying away trust-boundary validation, data-loss error
handling, security, accessibility, or anything the issue or plan explicitly requests.

#### Scenario: never-simplify-away rule is present

- **WHEN** the implementing prompt is built
- **THEN** the prompt SHALL name trust-boundary validation, data-loss error handling, security, and accessibility as not eligible to drop for YAGNI
- **AND** SHALL forbid dropping work the issue or plan explicitly requests

### Requirement: The ladder SHALL be attributed MIT without vendoring ponytail

The implementing prompt SHALL include an HTML comment attributing the 7-rung ladder to Ponytail
at https://github.com/DietrichGebert/ponytail under the MIT License. The pipeline SHALL NOT add
an `@dietrichgebert/ponytail` dependency, host plugin, marketplace install, or `/ponytail`
command. The pipeline SHALL NOT rebrand itself as ponytail.

#### Scenario: MIT attribution is in the implementing prompt

- **WHEN** the implementing prompt template is loaded
- **THEN** it SHALL contain a comment naming Ponytail, MIT, and https://github.com/DietrichGebert/ponytail

#### Scenario: no ponytail packaging is added

- **WHEN** package manifests, host commands, and prompt templates are inspected after this change
- **THEN** `@dietrichgebert/ponytail` SHALL NOT be a dependency
- **AND** no `/ponytail` command or host-plugin install path SHALL be added

### Requirement: Prompt-builder tests SHALL drift-guard ladder presence and fix-round absence

The test suite SHALL assert that implementing and both planning prompt builders include the
ladder or first-holding-rung one-liner, and that the four fix-round prompt builders do not. Each
assertion SHALL fail when the corresponding instruction is removed from implementing or planning,
or wrongly copied into a fix-round template.

#### Scenario: implementing and planning drift tests bite on removal

- **WHEN** the 7-rung ladder is removed from the implementing prompt, or the first-holding-rung one-liner is removed from a planning prompt
- **THEN** at least one prompt-builder assertion SHALL fail

#### Scenario: fix-round drift tests bite on accidental copy

- **WHEN** the 7-rung ladder is copied into a fix-round prompt template
- **THEN** at least one fix-round prompt-builder assertion SHALL fail

#### Scenario: no extra review stage is added

- **WHEN** this capability is implemented
- **THEN** the pipeline SHALL NOT add a new stage or an extra review-1 / review-2 round to enforce the ladder
