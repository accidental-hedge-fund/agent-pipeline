## ADDED Requirements

### Requirement: Post-implementation PR ensure disposes superseded open PRs

The post-implementation path SHALL, after creating or reusing the PR for issue N on the current managed head branch H (exact-head lookup, then create if missing), run supersede disposal for other open PRs associated with N whose head is not H, per the `supersede-issue-prs` capability, before treating ensure-PR as complete for the subsequent `implementing → review-1` transition. Exact-head reuse for H SHALL remain unchanged: when an open same-repo PR already exists for branch H, the path SHALL reuse that PR number and SHALL NOT create a duplicate PR for H. Supersede disposal SHALL run on both the create path and the reuse path so a stale associated PR on a different head is not left open solely because H already had a PR. When supersede disposal reports that the managed PR is **not** the GitHub-elected canonical open managed pipeline PR for N, the path SHALL NOT complete the stage transition as advanced and SHALL NOT treat ensure-PR as success for this concurrent head (so two hosts cannot both advance on PRs that close each other).

#### Scenario: New managed PR closes stale associated PR on other head

- **WHEN** the resume/post-implement path creates PR M for managed head H of issue N
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** open PR S is associated with N under dual strategies on a different head
  with base `cfg.base_branch`
- **AND** supersede mode is `close` (default)
- **THEN** the path SHALL close S with a `pipeline-superseded` comment naming M
- **AND** SHALL proceed using M for the transition comment

#### Scenario: Reused managed PR still supersedes other heads

- **WHEN** the resume/post-implement path finds existing PR M for managed head H
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** open PR S is associated with N on a different head with base `cfg.base_branch`
- **AND** supersede mode is `close` (default)
- **THEN** the path SHALL reuse M without calling create for H
- **AND** SHALL still dispose S under supersede rules

#### Scenario: Supersede failure does not prevent review-1 transition when managed PR is ready

- **WHEN** managed PR M for head H is successfully created or reused
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** supersede disposal fails for a candidate S
- **THEN** the path SHALL still be allowed to complete ensure-PR and transition
  toward `review-1` with PR M
- **AND** SHALL surface a log/diagnostic for the disposal failure

#### Scenario: Non-canonical concurrent managed PR does not transition

- **WHEN** the resume/post-implement path ensures PR M for managed head H
- **AND** supersede disposal reports M is not the GitHub-elected canonical open
  managed pipeline PR for N (another concurrent `pipeline/<N>-*` head won)
- **THEN** the path SHALL NOT transition out of `implementing` as advanced
- **AND** SHALL NOT close the elected winning managed PR

#### Scenario: Externally closed managed PR does not transition or dispose siblings

- **WHEN** the resume/post-implement path ensures PR M for managed head H
- **AND** the authoritative open-PR list used by supersede disposal omits M on head H
  (for example a human closed M after ensure)
- **AND** another open associated PR S for issue N remains on a different head
- **THEN** the path SHALL NOT transition out of `implementing` as advanced
- **AND** SHALL NOT close or supersede-comment S
