## ADDED Requirements

### Requirement: Fixture integrity preflight SHALL verify every committed fixture base_commit is a reachable git object

The engine SHALL provide a fixture integrity preflight that, for every committed evaluation
fixture under the corpus (and every fixture id referenced by an experiment before treatments
execute), verifies that the fixture's full `base_commit` SHA resolves to a git object of type
`commit` in the clone used for the check, or that the fixture declares an explicit bootstrap
procedure that materializes that object before cells run. A missing object without a successful
bootstrap SHALL fail the preflight naming the fixture id and the SHA. The check SHALL be
model-free and SHALL NOT consume inference tokens.

#### Scenario: Reachable base_commit passes static preflight

- **WHEN** a fixture's `base_commit` is a full SHA present as a commit object in the clone
- **THEN** the reachability check for that fixture SHALL pass

#### Scenario: Missing base_commit object fails naming fixture and SHA

- **WHEN** a fixture's `base_commit` is not present as a git object and no bootstrap materializes it
- **THEN** preflight SHALL fail
- **AND** the failure message SHALL name the fixture id and the missing SHA
- **AND** no treatment for an experiment referencing that fixture SHALL execute

#### Scenario: Declared bootstrap materializes the object before cells

- **WHEN** a fixture declares an explicit object bootstrap and preflight runs that bootstrap
  successfully
- **THEN** the `base_commit` SHALL be reachable as a commit object before any cell worktree is
  created for that fixture

---

### Requirement: Doctor SHALL expose a model-free static fixture integrity check

The pipeline `doctor` command (default, without model-consuming flags) SHALL include a static
fixture integrity check covering at minimum: `base_commit` object reachability for every
committed corpus fixture, smoke-only mark consistency with `grader_refs`, and static path-token
sanity for check command strings against the repository's test layout policy. Failure of this
check SHALL contribute to doctor's non-zero exit and SHALL include remediation text naming the
offending fixture and corrective action.

#### Scenario: Doctor fails on an unreachable corpus pin

- **WHEN** `pipeline doctor` runs and a committed fixture pins a missing `base_commit`
- **THEN** the static fixture integrity check SHALL fail
- **AND** doctor SHALL exit non-zero with remediation naming the fixture and SHA

#### Scenario: Default doctor fixture check makes no model call

- **WHEN** `pipeline doctor` runs without harness-smoke or other model-consuming flags
- **THEN** the fixture integrity check SHALL NOT invoke a language model

---

### Requirement: Deep fixture preflight SHALL run under the same cell cwd, bootstrap, sandbox, and generator policy as a real cell

Deep fixture preflight SHALL run under the same cell cwd, bootstrap, sandbox, and generator policy
as a real cell: before the first treatment of an experiment executes against a referenced fixture,
the runner SHALL allocate a temporary worktree at the fixture's `base_commit` using the same layout
conventions as evaluation cells, apply the same dependency/bootstrap surface assumed by the
fixture's public checks, and use the same sandbox and generator policy a real cell would use for
those checks. Deep preflight SHALL NOT invoke a treatment model. Deep preflight failures SHALL
abort the experiment (or classify the fixture invalid) before provider spend on treatments.

#### Scenario: Deep preflight uses cell-like worktree at the pin

- **WHEN** deep preflight runs for a fixture
- **THEN** it SHALL check out the fixture's `base_commit` into a temporary worktree under the
  evaluation worktree layout
- **AND** SHALL NOT leave that worktree as a durable production branch

#### Scenario: Deep preflight failure blocks treatment execution

- **WHEN** deep preflight fails for a fixture referenced by an experiment
- **THEN** no treatment cell for that fixture SHALL be invoked
- **AND** the failure SHALL be recorded as infrastructure, not as a graded model outcome

---

### Requirement: Deep preflight SHALL prove public baseline health and that seeded or hidden biting probes fail at the pin

For a fixture that declares public checks, deep preflight SHALL run those checks (or a declared
baseline subset) at the pinned `base_commit` with no treatment applied and SHALL require that the
public baseline is healthy (checks pass). For a fixture that declares hidden checks intended as
biting ground truth, deep preflight SHALL prove each hidden check fails at the pin without a
treatment. For a fixture that declares seeded defects, deep preflight SHALL execute each defect's
declared `biting_probe` at the pin (not merely verify that the defect path exists) and SHALL
require that the probe fails. Path existence alone SHALL NOT satisfy the seeded-defect biting
guarantee. A fixture whose public baseline is red, or whose declared biting probe already passes
(non-biting / already fixed), SHALL be marked invalid by preflight naming the fixture and the
check or defect id. An unrelated hidden check SHALL NOT substitute for a seeded defect's own
`biting_probe`.

#### Scenario: Healthy public baseline at the pin passes

- **WHEN** deep preflight runs a fixture's public checks at `base_commit` with no treatment
- **AND** those checks pass
- **THEN** the baseline health portion of preflight SHALL pass

#### Scenario: Red public baseline fails preflight

- **WHEN** deep preflight runs a fixture's public checks at `base_commit` with no treatment
- **AND** a public check fails
- **THEN** preflight SHALL fail naming the fixture and the failing check
- **AND** the fixture SHALL be treated as invalid for experiment execution

#### Scenario: Non-biting seeded or hidden probe fails preflight

- **WHEN** a fixture declares a seeded defect or hidden check as biting ground truth
- **AND** deep preflight observes that probe already passing at the pin
- **THEN** preflight SHALL fail naming the fixture and the defect or check id
- **AND** SHALL NOT allow graded experiment execution against that fixture until it is replaced
  or repaired

#### Scenario: Seeded defect path exists but non-biting probe fails preflight

- **WHEN** a fixture declares a seeded defect whose path exists at the pin
- **AND** that defect's `biting_probe` exits zero at the pin (already fixed / non-biting)
- **THEN** preflight SHALL fail naming the fixture and the defect id
- **AND** SHALL NOT treat path existence alone as proof the defect bites

---

### Requirement: Deep preflight SHALL validate command path resolution and generator-owned allowed outputs

Deep preflight SHALL reject a fixture whose public or hidden check commands resolve to missing
paths under the cell worktree at the pin (including wrong test roots such as repository-root
`test/` when tests live under `core/test/`). When a fixture's public checks require regenerating
the generator-owned `plugin/` mirror, deep preflight SHALL require that `allowed_change_paths`
(when declared) includes the generator-owned paths needed for those outputs, or that an explicit
corpus policy documents why they are omitted. Omission without policy SHALL fail preflight naming
the fixture and the missing path class.

#### Scenario: Unresolvable check path fails preflight

- **WHEN** a fixture public or hidden check references a path that does not exist at the pin in
  the cell worktree
- **THEN** preflight SHALL fail naming the fixture and the unresolved path

#### Scenario: Missing plugin mirror allowance fails when regen is required

- **WHEN** a fixture declares `allowed_change_paths` and its public checks require regenerating
  generator-owned `plugin/` outputs for in-scope `core/` edits
- **AND** the boundary omits those generator-owned paths without an explicit documented exception
- **THEN** preflight SHALL fail naming the fixture and the missing generator-owned path class

---

### Requirement: Fixture preflight failures SHALL be infrastructure-classified and excluded from quality statistics

Every static or deep fixture preflight failure SHALL be classified as infrastructure (doctor gate
failure, experiment abort, or cell/result class equivalent to infrastructure error with a
preflight-named reason). Preflight attempts and failures SHALL NOT be pooled into graded quality
statistics, comparative model scores, or grader correctness aggregates. Absence of a preflight
record SHALL NOT be treated as a model quality signal.

#### Scenario: Preflight failure is not a graded quality sample

- **WHEN** fixture preflight fails for a fixture referenced by an experiment
- **THEN** reporting SHALL NOT include that failure as a graded completed-cell quality sample
- **AND** comparative treatment scores SHALL NOT treat the preflight failure as model performance

#### Scenario: Preflight reason is distinguishable from model failure

- **WHEN** a preflight failure is recorded
- **THEN** its reason or class SHALL be explicitly identifiable as fixture preflight infrastructure
- **AND** SHALL be distinguishable from a treatment `completed` outcome with a low grade
