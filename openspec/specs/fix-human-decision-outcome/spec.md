# fix-human-decision-outcome Specification

## Purpose
TBD - created by archiving change fix-round-human-decision-outcome. Update Purpose after archive.
## Requirements
### Requirement: The fix prompt SHALL define one bounded machine-readable needs-human-decision outcome

The fix prompt SHALL define exactly one sanctioned outcome for a fix round whose correct result
is a human decision rather than a code change. The outcome SHALL be declared as one controlled
single line per affected finding, carrying a decision category drawn from the closed set
`product-decision`, `authority`, `external-dependency`, the finding's stable `override-key`, the
finding's verbatim `finding-fingerprint`, the reviewed SHA the harness assessed against, and a
one-line decision request. The prompt SHALL state that this outcome neither resolves nor
suppresses the finding and never advances the item, and SHALL distinguish it from the
does-not-reproduce outcome. A drift-guard test SHALL fail if the section is removed from the
prompt.

#### Scenario: Needs-human-decision instruction is present in the fix prompt

- **WHEN** the fix prompt is built for any fix round
- **THEN** it SHALL instruct the harness that a finding requiring a human product decision,
  an authority the harness lacks, or an unavailable external capability is declared via the
  controlled single-line declaration (category + finding key + fingerprint + reviewed SHA +
  one-line decision request)
- **AND** it SHALL state that the declaration does not resolve the finding and does not advance
  the item

#### Scenario: Only the three sanctioned categories are offered

- **WHEN** the fix prompt renders the needs-human-decision section
- **THEN** the only categories it offers SHALL be `product-decision`, `authority`, and
  `external-dependency`

#### Scenario: Prompt drift guard bites

- **WHEN** the needs-human-decision section is removed or its declaration format altered
- **THEN** the prompt drift-guard test SHALL fail

### Requirement: The declaration parser SHALL be an exported pure function that fails closed

The fix stage SHALL parse needs-human-decision declarations from the captured fix-harness output
using an exported pure function that performs a text scan only, with no network, git, or
subprocess calls. Absent, malformed, or multi-line declarations, and declarations carrying a
category outside the closed set, SHALL yield no parsed declaration.

#### Scenario: Absent declaration yields nothing

- **WHEN** the harness output contains no needs-human-decision declaration line
- **THEN** the parser SHALL return an empty result

#### Scenario: Malformed declaration is not parsed

- **WHEN** a declaration line is missing a field, breaks across lines, or omits the delimiter
  before the decision request
- **THEN** the parser SHALL not return a declaration for it

#### Scenario: Unknown category is not parsed

- **WHEN** a declaration carries a category outside `product-decision`, `authority`,
  `external-dependency`
- **THEN** the parser SHALL not return a declaration for it

#### Scenario: Parsing performs no I/O

- **WHEN** the parser runs in a unit test
- **THEN** it SHALL complete with no network, git, or subprocess calls

### Requirement: A declaration SHALL be accepted only when its identity, SHA, and evidence are complete

The fix stage SHALL accept a needs-human-decision declaration only when its
`(override-key, finding-fingerprint)` identity matches a finding actually rendered into this
round's fix prompt, its reviewed SHA equals the current worktree `HEAD`, and its decision request
is a non-empty single line. Any declaration failing one of these conditions SHALL be ignored.

#### Scenario: Identity outside the rendered findings is ignored

- **WHEN** a declaration's `(override-key, finding-fingerprint)` pair matches no finding rendered
  into this round's fix prompt
- **THEN** the fix stage SHALL ignore that declaration

#### Scenario: Stale reviewed SHA is ignored

- **WHEN** a declaration's reviewed SHA differs from the current worktree `HEAD`
- **THEN** the fix stage SHALL ignore that declaration

#### Scenario: Empty decision request is ignored

- **WHEN** a declaration carries an empty or whitespace-only decision request
- **THEN** the fix stage SHALL ignore that declaration

### Requirement: An accepted declaration SHALL park the round with a human-decision blocker

The fix stage SHALL, on a fix round that produced no new commit and salvaged nothing and that
carries at least one accepted needs-human-decision declaration, block the round with a blocker
kind dedicated to a required human decision. It SHALL NOT classify the round as
`no-commits`, as a test/build-gate failure, or as a successful fix.

#### Scenario: Valid product-decision declaration parks instead of failing as no-commits

- **WHEN** a fix round produces no new commit, salvage finds nothing, and the harness output
  carries an accepted `product-decision` declaration
- **THEN** the fix stage SHALL block with the human-decision blocker kind
- **AND** SHALL NOT block with `blockerKind: "no-commits"`
- **AND** SHALL NOT report the round as advanced

#### Scenario: Each sanctioned category parks

- **WHEN** an accepted declaration carries `product-decision`, `authority`, or
  `external-dependency`
- **THEN** the fix stage SHALL block with the human-decision blocker kind in each case

#### Scenario: Human-decision blocker has an unblock recipe

- **WHEN** the human-decision blocker kind is rendered into a blocked comment
- **THEN** a dedicated "How to unblock" recipe SHALL be present for it naming the existing
  human-driven unblock and override verbs

### Requirement: The human-decision blocker SHALL classify as a product-judgment intervention

The engine SHALL map the human-decision blocker kind to the existing `HumanInterventionKind`
member `"product-judgment-required"` when emitting the `human_intervention` event. It SHALL NOT
map it to `"test-build-failure"`, and SHALL NOT add, rename, or remove any taxonomy member.

#### Scenario: Emitted intervention kind is product-judgment-required

- **WHEN** a fix round parks with the human-decision blocker kind
- **THEN** the emitted `human_intervention` event SHALL carry
  `kind: "product-judgment-required"`
- **AND** SHALL NOT carry `kind: "test-build-failure"`

#### Scenario: Taxonomy membership is unchanged

- **WHEN** this change is applied
- **THEN** the set of `HumanInterventionKind` members SHALL be identical to the set before the
  change

### Requirement: A park SHALL post durable readable evidence per accepted declaration

The fix stage SHALL post one durable, human-readable, pipeline-attested comment per accepted
declaration, carrying the decision category, the decision request, the finding key, the finding
fingerprint, the reviewed SHA, and the stage. The comment SHALL use a heading and sentinel
distinct from the operator override sentinel and from the non-reproducing disposition sentinel.

#### Scenario: Evidence comment carries the full declaration payload

- **WHEN** a fix round parks on an accepted declaration
- **THEN** it SHALL post a comment naming the category, the decision request, the finding key,
  the finding fingerprint, the reviewed SHA, and the stage

#### Scenario: Evidence sentinel is distinct from override and non-reproducing sentinels

- **WHEN** the evidence comment is rendered
- **THEN** its heading and machine sentinel SHALL differ from those used by the operator
  `pipeline-override` comment and by the `pipeline-non-reproducing` disposition comment

#### Scenario: One comment per accepted declaration

- **WHEN** a round carries two accepted declarations for two distinct findings
- **THEN** two evidence comments SHALL be posted, one per declaration

### Requirement: The outcome SHALL never advance the item nor suppress a blocking finding

The needs-human-decision outcome SHALL never transition the item to a review round, to pre-merge,
or to ready-to-deploy, and SHALL never record an override, a disposition, or any other record
that suppresses or clears a blocking finding. The declared findings SHALL remain in the blocking
set and SHALL be re-evaluated normally on the next entry.

#### Scenario: No forward transition on park

- **WHEN** a fix round parks on an accepted declaration
- **THEN** the item SHALL NOT transition to `review-2`, `pre-merge`, or `ready-to-deploy`

#### Scenario: Declared findings remain blocking

- **WHEN** a fix round parks on an accepted declaration for finding key K
- **AND** the pipeline later re-enters a stage that evaluates the blocking set at the same
  reviewed SHA
- **THEN** finding K SHALL still be treated as blocking
- **AND** no override or non-reproducing disposition SHALL have been recorded for it

#### Scenario: Resumption stays human-driven and audited

- **WHEN** an operator resolves a parked human decision
- **THEN** resumption SHALL occur only through the existing unblock/override flow
- **AND** the engine SHALL NOT auto-resume, auto-amend the issue's acceptance criteria, or infer
  any authority on the human's behalf

### Requirement: A round with no accepted declaration SHALL retain the existing fail-closed behavior

The fix stage SHALL, on a no-commit round in which no needs-human-decision declaration is
accepted, behave exactly as before this change — including blocking with
`blockerKind: "no-commits"` and its existing reason text when no other carve-out applies.

#### Scenario: Missing declaration still blocks as no-commits

- **WHEN** a fix round produces no new commit, salvage finds nothing, and the harness output
  carries no needs-human-decision declaration and no valid does-not-reproduce declaration
- **THEN** the fix stage SHALL block with `blockerKind: "no-commits"`

#### Scenario: Malformed or stale declaration still blocks as no-commits

- **WHEN** the only needs-human-decision declaration present is malformed, carries an unknown
  category, carries a stale reviewed SHA, or carries an unmatched finding identity
- **THEN** the fix stage SHALL block with `blockerKind: "no-commits"`
- **AND** SHALL NOT park with the human-decision blocker kind

### Requirement: The needs-human-decision outcome SHALL take precedence over the does-not-reproduce advance

The fix stage SHALL evaluate accepted needs-human-decision declarations before the
does-not-reproduce advance decision on the no-commit path. When at least one declaration is
accepted, the round SHALL park regardless of any does-not-reproduce declarations present. When no
declaration is accepted, the does-not-reproduce path SHALL behave exactly as before this change.

#### Scenario: Mixed round parks rather than advancing

- **WHEN** a no-commit fix round carries one accepted needs-human-decision declaration and valid
  does-not-reproduce declarations for the remaining invoked findings
- **THEN** the fix stage SHALL park with the human-decision blocker kind
- **AND** SHALL NOT advance to the round's next stage

#### Scenario: Pure does-not-reproduce round is unchanged

- **WHEN** a no-commit fix round carries no needs-human-decision declaration and every invoked
  blocking finding is covered by a valid does-not-reproduce declaration
- **THEN** the fix stage SHALL advance from `fix-1` to `review-2`, or from `fix-2` to
  `pre-merge`, exactly as before this change

#### Scenario: Normal fix-and-commit flow is unchanged

- **WHEN** a fix round's harness produces commits
- **THEN** the round SHALL proceed through the existing commit-message, OpenSpec, lock-file, and
  format/test gates with no new behavior introduced by this change

### Requirement: The park decision SHALL be unit-testable without real I/O

The fix stage SHALL expose the needs-human-decision parse and park decision as pure exported
functions operating over the captured harness output, the rendered finding identities, and the
worktree `HEAD` the no-commit check already reads, so both are exercisable through the existing
fix-stage test seams. The regression suite SHALL cover a valid `product-decision` park, each
category, a malformed declaration, a missing decision request, a stale reviewed SHA, an unmatched
finding identity, the mixed human-decision + does-not-reproduce round, and the preserved
does-not-reproduce advance, and SHALL fail against the pre-change fix stage.

#### Scenario: Regression tests cover the paths and bite

- **WHEN** the fix-stage regression tests run
- **THEN** they SHALL assert the valid-declaration path blocks with the human-decision blocker
  kind and posts evidence
- **AND** SHALL assert each of the three categories parks
- **AND** SHALL assert the malformed, missing-request, stale-SHA, and unmatched-identity cases
  block with `blockerKind: "no-commits"`
- **AND** SHALL assert the mixed round parks and the pure does-not-reproduce round advances
- **AND** SHALL fail when run against the fix stage without this outcome

#### Scenario: Tests perform no real I/O

- **WHEN** the regression suite runs
- **THEN** it SHALL inject `gh`, harness, and worktree behavior through the existing dependency
  seams with no real network, git, or subprocess calls

