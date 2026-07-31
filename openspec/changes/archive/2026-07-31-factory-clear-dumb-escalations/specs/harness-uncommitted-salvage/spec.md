## ADDED Requirements

### Requirement: Pre-merge OpenSpec archive cleanliness SHALL ignore pipeline-internal markers

The pre-merge OpenSpec archive pre-cleanliness guard SHALL use the same pipeline-internal
marker exclusion as salvage (`PIPELINE_INTERNAL_MARKER_FILES` / strip of porcelain lines for
those paths). When `git status --porcelain` succeeds and the only dirty paths are
pipeline-internal markers, the archive step SHALL NOT set `blocked`/`needs-human`, SHALL
best-effort remove those marker files, and SHALL proceed with archive. When porcelain reports
any non-marker dirty path, the guard SHALL continue to fail closed (needs-human) as before.
When `git status` itself fails (non-zero exit), the guard SHALL fail closed.

#### Scenario: Marker-only dirt does not block archive

- **WHEN** the pre-archive `git status --porcelain` succeeds
- **AND** the only dirty path is `.pipeline-rebase-attempted` (or another entry in the
  canonical pipeline-internal marker list)
- **THEN** the pipeline SHALL NOT block pre-merge for dirty worktree
- **AND** SHALL best-effort remove the marker file(s)
- **AND** SHALL continue the archive path

#### Scenario: Marker plus real dirty work still blocks

- **WHEN** porcelain reports `.pipeline-rebase-attempted` and a real dirty path (for example
  `M core/scripts/foo.ts`)
- **THEN** the pipeline SHALL set `blocked`/`needs-human` for dirty worktree before archive
- **AND** SHALL NOT run `openspec archive` until the real dirty path is resolved
