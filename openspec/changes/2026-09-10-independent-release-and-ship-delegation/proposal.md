## Why

Release preparation and ship currently split one versioned publication across metadata, legacy FRG, finish, tag, publication, promotion, and deployment owners. Package 3 makes `pipeline release VERSION` the independently complete operator surface and makes SemVer ship delegate its tail once.

## What Changes

- Validate exactly one nonempty matching milestone and freshly prove each real issue has a merged implementation PR contained in the integration branch.
- Reconcile or prepare narrowly scoped version metadata in a dedicated worktree, prove both package versions and nonempty exact-head CI for every reused state, then freeze candidate C.
- Run and verify the package-2 exact-candidate FRG once for C, create or verify an immutable annotated tag at C, and verify the exact single-owner publisher workflow plus non-draft GitHub Release.
- Make retries reconstruct completion from authoritative Git, forge, CI, review, Tester, workflow, and Release facts. Local FRG state may checkpoint identity but is never completion authority, including from a fresh checkout.
- Retain prepare-only authority for factory/merge-queue callers without permitting packed-candidate handling to mutate the invoking checkout.
- Make SemVer ship call complete release once; continuous ship remains integration-only. Remove promotion, install, deployment, and legacy auto-tag ownership from release completion.

## Impact

Release/ship coordination, release workflows, generated CLI documentation, and release specifications change. Ordinary advance authority and protected repository configuration do not.
