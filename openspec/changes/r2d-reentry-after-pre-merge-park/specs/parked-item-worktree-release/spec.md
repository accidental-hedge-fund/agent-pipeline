## MODIFIED Requirements

### Requirement: Resume after release SHALL recreate via the normal create path

When an issue whose managed worktree was park-released is advanced again (unblock, re-run, or durable resume) **and the current stage requires a managed worktree** (planning / implementing bootstrap, or any earlier stage that executes in the worktree), the pipeline SHALL obtain a worktree through the existing `createWorktree` / planning bootstrap path. Same-issue reclaim and the rule that the current issue does not count against `max_concurrent_worktrees` for its own create SHALL remain in force. Park-release SHALL NOT invent a separate branch or worktree naming scheme. When the remote branch tip is absent but an open PR head SHA is available, `createWorktree` SHALL start from that PR head (fetching it) rather than from `origin/<base_branch>` alone.

When the current stage is at or after `pre-merge` and the run does not need a managed worktree for harness work, the pipeline SHALL NOT rematerialize a worktree solely so trusted-surface or ready-to-deploy can resolve a candidate SHA. Candidate SHA resolution on that path SHALL follow `trusted-surface-rebind` (linked open PR head matching the last-advanced candidate, or an explicit candidate-SHA override). Park-release safety and retain rules SHALL stay unchanged.

#### Scenario: Re-advance after release creates a new worktree

- **WHEN** issue N was park-released (no managed worktree on disk)
- **AND** the pipeline advances issue N again at a stage that requires a managed worktree
- **THEN** `createWorktree` (or equivalent bootstrap) SHALL create a managed worktree for issue N
- **AND** same-issue capacity exclusion SHALL still apply so issue N does not block itself

#### Scenario: Resume after PR-only release reconstructs at PR head

- **WHEN** issue N was park-released because an open PR with resolvable head SHA existed and the remote branch tip was absent
- **AND** the pipeline advances issue N again at a stage that requires a managed worktree
- **THEN** `createWorktree` SHALL use the open PR head (not only `origin/<base_branch>`) as the worktree start point

#### Scenario: Late-stage re-entry does not rematerialize solely for trusted-surface

- **WHEN** issue N was park-released (no managed worktree on disk)
- **AND** the pipeline re-enters issue N at or after `pre-merge`
- **AND** a linked open PR head matches the last-advanced candidate (or an explicit candidate-SHA override is present)
- **THEN** the pipeline SHALL NOT create a managed worktree solely to satisfy trusted-surface or ready-to-deploy candidate SHA resolution
- **AND** trusted-surface SHALL still resolve `candidate_sha` from that PR head or override

#### Scenario: Idempotent release when already absent

- **WHEN** durable park runs for issue N and no managed worktree is on disk
- **THEN** park-release SHALL be a no-op success
- **AND** SHALL NOT fail the park outcome solely because the worktree is already absent
