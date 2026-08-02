## ADDED Requirements

### Requirement: Every production worktree-removal path SHALL use evaluateRemoveSafety or a written exemption

Every production call site that removes a pipeline-managed worktree SHALL either:

1. invoke `evaluateRemoveSafety` (directly or via a single shared wrapper that always evaluates it
   once before mutation), or
2. carry a written source exemption comment stating why terminal force-remove is safe at that site,
   and a regression test that asserts the exemption remains intentional.

Sites that historically force-removed without the ladder (including `auto_recover` and
`deploy_ready`) SHALL be brought under this rule. Operator `--remove-worktree` behavior with
optional `--force` remains as already specified.

#### Scenario: auto_recover removal is safety-gated

- **WHEN** `auto_recover` removes a managed worktree as part of recovery
- **THEN** the path SHALL evaluate `evaluateRemoveSafety` (or the shared wrapper) before mutation
- **AND** a dirty or local-only tree without force authority SHALL NOT be destroyed

#### Scenario: deploy_ready removal is safety-gated

- **WHEN** `deploy_ready` removes a managed worktree after ready-to-deploy
- **THEN** the path SHALL evaluate `evaluateRemoveSafety` (or the shared wrapper) before mutation
- **OR** SHALL carry a written exemption plus a regression test that documents why force-remove is
  safe in that terminal state

#### Scenario: Removal call-site registry test fails on unguarded new paths

- **WHEN** the unit test suite enumerates production worktree-removal call sites
- **THEN** each site SHALL be classified as ladder-backed or explicitly exempt
- **AND** an unguarded site without exemption SHALL fail the test
