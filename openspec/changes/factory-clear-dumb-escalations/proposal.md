# Change: Clear dumb pre-merge escalations (marker dirt + code-behind-spec)

## Why

Dogfood of the v1.29.2 loop showed the majority of items parking at
`needs-human` for **mechanical** recoveries the factory owns:

1. OpenSpec archive blocked on `?? .pipeline-rebase-attempted` — an
   engine-owned host-local marker that salvage already treats as non-work
   (#522 / #597).
2. Pure residual `spec-divergence` with structured
   `spec_divergence_direction: code-behind-spec` first-hopping to human
   without an implementer auto-fix (#729 dogfood). That direction means
   the acceptance criteria already require the behavior; the code must
   change — that is implementer work, not product judgment.

## What Changes

- Pre-archive cleanliness strips `PIPELINE_INTERNAL_MARKER_FILES` from the
  dirt decision (same helper as salvage). Marker-only porcelain unlinks
  the markers and proceeds; genuine dirty paths still fail closed.
- `isAutoFixableFinding` treats `spec-divergence` +
  `code-behind-spec` as auto-fixable. Direction-less and
  `spec-behind-code` remain residual (spec-behind-code is a delta/spec
  repair path, not the implementer autofix harness).

## Impact

- Capabilities: `pre-merge-fix-round`, `harness-uncommitted-salvage`
  (marker strip shared), pre-merge archive path in `pre_merge.ts`.
- Unblocks the common dogfood failure mode without weakening real
  product-judgment, security, or genuine dirty-worktree guards.
