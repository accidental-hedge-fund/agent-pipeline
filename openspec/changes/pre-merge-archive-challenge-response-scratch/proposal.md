## Why

Pre-merge OpenSpec archive cleanliness treats pipeline-owned challenge-response
dumps as operator work and `setBlocked` (`needs-human`). Observed on #1013 /
PR #1016 while shipping v1.38.0: review-2 approved, transition to
`pipeline:pre-merge` succeeded, then `maybeArchiveOpenspec` blocked three times
because porcelain listed only `?? artifacts/challenge-response-1013.json`. That
self-written design-gate dump parked a reviewed PR as if human edits were at
risk of destructive archive-failure rollback (`git restore .` +
`git clean -fd openspec/`). Sibling #1013 / PR #1016 teaches format/test gates
that this path is non-product scratch; after that merge, the same leftover file
still fails archive cleanliness because pre-merge only strips
`.pipeline-rebase-attempted` via `stripPipelineInternalMarkers` and does not
share `classifyWorktreeDirt` / `ENGINE_NON_PRODUCT_SCRATCH_GLOBS`.

## What Changes

- Pre-merge OpenSpec archive pre-cleanliness SHALL treat
  `artifacts/challenge-response-*.json` as pipeline-owned non-product scratch
  (same class as test-gate scratch / marker-only dirt): alone it MUST NOT
  `setBlocked`, and archive evaluation MUST proceed (or the dump is unlinked
  first, same as marker-only dirt).
- Real product dirt (`core/`, `plugin/`, dirty `openspec/` specs, other
  non-scratch paths) MUST still hard-block — destructive rollback remains
  lossless only when real work is absent.
- Nonzero `git status --porcelain` remains fail-closed.
- Unit regression on `maybeArchiveOpenspec`: porcelain with only
  `?? artifacts/challenge-response-N.json` does not call `setBlocked` for that
  path alone.
- Do **not** auto-commit challenge-response JSON into the product tree.
- Do **not** waive broad `artifacts/**` or weaken the guard for product /
  OpenSpec paths.

## Capabilities

### New Capabilities

- (none) — this extends the existing pre-merge OpenSpec archive cleanliness
  contract; no new capability surface is required.

### Modified Capabilities

- `openspec-integration`: Strengthen the pre-archive cleanliness guard so
  engine-known non-product scratch matching
  `artifacts/challenge-response-*.json` (and existing pipeline-internal
  markers) does not alone block archive, while product / dirty `openspec/`
  porcelain and failed `git status` remain fail-closed `needs-human` blocks.

## Acceptance criteria

- [ ] Porcelain that lists only `?? artifacts/challenge-response-<N>.json`
      does **not** cause `maybeArchiveOpenspec` to call `setBlocked` for that
      path alone; archive evaluation proceeds (or the dump is removed first
      and then proceeds).
- [ ] Porcelain that includes product paths under `core/`, `plugin/`, dirty
      `openspec/` specs, or other non-scratch paths still hard-blocks
      pre-merge archive with `needs-human` (or equivalent established dirty
      block) and does **not** invoke `openspec archive`.
- [ ] Nonzero `git status --porcelain` still fail-closes with `setBlocked`
      and does not treat the tree as clean.
- [ ] Challenge-response JSON is **not** auto-committed into the product tree
      as part of this fix.
- [ ] A unit regression on `maybeArchiveOpenspec` covers challenge-response-
      only porcelain and fails if that dirt alone reintroduces `setBlocked`.
- [ ] After any `core/` edits, `plugin/` is regenerated; `openspec validate`
      for this change and `npm run ci` pass.

## Impact

- `core/scripts/stages/pre-merge-openspec-archive.ts` — pre-archive
  cleanliness decision after `git status --porcelain`.
- Likely reuse of `classifyWorktreeDirt` /
  `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` from `core/scripts/worktree-dirt.ts`
  and/or extend marker-strip / unlink handling in
  `core/scripts/salvage-harness-work.ts` so archive shares the same
  non-product classification as format/test gates (#1013) without a parallel
  dirt model.
- Tests: `core/test/` pre-merge archive / `maybeArchiveOpenspec` regressions
  for scratch-only vs product dirt vs status failure.
- Generated `plugin/` mirror if `core/` changes.
- Living spec: `openspec-integration` (delta in this change).
- Depends on #1013 (challenge-response classified as engine-known scratch for
  gate trust); this change is the pre-merge archive consumer of that class.
