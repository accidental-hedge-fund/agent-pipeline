## MODIFIED Requirements

### Requirement: Archive into living specs at finalize

At pre-merge the change SHALL be archived (`openspec archive`) — folding its spec deltas into `openspec/specs/` and moving the change under `openspec/changes/archive/` — and `openspec validate --all` SHALL pass before the item reaches `ready-to-deploy`. Before calling `openspec archive`, the pre-merge stage SHALL run a consistency guard: if developer or fix commits on the branch touched implementation files while the change's `specs/**` files were not among the changed paths, AND the most recent review verdict contained a finding flagging spec divergence, the stage SHALL block with a descriptive reason rather than archiving a potentially stale delta.

#### Scenario: archive on finalize when spec and code are consistent

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** the consistency guard does not detect a code-spec divergence
- **THEN** its change SHALL be archived into the living specs and `openspec validate --all` SHALL pass before advancing

#### Scenario: pre-merge blocks when code moved but spec did not and reviewer flagged divergence

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** developer or fix commits on the branch modified implementation files under `core/scripts/`
- **AND** the change's `specs/**` files are not among the branch-diff paths (spec was not updated)
- **AND** the most recent review verdict contains a finding that flagged divergence between the implementation and the spec delta
- **THEN** the pre-merge stage SHALL block with a reason naming the stale-delta condition
- **AND** SHALL NOT call `openspec archive`

#### Scenario: pre-merge proceeds when reviewer did not flag divergence

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** implementation files changed but spec files did not
- **AND** the most recent review verdict contains no finding flagging spec divergence
- **THEN** the consistency guard SHALL NOT block (the reviewer found no divergence, so the spec is presumed consistent)
- **AND** the archive step SHALL proceed normally

#### Scenario: consistency guard has a regression test that bites without the fix

- **WHEN** the test suite is run without the pre-merge consistency guard implemented
- **THEN** the regression test SHALL fail (i.e., the mock scenario that today archives a stale delta SHALL return `{ status: "blocked" }` only after the guard is in place)
