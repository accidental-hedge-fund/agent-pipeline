## ADDED Requirements

### Requirement: Explicit named treatments SHALL encode valid harness-specific configurations

An experiment manifest MAY declare a non-empty `named_treatments` array instead of Cartesian `treatments`. Every named treatment SHALL carry a unique, path-safe `id` and a `primary` coordinate containing a harness plus optional model and effort. A `paired` treatment SHALL also carry a reviewer coordinate. The runner SHALL reject a manifest that declares both treatment forms, duplicate ids, a missing required paired reviewer, or an invalid coordinate before creating a worktree or invoking a harness.

#### Scenario: Named pair treatments avoid invalid cross-products

- **WHEN** a manifest names `codex-grok` with a Codex primary coordinate and a Grok reviewer coordinate
- **THEN** the expanded plan contains exactly that treatment
- **AND** it SHALL NOT create a cell that sends the Grok model to Codex or vice versa

### Requirement: A paired cell SHALL execute an isolated primary-reviewer trajectory

A paired cell SHALL require an implementing fixture artifact and, in one fresh worktree at the fixture base commit, invoke its primary implementation, provide its reviewer the resulting actual diff and structured review contract, invoke the primary with blocking findings when present, and invoke the reviewer again against the final diff. The cell SHALL use one shared deadline, SHALL perform no production GitHub write, and SHALL run declared checks only against the final worktree state.

#### Scenario: Reviewer sees the produced diff

- **WHEN** the primary changes files during paired implementation
- **THEN** the reviewer prompt SHALL contain the diff derived from that paired cell's worktree
- **AND** SHALL NOT substitute a static fixture review artifact

#### Scenario: No blocking finding skips the fix invocation

- **WHEN** the first reviewer verdict contains no blocking finding
- **THEN** the primary fix invocation SHALL be skipped
- **AND** the final check and paired result records SHALL still be emitted

### Requirement: Paired results SHALL record convergence without inventing review accuracy

A completed paired cell SHALL record requested primary and reviewer coordinates, phase outcomes, first and final diff identities, both reviewer finding sets, whether a fix invocation occurred, and the final blocking-finding count. It SHALL expose final checks and changed paths for deterministic implementation grading. It SHALL NOT report reviewer precision or recall unless a separate seeded-review grade actually supplies that evidence.

#### Scenario: Malformed reviewer output is visible

- **WHEN** a paired reviewer does not emit a parseable verdict
- **THEN** the cell record SHALL retain the output and mark the review outcome malformed
- **AND** SHALL NOT treat it as approval
