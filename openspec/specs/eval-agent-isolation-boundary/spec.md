# eval-agent-isolation-boundary Specification

## Purpose
TBD - created by archiving change eval-agent-isolation-boundary. Update Purpose after archive.
## Requirements
### Requirement: The evaluator SHALL install an eval-scoped root instruction contract before invoking a local harness in a cell

Before the first local-CLI harness invocation of a cell, the evaluator SHALL install an
eval-scoped root instruction contract into that cell's worktree, at every root-instruction path the
target harness reads as project instructions. The installed contract SHALL take precedence over the
repository's own workflow instructions for the duration of that cell. Installation SHALL occur after
the worktree is checked out at the fixture's `base_commit` and before any prompt is sent to the
harness.

An evaluator that cannot install the contract SHALL NOT invoke the harness for that cell; it SHALL
record the failure and classify the cell as an infrastructure error rather than executing an
uncontracted treatment.

#### Scenario: Contract is installed before the harness runs

- **WHEN** a cell with a local-CLI harness treatment is executed
- **THEN** the eval root instruction contract SHALL be present at the harness's root-instruction
  path(s) in the cell worktree before the first harness invocation
- **AND** its content SHALL replace, for that cell, any repository workflow instruction previously
  at that path

#### Scenario: Contract installation failure prevents an uncontracted invocation

- **WHEN** installing the contract into a cell worktree fails
- **THEN** no harness invocation SHALL be made for that cell
- **AND** the cell SHALL be recorded as an infrastructure error naming the installation failure

---

### Requirement: The evaluator SHALL restore the cell worktree's instruction state before grading input is collected and before teardown

The evaluator SHALL restore every root-instruction path it modified to its `base_commit` content
(removing the file when no such content existed) before the cell's checks are run, before its
changed paths are collected, and before the worktree is torn down. Restoration SHALL occur on every
exit path, including harness failure, timeout, and an unexpected error.

Files the evaluator itself writes into the cell worktree to implement the boundary — the contract
files and the boundary denial log — SHALL NOT appear in the cell's changed-path evidence and SHALL
NOT be attributed to the treatment.

A restoration failure SHALL be recorded as boundary evidence and SHALL NOT abort the cell or replace
its primary outcome.

#### Scenario: Contract does not appear as a treatment-produced change

- **WHEN** a cell completes for a fixture that declares `allowed_change_paths`
- **THEN** the cell's changed-path evidence SHALL NOT contain the contract paths or the denial log
- **AND** no out-of-scope-change finding SHALL be attributed to them

#### Scenario: Restoration happens on a failing cell

- **WHEN** a cell's harness invocation fails or times out after the contract was installed
- **THEN** the modified root-instruction paths SHALL still be restored to their `base_commit` state

#### Scenario: Restoration failure is recorded, not fatal

- **WHEN** restoring a modified root-instruction path fails
- **THEN** the failure SHALL be recorded as boundary evidence on the cell
- **AND** the cell's `result_class` SHALL be the one its execution produced, unchanged by the
  restoration failure

---

### Requirement: The eval instruction contract SHALL state the cell's task scope, prohibitions, and absence of external authority

The contract text SHALL be single-sourced in the engine and SHALL state all of the following:

1. The agent SHALL work directly on the frozen evaluation task supplied in the prompt, and on
   nothing else.
2. The agent SHALL NOT delegate the work to a planning workflow, create or enter any nested
   worktree, create a branch for the work, commit, push, perform any GitHub operation, or advance
   any pipeline stage.
3. Repository workflow documents, contributor guides, and installed pipeline skills carry **no
   authority** inside an evaluation cell, and SHALL NOT be followed in preference to this contract.
4. The cell is an evaluation with no external side effects: no real issue, pull request, or branch
   is affected by the work, and no result is published by the agent.

A test SHALL fail if any of these clauses is removed from or drifts out of the contract text.

#### Scenario: Contract asserts direct work on the frozen task

- **WHEN** the contract text is inspected
- **THEN** it SHALL instruct the agent to work directly on the supplied evaluation task only

#### Scenario: Contract enumerates the prohibited actions

- **WHEN** the contract text is inspected
- **THEN** it SHALL prohibit planning delegation, nested worktrees, branch creation, commits,
  pushes, GitHub operations, and pipeline stage advancement

#### Scenario: Contract denies external authority to repository workflow instructions

- **WHEN** the contract text is inspected
- **THEN** it SHALL state that repository workflow documents and installed skills have no authority
  within the evaluation cell

#### Scenario: Contract drift is caught by a test

- **WHEN** a required clause is removed from the contract text
- **THEN** the contract test SHALL fail naming the missing clause

---

### Requirement: The evaluator SHALL deny the high-risk command set at the process boundary rather than by prompt text alone

For every local-CLI harness cell, the evaluator SHALL interpose a cell-scoped command boundary on
the harness child process that denies, at minimum: nested worktree creation, pipeline stage
advancement, commit, push or remote mutation, and mutating GitHub operations. Denial SHALL be
enforced by the process environment the child is given, not solely by instruction text.

A denied invocation SHALL fail with a non-zero exit status and a named denial reason, and the
underlying action SHALL NOT be performed. Commands outside the denied set — including read-only and
working-tree operations the treatment needs to inspect and edit the repository — SHALL continue to
work unchanged.

The boundary SHALL be cell-scoped: it SHALL NOT alter the environment of any other cell, of the
evaluator process, or of ordinary (non-evaluation) pipeline runs.

#### Scenario: A nested worktree attempt is denied

- **WHEN** a treatment attempts to create a nested worktree inside its cell worktree
- **THEN** the attempt SHALL exit non-zero with a named denial reason
- **AND** no nested worktree SHALL be created

#### Scenario: A pipeline advancement attempt is denied

- **WHEN** a treatment invokes a pipeline command that would advance stage state
- **THEN** the attempt SHALL exit non-zero with a named denial reason
- **AND** no pipeline stage state SHALL change

#### Scenario: Commit, push, and GitHub write attempts are denied

- **WHEN** a treatment attempts a commit, a push or remote mutation, or a mutating GitHub operation
- **THEN** each attempt SHALL exit non-zero with a named denial reason
- **AND** the corresponding action SHALL NOT be performed

#### Scenario: Permitted commands still work

- **WHEN** a treatment inspects repository state or edits files in its cell worktree
- **THEN** those operations SHALL succeed as they did before the boundary existed

#### Scenario: The boundary is cell-scoped

- **WHEN** a cell's boundary is in place
- **THEN** it SHALL affect only that cell's harness child process
- **AND** ordinary pipeline runs outside evaluation SHALL be unaffected

---

### Requirement: Every denied attempt SHALL be recorded in durable cell evidence and classified distinctly from model correctness

The evaluator SHALL record every attempt denied by the command boundary, and every mutating
operation refused by the evaluation-mode GitHub surface, in the cell's durable evidence with at
least the attempted command or operation and its denial category. This evidence SHALL be persisted
with the cell record, not merely logged to the console or returned in memory.

A boundary denial SHALL be classified as an isolation-boundary event, distinct from the cell's
`result_class` and from any correctness score. A denial alone SHALL NOT change `result_class`, and
no grader SHALL read boundary-denial evidence as a grading input.

When boundary evidence cannot be collected, the reason SHALL be recorded on the cell record;
absence of the evidence field SHALL mean "no denial occurred", never "collection was not attempted".

#### Scenario: A denied attempt appears in the persisted cell record

- **WHEN** a treatment's attempt is denied by the boundary
- **THEN** the cell's persisted record SHALL contain a structured entry naming the attempted command
  and its denial category

#### Scenario: GitHub-surface refusals reach the same durable evidence

- **WHEN** a stage invoked in evaluation mode has a mutating GitHub operation refused by the
  evaluation-mode GitHub surface
- **THEN** that refusal SHALL appear in the same persisted cell evidence as command-boundary denials

#### Scenario: A denial does not alter the result class

- **WHEN** a cell records one or more boundary denials but otherwise runs to completion
- **THEN** its `result_class` SHALL be the one its execution produced
- **AND** the denials SHALL be reported on their own axis

#### Scenario: Graders ignore boundary evidence

- **WHEN** a cell carrying boundary denials is graded
- **THEN** no grader SHALL read the boundary-denial evidence as an input to its score

#### Scenario: Failed evidence collection is distinguishable from no denials

- **WHEN** boundary evidence cannot be collected for a cell
- **THEN** the cell record SHALL carry the collection-failure reason
- **AND** that SHALL be distinguishable from a cell that recorded no denials

---

### Requirement: The externally sandboxed harness mode SHALL be a declared, recorded evaluator capability rather than an ambient environment variable

The experiment manifest SHALL declare the execution sandbox mode under which its cells run, with a
default preserving the harness's own managed sandbox. The evaluator SHALL resolve the declared mode
and pass it explicitly into harness invocation shaping; it SHALL NOT determine a cell's sandbox mode
by reading an ambient shell environment variable.

An unrecognized declared mode SHALL be rejected during manifest validation, naming the offending
field, before any treatment executes.

The resolved sandbox mode SHALL be recorded on every cell record and SHALL be part of the cell's
configuration identity, so that two cells differing only by sandbox mode are distinguishable and are
never pooled as identically configured.

#### Scenario: Declared mode selects the invocation shape

- **WHEN** a manifest declares the externally sandboxed mode and a Codex cell is executed
- **THEN** the harness invocation SHALL use the explicit bypass mode for that cell
- **AND** the remainder of the invocation SHALL be unchanged from the managed-sandbox shape

#### Scenario: Ambient environment does not decide an eval cell's sandbox mode

- **WHEN** the ambient no-sandbox environment variable is set but the manifest declares the
  managed-sandbox mode
- **THEN** the cell SHALL be executed in the managed-sandbox shape declared by the manifest

#### Scenario: Unknown declared mode is rejected before execution

- **WHEN** a manifest declares a sandbox mode that is not a supported value
- **THEN** manifest validation SHALL fail naming the offending field
- **AND** no treatment SHALL be executed

#### Scenario: Sandbox mode is recorded and enters configuration identity

- **WHEN** two cells are identical apart from their declared sandbox mode
- **THEN** each cell record SHALL carry its resolved sandbox mode
- **AND** the two cells SHALL have different configuration hashes

---

### Requirement: Boundary behavior SHALL be proven by injection-based regression tests with no live model, git, or network calls

The engine SHALL carry regression tests, using the existing dependency-injection seams, that cover
at minimum: harness invocation shaping under each declared sandbox mode, and a treatment that
attempts a prohibited nested-worktree or pipeline-advancement action. The prohibited-action test
SHALL assert that the attempt is denied, that the denial reaches the persisted cell evidence, and
that it does not change the cell's `result_class`.

These tests SHALL make no live model call and SHALL perform no real git, GitHub, or network
operation.

#### Scenario: Invocation shaping is pinned per sandbox mode

- **WHEN** the harness invocation is constructed for each declared sandbox mode
- **THEN** a test SHALL assert the resulting argument list for each mode
- **AND** SHALL assert that the modes differ only in the sandbox-selecting argument

#### Scenario: A prohibited-action treatment is denied and recorded

- **WHEN** an injected fake treatment attempts a nested worktree or a pipeline advancement
- **THEN** the test SHALL assert the attempt was denied
- **AND** SHALL assert the denial appears in the persisted cell evidence
- **AND** SHALL assert the cell's `result_class` is unchanged by the denial

#### Scenario: Tests use no live external calls

- **WHEN** the boundary regression tests run
- **THEN** they SHALL invoke no live model, no real git operation, and no network call

