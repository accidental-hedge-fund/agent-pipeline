## MODIFIED Requirements

### Requirement: Evaluation mode SHALL perform no production GitHub writes

While executing an experiment, the runner and every stage it invokes SHALL perform no mutating
GitHub operation against production state. In particular, evaluation mode SHALL NOT set or remove
a label, post or edit a comment, create, edit, or merge a pull request, or push to a production
branch, and SHALL NOT transition any real issue's authoritative pipeline state.

This restriction SHALL be enforced by **layered** controls, not by a single ornamental seam:

1. **In-process evaluation-mode GitHub surface** — when evaluator-owned code invokes mutating
   GitHub helpers through a `gh` dependency, that dependency SHALL be the evaluation-mode surface
   that refuses the operation and records the refusal, rather than relying on individual call
   sites to check a mode flag.
2. **Harness child process boundary** — because a local CLI harness can shell out directly rather
   than through the TypeScript surface, evaluation mode SHALL deny mutating GitHub operations,
   pushes, and remote mutations at the harness child process boundary (PATH deny shim) and SHALL
   strip write credentials from that child's environment.
3. **Cooperative instruction contract** — the eval agent contract SHALL prohibit GitHub mutation
   and pipeline advancement as a validity fence for cooperative agents (see
   `eval-agent-isolation-boundary`); it is not a multi-tenant security boundary.

Every refusal by the evaluation-mode GitHub surface and every denial at the process boundary
SHALL be recorded in the cell's durable evidence, not only returned in memory or written to the
console. Requirements and tests SHALL NOT claim that constructing the evaluation-mode surface
alone protects a local-CLI harness child that never receives that surface.

#### Scenario: No mutating GitHub call occurs during an experiment

- **WHEN** a full experiment matrix is executed in either stage mode or end-to-end mode
- **THEN** no label set or removal, no comment creation or edit, no pull-request creation, edit,
  or merge, and no push to a production branch SHALL be performed

#### Scenario: A stage attempting a production write fails loudly

- **WHEN** evaluator-owned in-process code invoked in evaluation mode attempts a mutating GitHub
  operation through the evaluation-mode GitHub surface
- **THEN** the evaluation-mode GitHub surface SHALL refuse the operation
- **AND** the cell SHALL record the refusal rather than silently completing as if the write had
  succeeded

#### Scenario: A harness shelling out directly is denied at the process boundary

- **WHEN** a treatment invokes the GitHub CLI or a push directly, bypassing the evaluation-mode
  GitHub surface
- **THEN** the attempt SHALL be denied at the harness child process boundary (and/or fail for lack
  of write credentials)
- **AND** no production GitHub or remote state SHALL change

#### Scenario: Refusals and denials are durably recorded on the cell

- **WHEN** a cell records a GitHub-surface refusal or a process-boundary denial
- **THEN** that record SHALL be present in the cell's persisted record in the experiment output

#### Scenario: No real issue changes authoritative state

- **WHEN** an experiment completes
- **THEN** no real issue's authoritative pipeline labels or stage state SHALL have been
  transitioned by evaluation mode

#### Scenario: Surface construction alone is not the local-CLI guarantee

- **WHEN** living requirements or tests describe local-CLI production-write protection
- **THEN** they SHALL attribute child-process denial to the process boundary and credential strip
- **AND** SHALL NOT claim the TypeScript evaluation-mode surface is injected into the harness child

---

## ADDED Requirements

### Requirement: Experiment execution SHALL run fixture integrity preflight before treatments

Before expanding and executing treatments for an experiment, the runner SHALL run fixture
integrity preflight (static reachability and contract consistency at minimum; deep cell-like
preflight for referenced fixtures per `eval-fixture-preflight`) for every fixture id the
manifest references. A preflight failure SHALL prevent treatment execution for the affected
fixture (or abort the experiment) and SHALL be classified as infrastructure, not as a graded
model outcome.

#### Scenario: Preflight runs before the first treatment

- **WHEN** an experiment is started with one or more fixture ids
- **THEN** fixture integrity preflight SHALL complete for those fixtures before any treatment
  harness or model invocation for those fixtures

#### Scenario: Preflight failure aborts graded execution for the fixture

- **WHEN** fixture integrity preflight fails for a referenced fixture
- **THEN** the runner SHALL NOT invoke treatments for that fixture
- **AND** the failure SHALL be recorded as infrastructure with a preflight-named reason

---

### Requirement: Infrastructure preflight and infra_error cells SHALL NOT enter quality score pools

Infrastructure preflight failures and non-completed cells SHALL NOT enter quality score pools:
cells and attempts classified as fixture preflight failures, `infra_error`, `auth_error`, or
`timeout` SHALL NOT be pooled into graded quality statistics or comparative model-performance
aggregates that are defined over successfully graded `completed` cells. Smoke-only fixture
outcomes SHALL likewise remain outside graded quality pools.

#### Scenario: Infra_error is excluded from quality aggregates

- **WHEN** comparative reporting aggregates model quality for an experiment
- **THEN** cells with `result_class` `infra_error`, `auth_error`, or `timeout` SHALL NOT contribute
  graded quality scores
- **AND** fixture preflight failures SHALL NOT contribute graded quality scores
