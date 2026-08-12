## Why

The format/test dirty-worktree trust check can hard-block a healthy fix stage on
pipeline-generated challenge-response dumps under `artifacts/`, not product source.
Dogfood on #1010 / PR #1012 showed the real fix already committed and pushed
(`7bc3f699`), harness/`npm run ci` already passed in-stage, yet the test gate blocked
with `blocker_kind: test-gate-exhausted` solely because porcelain listed
`artifacts/challenge-response-1010.json` — a design-gate / review challenge JSON dump
left by the harness, not application code. That misclassifies engine/harness scratch as
product dirt, burns fix-stage recovery, and labels the issue `blocked` even though
product HEAD is clean.

This contradicts the intent of dirty-gate trust (#873 / `test-gate-non-product-dirty`):
agent/pipeline scratch must not alone refuse the gate or burn budget as
`test-gate-exhausted`. Today `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` only covers `tasks/**`
and `.pipeline-prompt-*`; root `artifacts/challenge-response-*.json` is treated as
product.

## What Changes

- Treat pipeline-owned challenge-response dumps (observed path
  `artifacts/challenge-response-<issue>.json`, and any relocated equivalent under a
  non-product namespace) as **engine-known non-product scratch** for format/test gate
  trust — or ensure they are not left as uncommitted product dirt before the gate.
- Keep uncommitted **real** product paths (`core/`, `plugin/`, `openspec/`, lockfiles,
  other non-scratch namespaces) hard-blocking with path disclosure.
- Ensure a fix stage that has committed+pushed all product changes and only has
  pipeline challenge-response (or equivalent) scratch left does **not** end in
  `blocked` / `test-gate-exhausted` solely for that scratch.
- Add pure classifier and gate-level regressions that bite without the exemption.
- Do **not** auto-commit challenge-response JSON into the product tree.
- Do **not** weaken dirty checks for product namespaces via broad `artifacts/**`
  waivers.

## Capabilities

### New Capabilities

- (none) — this extends the existing non-product dirty trust model; no new capability
  surface is required.

### Modified Capabilities

- `test-gate-non-product-dirty`: Expand the engine-known non-product scratch set (and
  related classification requirements) so pipeline-owned challenge-response dumps
  (e.g. `artifacts/challenge-response-*.json` and/or a relocated
  `.agent-pipeline/`-namespaced equivalent) classify as scratch, not product dirt, for
  format/test gate trust. Product namespaces and lockfiles remain fail-closed.
- `test-build-gate`: Align “clean enough for a trusted run” wording/examples so
  challenge-response (or relocated equivalent) scratch-only porcelain follows the same
  scratch-only path as `tasks/**` / `.pipeline-prompt-*` and does not mint a
  product-dirt / exhaustion-style block alone.

## Acceptance criteria

- [ ] Porcelain that lists only `artifacts/challenge-response-<N>.json` (or the chosen
      relocated non-product equivalent) classifies as **scratch** with empty product
      dirt via the shared classifier.
- [ ] Format/test pre-run dirty trust does **not** hard-block when the only uncommitted
      paths are those challenge-response scratch paths and product HEAD has no
      uncommitted product paths.
- [ ] After a fix stage that committed and pushed all product changes, residual
      challenge-response scratch alone does **not** set `blocked` with
      `blocker_kind: test-gate-exhausted` (or equivalent product-dirt exhaustion
      wording) solely for that scratch.
- [ ] Uncommitted product paths under `core/`, `plugin/`, `openspec/`, `hosts/`,
      `scripts/`, recognized lockfiles, and other non-scratch paths still hard-block
      with product-path disclosure.
- [ ] Challenge-response JSON is **not** auto-committed into the product tree as part
      of this fix.
- [ ] A unit regression on `classifyWorktreeDirt` / `productDirtyPaths` covers the
      chosen challenge-response path and fails if the path is reclassified as product.
- [ ] A gate-level (test-gate and/or format-gate) regression drives scratch-only
      challenge-response porcelain and asserts no product-dirt hard block /
      `test-gate-exhausted` for that dirt alone.
- [ ] After any `core/` edits, `plugin/` is regenerated; `openspec validate` for this
      change and `npm run ci` pass.

## Impact

- `core/scripts/worktree-dirt.ts` — engine-known scratch globs / classification for
  challenge-response (or relocated) paths.
- `core/scripts/testgate.ts` and format-gate dirty trust — consume the shared
  classifier (already wired); behavior changes via classification, not a parallel
  dirty model.
- Optional: design-gate / harness prompt or write path so new dumps land under
  `.agent-pipeline/` (gitignored) rather than untracked product-adjacent `artifacts/`.
- Tests: `core/test/` classifier and testgate/format-gate regressions.
- Generated `plugin/` mirror if `core/` changes.
- Living specs: `test-gate-non-product-dirty`, `test-build-gate` (deltas in this change).
