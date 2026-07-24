## ADDED Requirements

### Requirement: `pipeline evals harvest` SHALL accept sanitized evidence and default to a draft

`pipeline evals harvest` SHALL accept one or more sanitized evidence references drawn from normal
run artifacts, `pipeline improve` clusters, or `correction_event` / control proposals (#499/#500),
and SHALL produce an eval fixture **draft** as its only default behavior. The command SHALL NOT
queue, advance, override, merge, or deploy anything, and SHALL perform no production GitHub write.
When no usable evidence is supplied, the command SHALL fail with a clear error and SHALL NOT emit a
degraded draft.

#### Scenario: Correction-proposal evidence produces a draft

- **WHEN** `pipeline evals harvest` is invoked with a `correction_event` or control proposal that
  names `eval` as the next control level
- **THEN** the command SHALL produce a fixture draft and SHALL NOT create, advance, or merge any
  GitHub artifact

#### Scenario: Ordinary run-failure evidence produces a draft

- **WHEN** `pipeline evals harvest` is invoked with a sanitized normal run artifact describing a
  recurring failure
- **THEN** the command SHALL produce a fixture draft from that evidence

#### Scenario: Missing evidence is rejected, not guessed

- **WHEN** `pipeline evals harvest` is invoked with no usable evidence reference
- **THEN** the command SHALL fail with a clear error naming the missing input
- **AND** it SHALL NOT emit a fixture draft

### Requirement: The harvest workflow SHALL inventory the candidate's capability surface

The harvest workflow SHALL resolve and emit a capability-surface inventory for the candidate
covering the stage, the materialized prompts, the harness/model configuration, the tools or hooks
in play, the repository paths involved, and the referenced services/data dependencies. The
inventory SHALL be a resolved snapshot of the surface the candidate exercises, not a free-text
guess.

#### Scenario: The inventory covers the required surface dimensions

- **WHEN** the harvest workflow produces its capability-surface inventory for a candidate
- **THEN** the inventory SHALL identify the stage, the materialized prompts, the harness/model
  configuration, the tools/hooks, the repository paths, and the referenced services/data
  dependencies relevant to that candidate

### Requirement: The harvest workflow SHALL propose exactly one bounded ability with a recorded control-level rationale

The harvest workflow SHALL propose **exactly one** bounded ability or failure mode to measure per
harvest, and SHALL record the source evidence, the affected runs/items, the recurrence count when
available, and a rationale for why an eval — rather than a lower or higher rung of the graduation
ladder — is the appropriate control level for that evidence.

#### Scenario: One ability is proposed with its evidence

- **WHEN** the harvest workflow proposes a measurement target
- **THEN** it SHALL name exactly one bounded ability or failure mode
- **AND** it SHALL record the source evidence, the affected runs/items, the recurrence count when
  available, and why an eval is the appropriate control level

#### Scenario: A single harvest does not batch multiple abilities

- **WHEN** the supplied evidence spans more than one distinct ability or failure mode
- **THEN** the harvest workflow SHALL propose a single bounded ability rather than a fixture
  measuring several capabilities at once

### Requirement: A harvested draft SHALL conform to the existing fixture and grader contracts

A harvested draft SHALL be expressed in the existing #432/#433 fixture and grader contracts: an
immutable `base_commit`, the task input, the stage-entry artifacts, public and hidden checks, the
acceptance criteria, the allowed-change boundary, grader references with versions, a `category`, a
`risk`, and a `provenance` of `harvested`. The rendered draft SHALL load under the existing fixture
loader.

#### Scenario: A rendered draft is loadable

- **WHEN** the harvest workflow renders a fixture draft
- **THEN** the draft SHALL declare `base_commit`, task input, stage-entry artifacts, public/hidden
  checks, acceptance criteria, allowed-change boundary, grader refs with versions, `category`,
  `risk`, and `provenance: harvested`
- **AND** the draft SHALL be accepted by the existing fixture loader

### Requirement: The harvest workflow SHALL support iterative maintainer revision before promotion

The harvest workflow SHALL let a maintainer iteratively revise the proposed ability, task,
dependency modes, checks, and grader before promotion, and SHALL re-render a consistent draft after
each revision.

#### Scenario: A revised dependency mode re-renders the draft

- **WHEN** a maintainer revises the proposed ability, task, a dependency mode, a check, or the
  grader of a draft
- **THEN** the harvest workflow SHALL re-render a draft consistent with the revision
- **AND** the revised draft SHALL remain loadable under the fixture loader

### Requirement: Repository writes SHALL require an explicit approval action and produce a reviewable diff

The harvest workflow SHALL treat draft-only as its sole default. A write into the repository's eval
corpus SHALL require an explicit approval/apply action and SHALL produce a normal diff for review.
Promotion SHALL validate the draft with the existing eval loader — rejecting an invalid draft by
naming the offending field — and SHALL be able to generate a plan-only experiment proving the draft
expands into an executable cell plan without a live model call and without any production GitHub
write.

#### Scenario: Promotion requires an explicit action

- **WHEN** `pipeline evals harvest` is run without an explicit approval/apply action
- **THEN** it SHALL NOT write any fixture into the eval corpus

#### Scenario: Explicit promotion writes a reviewable diff

- **WHEN** a maintainer promotes a validated draft with the explicit approval/apply action
- **THEN** the fixture SHALL be written as a normal, reviewable diff
- **AND** no production GitHub write SHALL occur

#### Scenario: An invalid draft is rejected at promotion

- **WHEN** promotion is attempted for a draft that fails the fixture loader
- **THEN** promotion SHALL fail naming the offending field
- **AND** no fixture SHALL be written into the corpus

#### Scenario: Promotion can prove executability plan-only

- **WHEN** a draft is promoted with the plan-only executability proof enabled
- **THEN** the draft SHALL expand into an executable cell plan
- **AND** no live model call and no production GitHub write SHALL occur

### Requirement: Harvested drafts SHALL never copy secrets or raw production payloads

The harvest workflow SHALL route every evidence excerpt through the existing artifact sanitization
and injection defenses before it enters a draft or a proposal body. Secrets and raw production
payloads SHALL NOT be copied verbatim into any draft or evidence excerpt; only redacted excerpts
SHALL appear.

#### Scenario: A secret-bearing trace yields only redacted excerpts

- **WHEN** the supplied evidence contains a secret or a raw production payload
- **THEN** the generated draft and every evidence excerpt SHALL contain only the redacted form
- **AND** no raw secret or raw production payload SHALL appear in the draft, proposal body, or any
  emitted excerpt
