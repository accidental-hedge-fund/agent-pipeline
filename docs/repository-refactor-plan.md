# Repository refactor plan

**Status:** proposed  
**Scope:** behavior-preserving simplification of agent-pipeline  
**Reference point:** `6f4d7244`

## Objective

Reduce maintenance cost, defect risk, and reader load without weakening the
deterministic safeguards that distinguish agent-pipeline.

The target is not merely smaller files. The target is a smaller product model:
fewer commands, state models, configuration concepts, and independently
maintained descriptions of the same behavior.

At the reference point, the repository's structural metric reports 396,760
nonblank, non-comment-only lines: 174,690 production and 222,070 test. The
test-to-production ratio is 1.27:1. Size alone is not a defect, but the current
footprint makes duplicated ownership and low-value machinery expensive.

## Design references

[Grok Ship](https://github.com/kunchenguid/grok-ship),
[firstmate](https://github.com/kunchenguid/firstmate), and
[pstack](https://github.com/cursor/plugins/tree/main/pstack) are comparative
examples only. This plan does not propose adopting them, integrating with Grok
Bot, or reducing agent-pipeline's host support.

The useful lessons are architectural:

- Keep intake and supervision distinct from project delivery.
- Give each durable state model one explicit owner.
- Put judgment-heavy procedure in agent instructions and reserve code for
  invariants that require mechanical enforcement.
- Scale ceremony to the risk and size of the work.
- Separate ordinary delivery from specialized release and factory
  qualification.
- Prefer a few outcome-oriented operations over a large vocabulary of
  lifecycle commands.

These examples do not prove that agent-pipeline's safeguards should be removed.
They demonstrate that sophisticated safeguards can sit behind a much smaller
conceptual interface.

## Target architecture

```text
host or external supervisor
    |
    v
issue delivery engine
    |
    v
deterministic policy and repository primitives

separate boundary:
release and self-host qualification
```

### Host or external supervisor

Owns user intent, invocation, wake facilities, and human-facing progress. Host
adapters remain thin argv wrappers around the CLI.

### Issue delivery engine

Owns one issue-to-ready outcome. It coordinates stages but does not own CLI
parsing, process termination, rendering, or release qualification.

### Policy and repository primitives

Own GitHub observation and mutation, exact-head checks, evidence validation,
state transitions, repository commands, and guarded merge operations. These
are the deterministic capabilities worth preserving.

### Release and self-host qualification

Own trains, release preparation and completion, factory reliability gates,
candidate lineage, production engine pins, promotion, rollback, and deployed
digest proof. Ordinary issue delivery should not depend on this boundary.

## Safeguards to preserve

- Exact-head-bound test and review evidence.
- Machine parsing and validation of agent results.
- Idempotent issue and pull-request state reconciliation.
- Worktree custody and trusted integration-base behavior.
- Deterministic merge gates and merge-result containment.
- Authenticated authority requests and governed overrides.
- Dependency-ordered issue integration.
- The evaluation framework for reproducible harness, model, effort, quality,
  reliability, cost, and isolation comparisons.
- Release, package, promotion, rollback, and deployment provenance where the
  release surface is used.
- Machine-readable status for hosts and external supervisors.
- Equivalent policy semantics across supported hosts.
- The rule that ordinary advance, single, and loop operations never merge.

Do not collapse advance, durable-loop, merge, train, and ship into one generic
state machine. Their authority and recovery invariants differ. Do not merge
domain stores or supervisors merely because they share filesystem mechanics.

## Workstreams

### 1. Map concepts to outcomes and risks

Inventory every command, stage, gate, store, configuration block, and generated
artifact. For each, record:

- The user-visible outcome it enables.
- The risk or invariant it controls.
- Its consumers.
- Whether it is default-on.
- The evidence that the controlled failure occurs.
- Whether another mechanism already controls the same risk.
- Whether it requires deterministic code or can be an agent instruction.
- Its removal criterion.

Classify commands by audience:

- Operator commands.
- Supervisor integration commands.
- Internal or diagnostic commands.
- Release and self-host commands.
- Compatibility commands.

Internal mechanics should not automatically be first-class public commands.

### 2. Consolidate low-level persistence

Introduce one small atomic-file publication primitive covering unique
same-directory temporary files, exclusive creation, optional permissions and
durability sync, atomic rename, and cleanup.

The primitive returns success or failure. Domain stores retain serialization,
validation, retry, recovery, and fatal-versus-best-effort policy. Migrate stores
incrementally and test concurrent writes, failure cleanup, permissions, and
rename failures.

### 3. Establish supported test fixtures

Add a shared in-memory loop-store fixture with controllable clock, PID,
hostname, identifiers, and observable writes. Add a typed resolved
configuration builder based on real defaults plus overrides.

Keep scenario data and assertions local. The fixtures should remove duplicated
infrastructure and unsafe `PipelineConfig` assertions without centralizing test
behavior.

### 4. Separate delivery from release qualification

Create a strong internal boundary around factory release preparation,
reliability gates, production pins, promotion, rollback, and deployed-engine
proof.

Determine whether the boundary remains an internal namespace or becomes an
optional package only after mapping its real consumers. Do not make ordinary
issue delivery import self-host release machinery.

The evaluation framework is a retained product capability. Refactoring may
consolidate its schemas, stores, adapters, fixtures, and reporting boundaries,
but must not remove the ability to run reproducible harness/model/effort
comparisons with quality, reliability, cost, provenance, and isolation
evidence.

Scoreboards, planning telemetry, recurrence tracking, and other measurement
surfaces must still identify the decisions or policies they influence.
Measurement outside the retained evaluation contract that has no consumer or
removal criterion remains a deletion candidate.

### 5. Establish one issue-delivery service

Define a service that accepts typed delivery input and dependencies and returns
a typed outcome. It should not import Commander or assign global process state.

CLI commands, durable supervision, and tests should call this service rather
than reconstructing delivery behavior. Stage implementations remain private
unless there are at least two real consumers of a smaller stable contract.

### 6. Thin the CLI entry point

Keep argument parsing, rendering, and final exit-code assignment at the edge.
Move command families to executors with explicit inputs, dependencies, and
results.

Do not create one module per existing command before the command taxonomy is
settled. Commands with the same outcome should converge on the same internal
operation rather than preserving accidental distinctions as abstractions.

### 7. Consolidate command metadata

After deciding which command distinctions are real, define stable command facts
once: keyword, forms and modes, authority, allowed options, output contract, and
documentation exposure.

Derive the runtime registry, form inventory, operation surface, documentation,
and exhaustive tests from that source. Keep semantic validation and handlers
outside the catalog.

### 8. Simplify packaging and checks

- Generate builtin outer-host manifests from the host-owned manifests.
- Share only the dependency-free bootstrap kernel common to the root launcher
  and generated host launcher.
- Keep host-specific path discovery and installation policy separate.
- Move test-only static guard programs under test support or a clearly named
  checks boundary.
- Verify external deep-import use before deleting orphaned barrel modules or
  unused exports.

Decompose the installer only after the retained command and host surfaces are
clear. A narrower surface may eliminate installer behavior instead of requiring
new installer abstractions.

### 9. Apply adaptive ceremony

Review every optional and mandatory gate against the task risks it controls.
Preserve structural safety checks, but avoid running judgment-heavy or expensive
ceremony where a cheaper deterministic check proves the same outcome.

For each stage or gate, document:

- Activation rule.
- Required evidence.
- Distinct failure class.
- Overlap with other gates.
- Maintenance footprint.
- Observed value.
- Retirement condition.

## Sequence

### Phase 1: inventory and quick wins

1. Produce the command, stage, store, and gate ownership map.
2. Remove the unused `addLabel` import and suppression reference.
3. Generate builtin host manifests.
4. Add supported test fixtures and migrate one test family at a time.
5. Relocate test-only static guards.

### Phase 2: filesystem and state foundations

1. Implement and test atomic-file publication.
2. Migrate low-risk stores first.
3. Migrate durability- and authority-sensitive stores separately.
4. Identify state models that can be deleted rather than migrated.

### Phase 3: architectural boundaries

1. Isolate release and self-host qualification.
2. Establish the issue-delivery service.
3. Remove directionally wrong imports between delivery, supervision, and
   release code.
4. Preserve existing entry points while callers migrate.

### Phase 4: public-surface reduction

1. Reclassify commands by audience.
2. Remove or hide internal-only command forms.
3. Consolidate the surviving command metadata.
4. Extract command executors from `pipeline.ts` family by family.

### Phase 5: large-module partitions

1. Separate pure factory evaluation and rendering from persistence.
2. Separate candidate process supervision from release coordination.
3. Extract installer planning and validation before changing locks or
   publication.

### Phase 6: evidence-based deletion

1. Remove non-evaluation telemetry with no demonstrated consumer; consolidate
   retained evaluation telemetry behind its owned framework boundary.
2. Remove state models made obsolete by the new boundaries.
3. Remove compatibility paths after their callers migrate.
4. Verify external consumption before narrowing source-level exports.

## Independently reviewable changes

Do not bundle:

- Launcher bootstrap with installer decomposition.
- CLI decomposition with release-module partitioning.
- Atomic-file migration across all stores in one change.
- Public command removal with unrelated internal module moves.
- Behavioral gate changes with behavior-preserving structural work.

Each change should preserve command output, exit codes, state transitions,
evidence formats, and authority boundaries unless it explicitly proposes and
tests a product change.

## Acceptance criteria

The refactor succeeds when it reduces concepts, not merely file sizes.

Each milestone should delete or consolidate at least one material source of
ownership, such as:

- A complete redundant command family or form.
- An independently maintained description of the command surface.
- A duplicated persistence implementation.
- A duplicated test environment.
- A durable state model made unnecessary by a deeper boundary.
- Configuration and tests belonging only to removed behavior.

Repository-wide acceptance remains:

- User-visible behavior and authority boundaries are preserved.
- Generated artifacts are fresh.
- `npm run ci` passes.
- No new compatibility layer remains without an owner and removal condition.
- The number of concepts required to trace one issue from intake to
  ready-to-deploy is measurably lower.

## Initial implementation briefs

### Atomic-file publication

Add a dependency-injected primitive, test concurrency and failure behavior, and
migrate callers in small groups. Preserve each caller's serialization and error
policy. Roll back by reverting an individual caller migration.

### Issue-delivery service and CLI seam

Select one low-side-effect command family as the pilot. Move its delivery logic
behind typed input and output while retaining Commander parsing and rendering.
Prove byte-compatible output, exit codes, JSON events, and state transitions
before extending the seam.

### Command taxonomy and catalog

Classify the existing command forms before generating anything. Remove false
distinctions, then derive the registry, inventory, operation surface, and tests
from one catalog. Preserve dry-run/apply and merge-authority distinctions as
first-class modes.
