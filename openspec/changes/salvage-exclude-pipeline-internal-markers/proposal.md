## Why

The uncommitted-work salvage path (#131) stages harness leftovers with `git add -A`
minus a `node_modules` exclusion. Nothing else is excluded — so any other
untracked/modified file in the worktree is fair game for the salvage commit.

`core/scripts/stages/pre_merge.ts` writes a pipeline-internal marker file,
`.pipeline-rebase-attempted` (`REBASE_MARKER_FILE`), to the **worktree root** when it
attempts a one-time auto-rebase (`markRebaseAttempted`). The marker is a transient,
host-local coordination file — it is read back with `fs.existsSync` to enforce the
one-attempt bound — and is **not** gitignored, so `git status --porcelain` reports it
as an untracked `??` entry.

When a later salvage runs (e.g. a fix round after the pre-merge rebase attempt) and the
harness produced no real change, the marker is the only dirty path in the worktree. The
salvage path sees a non-empty status, stages the marker with `git add -A`, and commits
it — producing a round whose **entire content is `.pipeline-rebase-attempted`**. This
is a meaningless commit that pollutes the reviewed head with a pipeline-internal
artifact and can trip downstream commit checks.

Observed on lyric-utils#638 (run `638-2026-07-21T04-47-26-851Z`, engine v1.15.2). The
marker file was staged and committed as a round's only content. Surfaced as a human
comment on #450 and deferred here (out of scope for #450's update-race defect) per that
change's "Deferred (out of scope, follow-up)" section.

## What Changes

- **The salvage path SHALL exclude pipeline-internal marker files from what it treats as
  salvageable uncommitted work** — the same belt-and-suspenders way `node_modules` is
  excluded. This has two halves, because unlike `node_modules` the marker is not
  gitignored and so `git status --porcelain` *does* report it:
  1. **Dirtiness determination** (`git status --porcelain`, both the unscoped default and
     the scoped variant) SHALL not count a pipeline-internal marker file as salvageable
     work. A worktree whose only dirty path is `.pipeline-rebase-attempted` SHALL be
     treated as clean → salvage returns `{ salvaged: false }` and the caller falls
     through to its existing block / auto-recover path. No commit is produced.
  2. **Staging** (`git add`, both the unscoped and scoped add-args) SHALL carry an
     explicit **depth-agnostic** exclusion pathspec for the marker
     (`:(exclude,glob)**/.pipeline-rebase-attempted`), so the marker is never staged even
     if it coexists with real changed files, and even if `.git/info/exclude` never listed
     it.
- **The set of pipeline-internal marker filenames SHALL be single-sourced.** A canonical
  exported list (currently just `.pipeline-rebase-attempted`) is the one place both the
  salvage exclusion and `pre_merge.ts`'s `REBASE_MARKER_FILE` refer to, so the two can
  never drift. A runtime test guards the alignment (no `tsc` step enforces it — see
  CLAUDE.md).

This is purely a staging-exclusion fix. The marker's own write/read semantics in
`pre_merge.ts` are unchanged; real uncommitted work continues to be salvaged exactly as
before.

## Capabilities

### Modified Capabilities
- `harness-uncommitted-salvage`: the salvage dirtiness check and staging both exclude
  pipeline-internal marker files, so a worktree whose only dirty path is a marker is
  treated as clean (no salvage commit), while genuine uncommitted work alongside a marker
  is still salvaged with the marker excluded.
- `worktree-staging-exclusions`: the salvage staging command carries an explicit
  depth-agnostic exclusion pathspec for pipeline-internal marker files, mirroring the
  existing `node_modules` exclusion.

## Acceptance Criteria

- [ ] With a dirty worktree whose **only** dirty path is `.pipeline-rebase-attempted`,
      the salvage path creates **no commit** and returns `{ salvaged: false }`; the caller
      follows its existing block / auto-recover path rather than committing the marker.
- [ ] With a dirty worktree containing both a real changed source file and
      `.pipeline-rebase-attempted`, the salvage commit includes the real source change and
      **excludes** the marker; no commit is ever produced whose only content is the marker.
- [ ] The salvage staging `git add` args include a depth-agnostic exclusion pathspec for
      the marker (`:(exclude,glob)**/.pipeline-rebase-attempted`) in both the unscoped
      default and the scoped (`openspec/`) variants.
- [ ] The scoped (`openspec/`) salvage path's existing behavior (stage only `openspec/`,
      leave out-of-scope files uncommitted) is unchanged, and it additionally excludes the
      marker.
- [ ] Existing salvage behavior for genuine uncommitted work (real files, node_modules
      exclusion, traceability trailers, downstream verification) is unchanged.
- [ ] The pipeline-internal marker filename is single-sourced: `REBASE_MARKER_FILE` in
      `pre_merge.ts` and the salvage exclusion list refer to the same canonical constant, and
      a runtime test asserts they stay aligned.
- [ ] A regression test bites: with a worktree mock whose only dirty path is the marker,
      the fix produces no salvage commit; removing the marker exclusion makes the test fail
      (a commit whose only content is the marker is produced).
- [ ] `npm run ci` passes (core tests, `plugin/` mirror sync, install smoke,
      `openspec validate --all`).

## Impact

- `core/scripts/salvage-harness-work.ts`: add a canonical `PIPELINE_INTERNAL_MARKER_FILES`
  exclusion (exported), fold it into the `git status --porcelain` dirtiness check (both
  unscoped and scoped) and the `git add` args (both unscoped and scoped), alongside the
  existing `SALVAGE_NODE_MODULES_EXCLUDE`.
- `core/scripts/stages/pre_merge.ts`: derive/align `REBASE_MARKER_FILE` from the canonical
  marker list so the salvage exclusion and the marker writer never drift.
- Co-located tests: `core/scripts/salvage-harness-work.test.ts` (marker-only → no commit;
  marker + real file → marker excluded; both scoped and unscoped) and a drift-guard test
  for the single-sourced marker constant.
- No config keys, CLI surface, state-machine edges, review/SHA-gate contracts, or the
  `.git/info/exclude` bootstrap change. The pre-merge rebase-marker write/read semantics
  are unchanged.
