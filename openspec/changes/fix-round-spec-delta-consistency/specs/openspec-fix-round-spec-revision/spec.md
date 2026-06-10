## ADDED Requirements

### Requirement: Fix rounds SHALL be permitted and instructed to revise spec deltas when a finding implies behavioral divergence

When OpenSpec is active and a fix round's harness prompt includes spec deltas, the prompt SHALL explicitly permit the harness to update the active change's `specs/**` files (and `tasks.md`) if any review finding's resolution changes behavior described by those deltas. The instruction SHALL be conditional — it applies only when the fix implies a behavioral change, not as a general license to rewrite the spec.

#### Scenario: Fix prompt includes spec-revision instruction when OpenSpec is active

- **WHEN** the pipeline builds the fix prompt and OpenSpec is active with spec deltas available
- **THEN** the fix prompt SHALL include an instruction that if a finding's fix changes behavior described by the spec deltas, the harness SHALL update the relevant `specs/**` files to match the new behavior

#### Scenario: Fix prompt does not include spec-revision instruction when OpenSpec is inactive

- **WHEN** the pipeline builds the fix prompt and OpenSpec is not active (no spec deltas present)
- **THEN** the fix prompt SHALL be identical to the non-OpenSpec path, with no spec-revision instruction

#### Scenario: Fix harness that makes no behavioral change leaves spec deltas untouched

- **WHEN** a fix harness addresses findings whose resolution does not change behavior described by the spec deltas
- **THEN** the harness SHALL NOT modify `specs/**` files and the spec deltas SHALL remain unchanged after the fix commit

### Requirement: Fix rounds SHALL re-validate the change after any spec delta revision

After a fix harness updates one or more spec delta files under `openspec/changes/<id>/specs/**`, the fix harness SHALL run `openspec validate <id>` and the validation SHALL pass before the fix commit is created. A validation failure after spec revision SHALL cause the fix round to block rather than advance.

#### Scenario: Spec revision passes validation and fix commit proceeds

- **WHEN** a fix harness updates spec deltas and `openspec validate <id>` exits 0
- **THEN** the fix harness SHALL include the updated spec files in its fix commit alongside the code changes

#### Scenario: Spec revision fails validation and fix round blocks

- **WHEN** a fix harness updates spec deltas and `openspec validate <id>` exits non-zero
- **THEN** the fix harness output SHALL describe the validation failure
- **AND** the pipeline SHALL NOT advance until a subsequent fix resolves both the code and the structural validation error

### Requirement: The spec context section in the fix prompt SHALL use consistency framing, not immutable-truth framing

The rendered spec section injected into the fix harness prompt (`specContextSection`) SHALL express that the implementation must stay consistent with the spec deltas, rather than framing the spec as immutable truth that the implementation must satisfy. This permits the harness to recognize when the spec itself needs updating rather than treating the spec as the sole authority.

#### Scenario: specContextSection renders with consistency framing

- **WHEN** `specContextSection` is called with non-empty spec context
- **THEN** the rendered string SHALL contain language expressing "must stay consistent with" (or equivalent) rather than "must satisfy"

#### Scenario: specContextSection rendering is unchanged when spec context is absent

- **WHEN** `specContextSection` is called with an empty or absent spec context
- **THEN** the function SHALL return an empty string, identical to current behavior
