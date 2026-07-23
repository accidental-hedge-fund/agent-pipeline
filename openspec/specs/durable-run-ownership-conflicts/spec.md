# durable-run-ownership-conflicts Specification

## Purpose
TBD - created by archiving change durable-run-ownership-conflicts. Update Purpose after archive.
## Requirements
### Requirement: Ownership and conflict declarations SHALL be validated against a machine-readable schema

The engine SHALL define a machine-readable schema for a per-item **ownership + conflict declaration**
and SHALL validate every declaration against it. A declaration SHALL support: **exclusive-ownership
source surfaces** expressed as path / module globs; **shared-by-default surfaces** in each of the
classes schema/state store, generated artifact, shared configuration, public API, CI/workflow file,
and package/version (release) file; **explicit conflict edges** (`conflicts_with`) naming other item
ids; and **reviewed exceptions**, each of which SHALL carry a justification and a review reference.
Validation SHALL reject a declaration with an unknown surface kind, a malformed glob, or an exception
missing its required justification or review reference. An absent or empty declaration SHALL be
admitted as a valid input and SHALL denote **unknown ownership** (governed by the unknown-ownership
requirement), never a validation error. Validation SHALL be pure and, in unit tests, SHALL run with no
real network, git, or subprocess calls.

#### Scenario: A well-formed declaration is accepted

- **WHEN** a declaration lists exclusive source globs, one or more shared-surface classes, explicit
  `conflicts_with` edges, and reviewed exceptions each carrying a justification and review reference
- **THEN** validation SHALL accept it

#### Scenario: A malformed declaration is rejected

- **WHEN** a declaration names an unknown surface kind or a malformed glob
- **THEN** validation SHALL reject it as a schema error naming the offending element

#### Scenario: An exception missing its review provenance is rejected

- **WHEN** a declaration includes an exception that omits its justification or review reference
- **THEN** validation SHALL reject the declaration

#### Scenario: An absent declaration is valid and denotes unknown ownership

- **WHEN** an item carries no ownership declaration
- **THEN** validation SHALL NOT fail
- **AND** the item SHALL be treated as unknown ownership by evaluation

### Requirement: Declared surfaces SHALL be normalized into a deterministic typed surface set

The engine SHALL normalize a validated declaration into a deterministic **typed surface set** in which
every entry carries its surface `kind`, its `pattern`, and its **conflict class** — `exclusive` for
source-glob surfaces and `shared` for every shared-by-default class. Normalization SHALL canonicalize
patterns, de-duplicate entries, and order the set by a documented total order so that re-normalizing
the same declaration yields an identical set. Normalization SHALL be pure and SHALL introduce no I/O.
The normalized set SHALL be the unit of comparison used by pairwise evaluation and the artifact
recorded as planning evidence.

#### Scenario: Normalization is deterministic

- **WHEN** the same declaration is normalized more than once
- **THEN** each normalization SHALL produce an identical typed surface set

#### Scenario: Every normalized entry carries its conflict class

- **WHEN** a declaration mixes source globs and shared-surface classes
- **THEN** each normalized entry SHALL be tagged `exclusive` or `shared` according to its kind
- **AND** duplicate declared surfaces SHALL collapse to a single entry

### Requirement: Missing or ambiguous ownership SHALL be treated as a conflict

The engine SHALL treat **unknown ownership** as unsafe for parallel execution and SHALL resolve any
pair involving unknown ownership to `conflict`. Unknown ownership SHALL arise when an item carries no
ownership declaration, or when a surface relevant to the comparison is not covered by any declared
surface. A pair SHALL NOT be resolved `disjoint` on the strength of missing or ambiguous ownership
information — the conservative default is to conflict.

#### Scenario: An item with no declaration conflicts with every other item

- **WHEN** one item of a pair carries no ownership declaration
- **THEN** the pair SHALL evaluate `conflict` with an unknown-ownership reason
- **AND** the pair SHALL NOT evaluate `disjoint`

#### Scenario: A surface outside all declared surfaces is unknown

- **WHEN** a relevant surface is not covered by any declared surface of an item
- **THEN** that surface SHALL be treated as unknown ownership
- **AND** the pair SHALL evaluate `conflict`

### Requirement: Shared surfaces SHALL conflict by default unless a reviewed exception exists

The engine SHALL resolve a pair to `conflict` when both items own the **same shared-by-default
surface** — a schema/state store, generated artifact, shared configuration, public API, CI/workflow
file, or package/version file — because a shared surface has no disjoint sub-region. This default
SHALL be suppressed for a specific pair only by a **reviewed exception** that names that surface; when
such an exception is present and valid, the pair SHALL NOT conflict **on the basis of that surface**.
Exclusive-ownership source surfaces SHALL conflict only when their globs overlap; disjoint source
globs SHALL NOT produce a conflict.

#### Scenario: Two items owning the same generated artifact conflict

- **WHEN** two items each declare ownership of the same generated artifact
- **THEN** the pair SHALL evaluate `conflict` naming that shared surface

#### Scenario: A reviewed exception suppresses a shared-surface conflict

- **WHEN** two items own the same shared surface and a valid reviewed exception names that surface for
  the pair
- **THEN** the pair SHALL NOT conflict on the basis of that surface

#### Scenario: Disjoint source globs do not conflict

- **WHEN** two items declare exclusive source globs that do not overlap
- **THEN** the pair SHALL NOT conflict on the basis of those source surfaces

#### Scenario: Overlapping source globs conflict

- **WHEN** two items declare exclusive source globs that overlap
- **THEN** the pair SHALL evaluate `conflict` naming the overlapping surface

### Requirement: Explicit conflict declarations SHALL always produce a conflict edge

The engine SHALL resolve a pair to `conflict` whenever either item declares an explicit
`conflicts_with` edge naming the other, regardless of whether the pair's normalized surfaces are
otherwise disjoint. A reviewed exception SHALL NOT suppress an explicit conflict edge — exceptions
suppress only auto-derived shared-surface conflicts. The conflict reason recorded for such a pair SHALL
identify it as an explicit declaration.

#### Scenario: An explicit edge conflicts despite disjoint surfaces

- **WHEN** one item declares an explicit `conflicts_with` edge naming the other and their surfaces are
  otherwise disjoint
- **THEN** the pair SHALL evaluate `conflict` with an explicit-edge reason

#### Scenario: An exception does not suppress an explicit edge

- **WHEN** an explicit `conflicts_with` edge and a reviewed exception both name the same pair
- **THEN** the pair SHALL still evaluate `conflict`

### Requirement: Pairwise evaluation SHALL be deterministic and yield a typed verdict with a structured reason

The engine SHALL provide a **pure, deterministic** pairwise evaluator that, given two items' validated
declarations, returns exactly one verdict — `disjoint` or `conflict` — together with a **structured
reason**. A `conflict` reason SHALL identify its cause as one of: an overlapping surface (a glob
overlap on exclusive surfaces or a co-owned shared surface, naming the surface), an explicit
`conflicts_with` edge, or unknown ownership. The same pair of declarations SHALL always yield the same
verdict and reason. Evaluation SHALL perform no external mutation and, in unit tests, SHALL run
entirely through pure inputs with no real network, git, or subprocess calls.

#### Scenario: Evaluation is deterministic

- **WHEN** the same pair of declarations is evaluated more than once
- **THEN** each evaluation SHALL return an identical verdict and reason

#### Scenario: A conflict verdict names its cause

- **WHEN** a pair evaluates `conflict`
- **THEN** the reason SHALL identify exactly one cause — overlapping surface, explicit edge, or
  unknown ownership — and, for an overlapping surface, SHALL name that surface

#### Scenario: Evaluation performs no real I/O

- **WHEN** a pair is evaluated in a unit test
- **THEN** the evaluation SHALL record zero real network, git, and subprocess calls

### Requirement: Planning evidence SHALL record the normalized surface set and conflict reason

The engine SHALL record, as **durable planning evidence**, the normalized per-item surface set and,
for each evaluated pair, the resulting verdict together with its structured conflict reason. This
evidence SHALL be the audit trail explaining why a pair was proven `disjoint` or resolved `conflict`.
The evidence SHALL be a record only — producing it SHALL NOT schedule, start, or serialize any item
(scheduling is the consuming planner's responsibility).

#### Scenario: A conflicted pair records its normalized set and reason

- **WHEN** a pair evaluates `conflict`
- **THEN** the planning evidence SHALL contain the normalized surface set for each item and the
  pair's verdict and structured conflict reason

#### Scenario: A disjoint pair records its evidence

- **WHEN** a pair evaluates `disjoint`
- **THEN** the planning evidence SHALL record the verdict and the normalized surface sets that
  justified it

### Requirement: Declarations SHALL be planning inputs only and SHALL NOT grant merge or bypass review

The engine SHALL treat ownership declarations, reviewed exceptions, and conflict verdicts as **inputs
to planning only**. Nothing in this capability SHALL authorize a merge, relax or waive a review gate,
or bypass the serialized merge barrier. A reviewed exception SHALL suppress only a *planning*
conflict edge between two items; it SHALL NOT suppress, downgrade, or dispose of any review finding,
and it SHALL NOT alter the pipeline's stop at `pipeline:ready-to-deploy`.

#### Scenario: An exception marks a pair parallelizable without touching review or merge

- **WHEN** a reviewed exception causes a pair to evaluate `disjoint`
- **THEN** each item SHALL still pass its own review and pre-merge gates unchanged
- **AND** the serialized merge barrier SHALL NOT be bypassed

#### Scenario: Declarations grant no merge authority

- **WHEN** any ownership declaration or exception is present
- **THEN** it SHALL NOT authorize a merge or advance an item past `pipeline:ready-to-deploy`

