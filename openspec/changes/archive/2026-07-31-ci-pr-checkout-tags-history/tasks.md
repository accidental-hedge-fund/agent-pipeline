## 1. Inventory and external shapes

- [x] 1.1 Confirm current `.github/workflows/ci.yml` checkout (bare `actions/checkout@v4`) and compare with `release.yml` / `auto-tag-release.yml` (`fetch-depth: 0`)
- [x] 1.2 Verify `actions/checkout@v4` input names (`fetch-depth`, `fetch-tags`) against the pinned action docs — do not invent `tags: true`
- [x] 1.3 Confirm root `package.json` `ci` chain has no docs step; CLAUDE.md / AGENTS.md / README claim conditional docs freshness; generator absent on main
- [x] 1.4 Optionally reproduce on PR #711: shallow/tagless vs full clone docs:check divergence for `CHANGELOG.md` (document evidence; no need to land generator here)

## 2. CI checkout contract (`ci-checkout-generator-parity`)

- [x] 2.1 Update `.github/workflows/ci.yml` checkout with `fetch-depth: 0` and tag availability (`fetch-tags: true` or verified equivalent)
- [x] 2.2 Add a short workflow comment that full history + tags are required for tag-dependent generator / local CI parity
- [x] 2.3 Confirm release/auto-tag workflows still use full-history checkout (no accidental weaken)

## 3. Conditional docs step on `ci` (`test-gate-ci-parity`)

- [x] 3.1 Add a conditional docs entry point (e.g. `scripts/ci-docs.mjs` + `ci:docs`) that no-ops when generator-absent and runs check-mode when generator-present (reuse #716 detection rules / prefer shared helper if low-cost)
- [x] 3.2 Wire the entry point into root `package.json` `ci` (position after mirror check or documented equivalent; consistent with existing chain)
- [x] 3.3 Ensure write-mode-only `docs:check` is not treated as sufficient check-mode when the generator file exists

## 4. Regression tests

- [x] 4.1 Structural test: parse `ci.yml` and fail if full-gate checkout lacks `fetch-depth: 0` (and required tag-fetch config if specified)
- [x] 4.2 Structural test: `ci` always reaches the conditional docs entry; fail if dropped
- [x] 4.3 Behavior tests for the docs entry: generator absent → exit 0; generator present (fixture) → invokes check-mode; stale check fails the step
- [x] 4.4 Prove tests bite: removing checkout depth or docs entry from fixtures fails the corresponding test

## 5. Documentation alignment

- [x] 5.1 Update CLAUDE.md / AGENTS.md build guidance: conditional docs step on `ci`; note Actions full history + tags for generator parity
- [x] 5.2 Update README `npm run ci` / CI guidance consistently (conditional docs + checkout contract)
- [x] 5.3 Ensure docs do not claim unconditional hard `docs:check` on generator-absent trees or shallow-checkout sufficiency for tag-sourced generators

## 6. Packaging and verification

- [x] 6.1 If any `core/` files change, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit — never hand-edit `plugin/`
- [x] 6.2 Run `openspec validate ci-pr-checkout-tags-history` (and `openspec validate --all` before done)
- [x] 6.3 From root: `npm run ci` green on generator-absent main-shaped tree (docs step no-op)
- [x] 6.4 After merge (or on a combined branch): re-advance / re-run CI for #597 / PR #711 — expect no shallow/tagless CHANGELOG-only failure; park only for a different real reason if any
- [x] 6.5 Confirm proposal acceptance-criteria checkboxes are falsifiable against the landed behavior
