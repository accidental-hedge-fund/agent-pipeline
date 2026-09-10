## Why

Release preparation and ship currently split one versioned publication across metadata, legacy FRG, finish, tag, publication, promotion, and deployment owners. Package 3 makes `pipeline release VERSION` the independently complete operator surface and makes SemVer ship delegate its tail once.

## What Changes

- Validate exactly one nonempty matching milestone and freshly prove each real issue has a merged implementation PR contained in the integration branch.
- Reconcile or prepare narrowly scoped version metadata in a dedicated worktree, prove release-managed provenance, both package versions, immutable head, nonempty exact-head CI, exact merge identity, and containment for every reused state, including an already-merged PR whose source branch was deleted, then freeze candidate C. A matching version already on main without that PR proof fails closed.
- Run and verify the package-2 exact-candidate FRG once for C, create or verify an immutable annotated tag at C, and verify the exact single-owner publisher workflow plus non-draft GitHub Release.
- Make retries reconstruct completion from authoritative Git, forge, CI, review, Tester, workflow, and Release facts. Local FRG state may checkpoint identity but is never completion authority, including from a fresh checkout.
- Retain prepare-only authority for `release prepare`, `factory-release prepare`, and merge-queue `--release-when-complete`. Keep `release finish` as a metadata-PR merge helper that does not tag. Reject `release prepare --packed-candidate` during argument validation before any Git command. Ordinary advance, single, and loop do not gain merge or tag authority.
- Give `release.yml` one durable publisher-recovery state machine keyed by workflow identity plus tag plus C. Classify remote runs as absent, pending, failed, or successful. Permit at most one missing-run `workflow_dispatch` (`tag` + `candidate` inputs, `--ref` the exact tag) and one rerun, bounded by remote evidence. Use status-aware exact-tag Release lookup so only a confirmed non-auth 404 permits creation.
- Distinguish tagged-stale-C (tag exists, publication blocked by observable main movement) from a completed tag whose later docs refresh advanced main.
- Make SemVer ship call complete release once; continuous ship remains integration-only. Remove promotion, install, deployment, and legacy finish/auto-tag/docs-heal ownership from release completion.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `release-simplification-contract`: Define independently complete release, remote-evidence publisher recovery, exact metadata provenance including deleted-head reuse, caller-safe preparation, single tag/docs ownership, and SemVer ship delegation.

## Impact

Release/ship coordination, release workflows, generated CLI documentation, and release specifications change. Ordinary advance authority and protected repository configuration do not. No live release, fixture creation, promotion, installation, or deployment occurs while implementing this change.
