## ADDED Requirements

### Requirement: Eval isolation SHALL be specified as a cooperative-agent validity fence not multi-tenant security

Eval isolation SHALL be specified and documented as a **validity fence for cooperative agents**:
the instruction contract, process command boundary, and credential-stripping environment prevent a
well-intentioned treatment from following repository workflow instructions or ordinary PATH CLIs
into nested worktrees, pipeline advancement, commits, pushes, or mutating GitHub operations that
would invalidate the measurement. They SHALL NOT be specified as a multi-tenant security boundary
against a hostile agent, absolute-path binary escape, or kernel-level isolation. Documentation and
requirements that describe isolation SHALL state this threat model explicitly. OS-level UID or
namespace sandboxing remains out of scope of this capability (tracked separately for a later
major version).

#### Scenario: Specs and contract state the cooperative threat model

- **WHEN** the eval isolation requirements and the eval agent contract text are inspected
- **THEN** they SHALL describe isolation as a cooperative validity fence for evaluation correctness
- **AND** SHALL NOT claim multi-tenant or hostile-agent security guarantees beyond PATH, credential
  strip, and instruction-contract enforcement

#### Scenario: Absolute-path escape is acknowledged as out of scope

- **WHEN** operator-facing isolation documentation is inspected
- **THEN** it SHALL state that a treatment invoking tools by absolute path outside the deny shim
  is outside this fence's guarantee
- **AND** SHALL point OS-level sandboxing to the deferred multi-tenant isolation work

---

### Requirement: Local-CLI write denial SHALL be enforced by process boundary and credentials not EvalGhSurface injection into the harness child

Local-CLI write denial SHALL be enforced by the cell-scoped process command boundary (PATH deny
shim) and the credential-stripping environment applied to the harness child process, not by
injecting `EvalGhSurface` into that child. The evaluation-mode GitHub surface
(`EvalGhSurface` / `createEvalGhSurface`) SHALL refuse mutating operations when evaluator-owned
**in-process** code invokes it, and those refusals SHALL be recorded as boundary evidence, but the
surface SHALL NOT be specified as injected into the external harness child's runtime as the
mechanism that stops CLI shell-outs. Requirements and tests SHALL NOT claim that production write
protection for local-CLI children is provided solely by constructing `EvalGhSurface` without the
process boundary.

#### Scenario: Local-CLI mutating gh is denied at the process boundary

- **WHEN** a local-CLI treatment invokes the GitHub CLI for a mutating operation on PATH inside a
  cell
- **THEN** the process command boundary SHALL deny the attempt with a named reason
- **AND** the denial SHALL appear in durable boundary evidence
- **AND** enforcement SHALL NOT depend on the harness child receiving an injected TypeScript
  `EvalGhSurface` object

#### Scenario: In-process mutating helper uses EvalGhSurface when present

- **WHEN** evaluator-owned in-process code that accepts a `gh` dependency attempts a mutating
  GitHub operation during evaluation
- **THEN** that code SHALL be wired to the evaluation-mode GitHub surface
- **AND** the surface SHALL refuse the operation and record the refusal

#### Scenario: Tests do not claim harness-child protection via surface alone

- **WHEN** regression tests describe production-write protection for local-CLI cells
- **THEN** they SHALL assert process-boundary and/or credential-strip behavior for child processes
- **AND** SHALL NOT treat construction of `EvalGhSurface` alone as proof that a harness child cannot
  write

---

### Requirement: Unused EvalGhSurface plumbing on harness invoke paths SHALL be removed or actually used

The evaluator SHALL NOT thread an unused `EvalGhSurface` parameter through the local-CLI harness
invoke path solely to suggest protection when that path does not call mutating `gh` helpers
in-process. Implementation SHALL either (a) remove the unused parameter from the local-CLI invoke
path while keeping `createEvalGhSurface` available for in-process seams and unit tests, or (b) use
the surface on every real in-process mutating call site. Partial threading that neither calls the
surface nor documents it as unused is forbidden after this change.

#### Scenario: Local-CLI real invoke path has no ornamental gh parameter

- **WHEN** the production `realInvokeHarness` (or equivalent) path is inspected after this change
- **THEN** it SHALL either not accept an unused `EvalGhSurface` argument or SHALL pass that surface
  into an in-process mutator that actually invokes it
- **AND** unit tests SHALL match the chosen disposition
