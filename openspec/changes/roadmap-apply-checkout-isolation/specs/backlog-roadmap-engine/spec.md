## ADDED Requirements

### Requirement: Roadmap docs PR writeback SHALL isolate git mutations from the operator checkout

Roadmap docs PR writeback SHALL perform all branch create/checkout, file write for
`docs/roadmaps/<repo>.md`, commit, and push operations inside a throwaway linked
worktree (or equivalent isolated git surface) derived from the repository when
`config.roadmap.pr_docs` is true. The writeback path SHALL NOT switch, check out, or
commit on the caller's current branch in the operator `repoDir` checkout. After writeback
completes or fails, the operator checkout's current branch SHALL be the same as before
the call (absent concurrent operator edits unrelated to writeback).

#### Scenario: Operator checkout branch is unchanged after PR writeback

- **WHEN** the operator's `repoDir` is on branch `main` (or any non-roadmap branch) and
  `openRoadmapPr` / `pipeline roadmap --apply` with `pr_docs` true performs docs PR
  writeback
- **THEN** writeback SHALL NOT invoke a branch switch or checkout against `repoDir` as
  the mutation target
- **AND** after the call returns, the operator checkout SHALL still be on the same branch
  it was on before the call

#### Scenario: Commit and push use the throwaway worktree path

- **WHEN** writeback creates a new commit for `docs/roadmaps/<repo>.md`
- **THEN** the commit and push operations SHALL execute with the throwaway worktree
  directory as their repository path
- **AND** that path SHALL be distinct from the operator `repoDir` path passed into
  writeback

#### Scenario: Throwaway worktree is cleaned up

- **WHEN** writeback finishes successfully or fails after creating a throwaway worktree
- **THEN** writeback SHALL attempt to remove that throwaway worktree
- **AND** cleanup failure SHALL NOT leave the operator checkout on a different branch

---

### Requirement: Roadmap docs PR writeback SHALL refresh an existing day-branch PR when content differs

Roadmap docs PR writeback SHALL update an existing day-keyed roadmap branch
(`roadmap/<repoSlug>-YYYY-MM-DD`) when a PR already exists for that branch and the newly
rendered `docs/roadmaps/<repo>.md` content differs from the content at that branch's head,
by committing and pushing the new content and returning the existing PR URL without
opening a second PR. When the rendered content is identical to the branch head, writeback
SHALL NOT create a new commit and SHALL still return the existing PR URL.

#### Scenario: Existing PR receives updated docs when the plan differs

- **WHEN** `findPrByHead` returns an open PR for the day-keyed branch
- **AND** the newly rendered roadmap markdown differs from `docs/roadmaps/<repo>.md` on
  that branch head
- **THEN** writeback SHALL commit and push the new content to the same branch
- **AND** SHALL return the existing PR URL
- **AND** SHALL NOT call create-PR for a duplicate PR

#### Scenario: Existing PR is a no-op when docs are unchanged

- **WHEN** `findPrByHead` returns an open PR for the day-keyed branch
- **AND** the newly rendered roadmap markdown is identical to `docs/roadmaps/<repo>.md` on
  that branch head
- **THEN** writeback SHALL NOT create a new commit
- **AND** SHALL return the existing PR URL

#### Scenario: Content comparison uses the branch head, not the operator working tree

- **WHEN** the operator `repoDir` working tree has a different or missing
  `docs/roadmaps/<repo>.md` than the day-keyed branch head
- **AND** an open PR exists for that branch
- **THEN** writeback SHALL decide update vs no-op by comparing against the branch head
  content (via the throwaway worktree or equivalent), not against the operator working
  tree file alone

---

### Requirement: Roadmap docs commits SHALL use honest, non-fossil commit metadata

The commit message for a roadmap docs PR commit SHALL describe the roadmap generation
(repo and generation date) and SHALL NOT hardcode fossil trailers from historical feature
work (including `Issue: #171` and `Pipeline-Run: 171/2026-06-17T04:37:16Z` or any other
constant paste from closed issue #171). When both an issue number and a pipeline run id
are supplied to writeback, the commit message SHALL append valid git trailers
`Issue: #<issueNumber>` and `Pipeline-Run: <pipelineRunId>` separated from the body by a
blank line. When issue/run context is not fully available, the commit message SHALL omit
those trailers rather than inventing placeholder values.

#### Scenario: Default roadmap CLI path has no fossil trailers

- **WHEN** `pipeline roadmap --apply` runs without an issue number or pipeline run id
  (the normal no-issue-number sub-command path)
- **AND** writeback creates a docs commit
- **THEN** the commit message SHALL NOT contain `Issue: #171`
- **AND** SHALL NOT contain `Pipeline-Run: 171/2026-06-17T04:37:16Z`
- **AND** SHALL NOT invent other placeholder `Issue:` / `Pipeline-Run:` trailer values

#### Scenario: Supplied issue and run id appear as trailers

- **WHEN** writeback is invoked with both a concrete issue number N and pipeline run id R
- **AND** a docs commit is created
- **THEN** the commit message SHALL end with a blank line followed by `Issue: #N` and
  `Pipeline-Run: R` trailers

#### Scenario: Partial context does not invent the missing trailer

- **WHEN** writeback has only an issue number or only a pipeline run id, but not both
- **AND** a docs commit is created
- **THEN** the commit message SHALL omit both `Issue:` and `Pipeline-Run:` trailers
  rather than inventing the missing value
