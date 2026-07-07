# fix-round-noop-advance Specification

## Purpose
TBD - created by archiving change fix-round-noop-advance. Update Purpose after archive.
## Requirements
### Requirement: The fix stage SHALL exclude actively-overridden findings from a fix round before invoking the harness

The fix stage SHALL, at fix-round entry and before invoking the fix harness,
recompute the effective blocking set for the triggering review by subtracting the
findings dispositioned by an **active** override — a key override or scope override
recorded on the issue/PR after the triggering review comment. Overrides SHALL be read
only from trusted-author comments (the same trust model as `buildTrustedOverrideComments`),
and each triggering finding SHALL be matched to an override by its stable `findingKey`
(key overrides) or by scope match (scope overrides), using the single identity
implementation in `review-policy.ts` and never a re-implementation. The fix stage
SHALL NOT rely solely on the review comment's frozen `pipeline-blocking-keys` marker,
because that marker cannot reflect overrides recorded after the review.

#### Scenario: Live key override recorded after the review is subtracted at fix entry

- **WHEN** a fix round begins whose triggering review's blocking finding has a stable key K
- **AND** a trusted-author `pipeline-override` sentinel for key K exists on the issue, recorded after the review comment
- **THEN** the fix stage SHALL treat that finding as dispositioned and exclude it from the effective blocking set

#### Scenario: Scope override subtracts every matching triggering finding

- **WHEN** a fix round begins whose triggering review contains findings matching an active `category:` or `file:` scope override
- **THEN** every finding matching the scope SHALL be excluded from the effective blocking set, regardless of its individual key

#### Scenario: Override identity is not re-implemented

- **WHEN** the fix stage matches a triggering finding against a recorded override
- **THEN** it SHALL compute the finding's key via `findingKey` and its scope match via the `review-policy.ts` scope matcher
- **AND** SHALL NOT derive finding identity by any other algorithm

### Requirement: A fix round with an empty effective blocking set SHALL advance without invoking the harness

The fix stage SHALL, when the triggering review's effective blocking set is empty after
subtracting active overrides, skip the fix harness invocation and advance to the
round's next stage — `fix-1` to `review-2`, `fix-2` to `pre-merge` — posting an
audited comment that itemizes which override dispositioned each triggering finding. It
SHALL NOT block with `blockerKind: "no-commits"`.

#### Scenario: All triggering blockers overridden — round 1 advances to review-2

- **WHEN** a fix-round-1 begins and every blocking finding from the triggering review has an active override
- **THEN** the fix stage SHALL advance from `fix-1` to `review-2` without invoking the harness
- **AND** SHALL NOT block with `blockerKind: "no-commits"`
- **AND** SHALL post an audited comment naming each override that dispositioned a finding

#### Scenario: All triggering blockers overridden — round 2 advances to pre-merge

- **WHEN** a fix-round-2 begins and every blocking finding from the triggering review has an active override
- **THEN** the fix stage SHALL advance from `fix-2` to `pre-merge` without invoking the harness
- **AND** SHALL NOT block with `blockerKind: "no-commits"`

#### Scenario: Some triggering blockers overridden — harness runs scoped to the remainder

- **WHEN** a fix round begins and only some of the triggering review's blocking findings have active overrides
- **THEN** the fix harness SHALL be invoked
- **AND** the findings rendered into the fix prompt SHALL be exactly the non-overridden remainder
- **AND** the overridden findings SHALL NOT appear in the fix prompt

### Requirement: The fix harness SHALL have a sanctioned does-not-reproduce outcome distinct from the no-commits block

The fix prompt SHALL define a sanctioned outcome for an assigned blocking finding
that does not reproduce at the reviewed SHA: instead of silently making no commit, the
harness SHALL emit one controlled, machine-readable declaration per such finding,
carrying the finding's stable key, the reviewed SHA it assessed against, and a
one-line justification. The fix stage SHALL recognize these declarations on the
no-commit path and SHALL NOT treat a finding covered by a valid declaration as a bare
"reported success but produced no new commits" failure.

#### Scenario: Does-not-reproduce instruction is present in the fix prompt

- **WHEN** the fix prompt is built for any fix round
- **THEN** it SHALL instruct the harness that a finding which does not reproduce at the reviewed SHA is declared via the controlled per-finding declaration (finding key + reviewed SHA + justification) rather than by silently making no commit

#### Scenario: A valid declaration is not treated as a no-commits failure

- **WHEN** a fix round produces no new commit, salvage finds nothing, and the harness output carries a valid does-not-reproduce declaration for an invoked blocking finding
- **THEN** the fix stage SHALL NOT classify that finding as an unexplained no-commit failure

### Requirement: A declaration SHALL be validated against the invoked findings and the current HEAD

The fix stage SHALL treat a does-not-reproduce declaration as valid only when its
finding key belongs to the set of blocking findings actually invoked in this round
**and** its reviewed SHA equals the current worktree `HEAD` (the tree the harness
saw). A declaration whose key is outside the invoked set, or whose reviewed SHA
differs from the current `HEAD`, SHALL be ignored. The fix stage SHALL fail closed:
an invalid or missing declaration for any invoked blocking finding SHALL NOT count
toward an advance.

#### Scenario: Declaration key outside the invoked set is ignored

- **WHEN** a does-not-reproduce declaration carries a finding key that was not among the blocking findings invoked this round
- **THEN** the fix stage SHALL ignore that declaration

#### Scenario: Declaration SHA not equal to current HEAD is ignored

- **WHEN** a does-not-reproduce declaration carries a reviewed SHA that differs from the current worktree HEAD
- **THEN** the fix stage SHALL ignore that declaration

### Requirement: A round whose invoked blockers are all validly declared non-reproducing SHALL advance

The fix stage SHALL advance to the round's next stage — `fix-1` to `review-2`, `fix-2`
to `pre-merge` — rather than blocking, when a fix round produces no new commit, salvage
finds nothing, and every invoked blocking finding is covered by a valid
does-not-reproduce declaration. A round in which at least one invoked blocking finding
is neither committed nor covered by a valid declaration SHALL continue to block with
the existing `no-commits` blocker (fail closed).

#### Scenario: All invoked blockers declared non-reproducing — round 1 advances to review-2

- **WHEN** a fix-round-1 harness exits, `headBefore === headAfter`, salvage finds nothing, and every invoked blocking finding has a valid does-not-reproduce declaration
- **THEN** the fix stage SHALL advance from `fix-1` to `review-2`
- **AND** SHALL NOT block with `blockerKind: "no-commits"`

#### Scenario: All invoked blockers declared non-reproducing — round 2 advances to pre-merge

- **WHEN** a fix-round-2 harness exits, `headBefore === headAfter`, salvage finds nothing, and every invoked blocking finding has a valid does-not-reproduce declaration
- **THEN** the fix stage SHALL advance from `fix-2` to `pre-merge`
- **AND** SHALL NOT block with `blockerKind: "no-commits"`

#### Scenario: Partial declaration coverage still blocks

- **WHEN** a fix round produces no new commit and salvage finds nothing
- **AND** at least one invoked blocking finding has neither a commit nor a valid does-not-reproduce declaration
- **THEN** the fix stage SHALL block with `blockerKind: "no-commits"`
- **AND** SHALL NOT advance

### Requirement: The does-not-reproduce disposition SHALL be recorded and consulted, anchored to the reviewed SHA

On a does-not-reproduce advance the fix stage SHALL record an audited disposition on
the issue/PR carrying a sentinel distinct from the operator `pipeline-override`
sentinel, recording the finding key, the reviewed SHA, the stage, and the
justification. On a subsequent fix or review entry, a recorded non-reproducing
disposition SHALL be consulted (trusted-author filtered) and SHALL suppress
re-blocking a finding **only when** the recorded reviewed SHA equals the current
reviewed SHA. When the reviewed SHA has changed, the disposition SHALL NOT apply and
the finding SHALL be evaluated afresh. This disposition SHALL be weaker than an
operator override: it is machine-authored and SHA-scoped, never an unconditional
clearance.

#### Scenario: Recorded disposition suppresses the dead-end at the same SHA

- **WHEN** a does-not-reproduce disposition for finding key K at reviewed SHA S has been recorded
- **AND** the pipeline re-enters fix or review for the same finding while the reviewed SHA is still S
- **THEN** finding K SHALL be treated as dispositioned and SHALL NOT reproduce the no-commits dead-end

#### Scenario: A SHA change re-opens the finding

- **WHEN** a does-not-reproduce disposition for finding key K at reviewed SHA S has been recorded
- **AND** the reviewed SHA is now S′ ≠ S (a new commit landed)
- **THEN** the recorded disposition SHALL NOT apply to finding K
- **AND** finding K SHALL be evaluated as if no disposition existed

#### Scenario: Disposition sentinel is distinct from an operator override

- **WHEN** a does-not-reproduce disposition is recorded
- **THEN** it SHALL use a sentinel distinct from `pipeline-override`
- **AND** the recorded sentinel SHALL carry the reviewed SHA it is anchored to

### Requirement: The normal fix-and-commit flow SHALL be unchanged

The fix stage SHALL behave exactly as before this change for a fix round whose
triggering review has at least one blocking finding that is not overridden and
reproduces at the reviewed SHA: the harness is invoked with those findings, produces
commits, and the round advances through the existing commit-message, OpenSpec,
lock-file, and format/test gates. The override pre-filter and the does-not-reproduce
path SHALL introduce no new behavior on this path.

#### Scenario: Genuine reproducing finding follows the existing flow

- **WHEN** a fix round's triggering review has a non-overridden, reproducing blocking finding
- **THEN** the fix harness SHALL be invoked with that finding, produce a commit, and advance through the existing gates exactly as before this change

### Requirement: The override pre-filter and does-not-reproduce decision SHALL be unit-testable without real I/O

The override subtraction SHALL operate over the issue comments the fix stage already
fetches, and the does-not-reproduce recognition SHALL operate over the captured
harness output and the worktree `HEAD` already read for the no-commit check, so both
decisions are exercisable through the existing fix-stage test seams with no real
network, git, or subprocess calls. The declaration parser/validator SHALL be an
exported pure function. The regression suite SHALL cover the all-overridden
skip-advance path, the partial-scope path, the all-declared advance path, the
partial-coverage block path, the invalid-declaration-ignored path, and the
SHA-anchored consultation path, and SHALL bite against the pre-change fix stage.

#### Scenario: Regression tests cover the paths and bite

- **WHEN** the fix-stage regression tests run
- **THEN** they SHALL assert the all-overridden path advances without invoking the harness or calling `setBlocked`
- **AND** SHALL assert the all-declared path advances to the correct next stage without a `no-commits` block
- **AND** SHALL assert the partial-coverage path returns a `no-commits` blocked outcome
- **AND** SHALL fail when run against the fix stage without these decisions

