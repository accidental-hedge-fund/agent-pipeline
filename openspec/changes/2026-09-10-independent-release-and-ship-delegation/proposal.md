## Why

Release preparation and ship currently split one versioned publication across metadata, legacy FRG, finish, tag, publication, promotion, and deployment owners. Package 3 makes `pipeline release VERSION` the independently complete operator surface and makes SemVer ship delegate its tail once.

## What Changes

- Validate exactly one nonempty matching milestone and freshly prove each real issue has a merged implementation PR contained in the integration branch.
- Reconcile or prepare version metadata in a dedicated worktree, merge it through exact-head CI, then freeze candidate C.
- Run and verify the package-2 exact-candidate FRG once for C, create or verify an immutable annotated tag at C, and verify the exact tag-triggered publisher workflow plus non-draft GitHub Release.
- Make retries reconcile immutable external identity and retain prepare-only authority for factory/merge-queue callers.
- Make SemVer ship call complete release once; continuous ship remains integration-only. Remove promotion, install, deployment, and legacy auto-tag ownership from release completion.

## Impact

Release/ship coordination, release workflows, generated CLI documentation, and release specifications change. Ordinary advance authority and protected repository configuration do not.
