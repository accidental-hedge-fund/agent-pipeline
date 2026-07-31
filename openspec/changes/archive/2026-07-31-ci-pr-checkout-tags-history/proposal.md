## Why

The `docs:check`-class failure that wedged #597 / PR #711 (and motivated #716) is environmental, not a missing pre-PR gate: GitHub Actions' default PR checkout is shallow and tagless while local agent checkouts have full history and tags, so tag-dependent docs-generator output (notably `CHANGELOG.md`) diverges and the same `npm run ci` / `docs:check` command passes locally and fails in Actions. #716 (gate docs freshness before PR open) does not fix that parity gap; the 2026-07-31 reliability audit confirmed local full-CI green on the same head that Actions failed with `stale generated docs: CHANGELOG.md`. Related drift: CLAUDE.md / AGENTS.md / README describe a conditional docs-freshness step in `npm run ci`, but on main the root `ci` chain has no docs step at all.

## What Changes

- Make the **PR/main CI checkout** fetch the git inputs tag-dependent generators need: full history and tags (`fetch-depth: 0`, and explicit tag fetch when the checkout action requires it), matching the release workflows' established pattern — **not** by making CHANGELOG generation invent content without tags.
- Reconcile **root `ci` chain ↔ project docs** about docs freshness: wire a real, conditional docs-freshness step into `npm run ci` that is a no-op when the generator is absent (same class as `ci:openspec`), and keep CLAUDE.md / AGENTS.md / README accurate; when the generator is present, the step must be a real check-mode invocation.
- Add a **regression** that locks CI checkout depth/tags configuration and/or proves docs-generator check verdict identity for the same SHA under full-history+tags (the CI shape) vs a shallow/tagless environment that would otherwise diverge.
- Document the chosen approach (full CI checkout as the environment contract for tag-sourced generators) so operators do not reintroduce default shallow checkout for this gate.
- Does **not** implement or re-land #597's generator; does **not** weaken review rigor or add auto-merge; does **not** replace the #716 pre-PR docs-freshness engine path.

## Capabilities

### New Capabilities

- `ci-checkout-generator-parity`: PR and main CI workflow checkout fetches full history and tags so tag-dependent (and history-dependent) generators see the same git inputs as a normal local clone; regression guards against regressing to default shallow/tagless checkout; documents that this is the supported contract for generators that read git tags.

### Modified Capabilities

- `test-gate-ci-parity`: Align the full-CI-surface contract so root `npm run ci` always includes a conditional docs-freshness step (no-op when generator absent; real check-mode when present), and project build guidance stays consistent with that wiring — closing the CLAUDE.md-vs-`package.json` drift called out on #756.

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` checkout for the PR/main gate fetches full history and tags (`fetch-depth: 0` and any additional `actions/checkout` tag-fetch input required so `git tag -l 'v*'` is non-empty when tags exist on the remote) — not the action default shallow/tagless checkout.
- [ ] On a head that includes a tag-dependent docs generator (e.g. #597 / PR #711), `npm run docs:check` / the `ci` docs step produces the **same pass/fail verdict** in Actions as a full local checkout of that SHA (including when `CHANGELOG.md` is green locally).
- [ ] Root `package.json` `ci` chain includes a docs-freshness step that is **conditional**: exits 0 without requiring the generator when `scripts/generate-docs.mjs` (and generator-wired `docs:check`) are absent; when the generator is present, reaches a real check-mode invocation (`docs:check` / `generate-docs.mjs --check`).
- [ ] CLAUDE.md, AGENTS.md, and README build/test guidance agree with the actual `ci` chain about docs freshness (no claim of a step that is not wired; no silent omission of a wired step).
- [ ] A structural regression fails if CI checkout is reverted to default shallow/tagless (or if the conditional docs step is dropped from `ci` while the generator remains / the conditional entry point is removed).
- [ ] Re-advancing #597 / PR #711 after this lands either clears the CI gate or parks for a **different, real** failure — not the shallow/tagless `CHANGELOG.md` stale-class divergence.
- [ ] `openspec validate` for this change and `npm run ci` pass; any `core/` edits (if needed for the conditional step/tests) regenerate `plugin/` via `node scripts/build.mjs` in the same change.

## Impact

- `.github/workflows/ci.yml` — checkout `with:` (history + tags); comment documenting why (parity with local / release workflows / tag-sourced CHANGELOG).
- Root `package.json` — conditional docs step on the `ci` chain (and possibly `docs:check` / thin wrapper scripts), aligning with `test-gate-ci-parity` and docs-freshness presence rules.
- Possibly a small `scripts/` helper for conditional docs check (mirroring `ci-openspec.mjs` pattern) and scripts/unit tests for wiring + checkout config.
- CLAUDE.md / AGENTS.md / README — docs freshness wording matches reality.
- Living specs: new `ci-checkout-generator-parity`; delta on `test-gate-ci-parity`.
- Unblocks environmental root cause of #597 parking; does not itself merge #711 or change generator product design (tags remain the CHANGELOG source of truth).
