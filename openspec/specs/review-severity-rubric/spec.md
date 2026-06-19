# review-severity-rubric Specification

## Purpose
TBD - created by archiving change review-severity-calibration. Update Purpose after archive.
## Requirements
### Requirement: The severity rubric SHALL establish LOW as a populated tier

The severity rubric SHALL, in its single-sourced form injected into both review prompts
(`{{severity_rubric}}`), explicitly classify the following finding classes as **LOW**: defensive hardening,
observability gaps, minor inconsistencies, narrow edge-case nitpicks, and "the next variant of a
class already fixed this round." The rubric SHALL describe LOW as a tier the reviewer is expected
to use for these classes, not a residual category — so a hardening note or a narrow nitpick lands
at LOW rather than being rounded up to MEDIUM.

#### Scenario: Rubric names the LOW classes

- **WHEN** either review prompt is rendered
- **THEN** the injected severity rubric SHALL name defensive hardening, observability gaps, minor
  inconsistencies, narrow edge-case nitpicks, and the next-variant-of-an-already-fixed-class as
  LOW

#### Scenario: A hardening nitpick is classified LOW, not MEDIUM

- **WHEN** the reviewer identifies a defensive-hardening suggestion or a narrow edge-case nitpick
  with no concrete production impact
- **THEN** the rubric SHALL direct the reviewer to assign severity LOW rather than MEDIUM

### Requirement: The severity rubric SHALL include anti-inflation guidance and a concrete LOW example

The severity rubric SHALL contain an explicit directive that the LOW classes are LOW and SHALL
NOT be inflated to MEDIUM to make them block, and SHALL include at least one concrete LOW example
(a hardening or nitpick finding) the model can imitate. The guidance SHALL make clear that LOW is
advisory by policy and that inflating a LOW finding to force a fix round is the failure being
prevented.

#### Scenario: Rubric carries an anti-inflation directive

- **WHEN** either review prompt is rendered
- **THEN** the injected severity rubric SHALL contain an explicit instruction not to inflate the
  LOW classes to MEDIUM

#### Scenario: Rubric carries a concrete LOW example

- **WHEN** either review prompt is rendered
- **THEN** the injected severity rubric SHALL include at least one worked LOW example a reviewer
  can pattern-match a hardening or nitpick finding against

### Requirement: The review prompts SHALL document when to mark a finding non-blocking

The review prompts SHALL include single-sourced guidance, injected into both prompts, documenting
when to emit a finding with the non-blocking marker (`blocking: false`): an out-of-scope
observation, a pre-existing weakness recorded for context, or a purely informational note. The
guidance SHALL state that the specific reason belongs in the finding `body`, and that a
non-blocking finding is recorded but does not route to a fix round. The guidance SHALL be
single-sourced so the standard and adversarial prompts cannot drift.

#### Scenario: Both prompts document the non-blocking marker

- **WHEN** the standard or the adversarial review prompt is rendered
- **THEN** the prompt SHALL contain guidance describing `blocking: false` and the out-of-scope /
  pre-existing / informational situations in which to use it

#### Scenario: Guidance is single-sourced across rounds

- **WHEN** both review prompts are rendered in the same run
- **THEN** the non-blocking guidance text SHALL be identical in both, derived from one shared
  source rather than hand-copied per prompt

