## ADDED Requirements

### Requirement: Train merge wave SHALL not STOP the ship on in-budget UNKNOWN mergeability

When `--merge` is provided and the train invokes the existing issue-PR merge
surface for a ready-to-deploy item’s linked open PR, a first-read
`mergeable: "UNKNOWN"` that the shared merge surface resolves to
`MERGEABLE`/`CLEAN` within its bounded retry budget SHALL be treated as a
successful merge-gate pass for that item (subject to the surface’s other gates
and train’s post-merge base containment). The train SHALL merge that PR, prove
containment as today, and continue the work list / frontier.

The train SHALL **not** produce a first-attempt whole-train STOP whose sole
error is the merge surface’s immediate UNKNOWN refusal text of the form
`merge failed for #<issue> PR #<pr>: PR mergeability is not yet computed
(UNKNOWN)...` when a later in-budget re-read would have succeeded.

When the merge surface fails after exhausting the UNKNOWN budget, or fails for
a hard unclean state (`CONFLICTING`, `DIRTY`, failed checks, wrong stage, head
mismatch, etc.), the train SHALL still stop that merge step without merging,
name the gate failure in train status, and exit non-zero for that path as
today. The train SHALL NOT invent a second train-local UNKNOWN recoverer that
bypasses the shared merge surface.

#### Scenario: First UNKNOWN then MERGEABLE continues the train

- **WHEN** `pipeline train --merge` reaches a ready-to-deploy item whose linked open PR’s first mergeability read is `UNKNOWN`
- **AND** a later in-budget re-read on the shared merge surface is `MERGEABLE` with `mergeStateStatus: "CLEAN"`
- **AND** the remaining merge gates pass
- **THEN** the train SHALL complete the merge for that PR
- **AND** SHALL prove merge-result containment in the fetched base before starting the next dependent work
- **AND** SHALL NOT exit 1 solely because the first mergeability read was UNKNOWN
- **AND** a hermetic fixture with injected deps SHALL assert first-read UNKNOWN then success without a train STOP for that class

#### Scenario: #1059-class first-attempt UNKNOWN STOP is not legal when budget would succeed

- **WHEN** a unit or train fixture models the #1059 20:04Z class (first mergeability UNKNOWN, subsequent in-budget MERGEABLE+CLEAN)
- **THEN** the train SHALL NOT record a terminal error of only
  `merge failed for #<issue> PR #<pr>: PR mergeability is not yet computed (UNKNOWN)...`
  as the outcome of that merge step
- **AND** the regression SHALL fail if that first-attempt terminal is reintroduced for the in-budget success path

#### Scenario: Post-budget UNKNOWN still stops the merge step

- **WHEN** the shared merge surface exhausts its UNKNOWN retry budget and still reports UNKNOWN
- **THEN** the train SHALL stop the merge step without merging that PR
- **AND** train status SHALL name the merge failure
- **AND** the train exit for that path SHALL be non-zero

#### Scenario: CONFLICTING still does not merge

- **WHEN** the linked PR reports `mergeable: "CONFLICTING"` (or other hard unclean merge gate failure under the shared surface)
- **THEN** the train SHALL NOT merge that PR
- **AND** the train SHALL stop without treating CONFLICTING as an UNKNOWN retry success path
