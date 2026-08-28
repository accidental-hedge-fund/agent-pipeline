## ADDED Requirements

### Requirement: A successful same-process checkpoint SHALL be eligible for post-implement publish

When the same process observes a harness timeout (or equivalent harness failure) and ownership checkpoint authored a salvage-equivalent commit, and porcelain is then clean of unknown product dirt, the engine SHALL treat that checkpoint as recovered work for the unpublished-stage-commit-publish classifier. The engine SHALL NOT park as terminal `harness-failure` solely because the harness timed out, and SHALL NOT require the legacy unscoped salvage helper to have set `salvaged` in order to proceed. When the implement deliverable is satisfied, the engine SHALL enter the post-implement publish path defined by `unpublished-stage-commit-publish`. When the deliverable is unsatisfied, existing completeness (re-invoke implementer) SHALL still apply. Failed checkpoint with remaining owned leftovers SHALL remain `harness-failure` as already specified.

#### Scenario: Timeout after checkpoint does not park solely on timed-out

- **WHEN** the implement harness returns timeout
- **AND** ownership checkpoint creates a salvage-equivalent commit
- **AND** the worktree is then clean of unknown product dirt
- **AND** the implement deliverable is satisfied
- **THEN** the engine SHALL NOT `setBlocked` solely with reason `timed out after <N>s`
- **AND** SHALL proceed to post-implement publish (gates → push → PR → `review-1`)

#### Scenario: Legacy salvaged flag is not required after checkpoint

- **WHEN** ownership checkpoint already authored the owned leftovers
- **AND** the legacy unscoped salvage helper is skipped so its `salvaged` result is false
- **THEN** the engine SHALL still treat the checkpoint commit as salvage-equivalent recovered work
- **AND** SHALL NOT take the `!salvaged` timeout-block path

#### Scenario: Failed checkpoint still parks as harness-failure

- **WHEN** ownership checkpoint fails and owned leftovers remain
- **THEN** the residual block SHALL remain `harness-failure`
- **AND** the engine SHALL NOT publish or transition to `review-1`
