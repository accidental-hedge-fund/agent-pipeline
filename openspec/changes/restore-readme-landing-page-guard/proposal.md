## Why

#597 correctly split the operator front door: PR #790 landed a lean `README.md` (219 lines at `831e46d3`) with companions under `docs/`. PR #793 then regressed that invariant — implementation commit `d85f5dae` appended ~1,845 unrelated README lines during surgical restack/conflict resolution, producing a malformed monolith inside the Uninstall section. `origin/main` is now ~2,067 lines. The living `docs-landing-split` requirement (fewer than 400 lines, companion links, no full hand-maintained CLI inventory) has no executable guard: the docs freshness gate only checks generated artifacts (`docs/cli.md`, `docs/config.md`, `CHANGELOG.md`, SKILL command-table regions). Restack/repair accepted a large out-of-scope documentation delta without fail-closed enforcement or renewed scope review. This change restores the accepted landing-page contract and makes it mechanically unskippable.

## What Changes

- **Restore** root `README.md` to the #597 lean landing-page contract while **preserving legitimate post-#790 edits** (stage-count SSOT language from #626/#791, install/`CLAUDE_CONFIG_DIR` packaging notes from #635/#792, and any other intentional post-split README deltas that are not the #793 monolith append).
- **Extend the docs gate** so `docs:check` / `generate-docs.mjs --check` (and therefore `ci:docs` / the docs-freshness path) enforces the README landing-page contract: fewer than 400 lines; working relative links to `docs/cli.md`, `docs/config.md`, and `docs/concepts.md`; and no full hand-maintained CLI/config inventory in the README body.
- **Add a regression fixture** shaped like the #793 failure (lean README with a large monolithic append) so the gate fails before PR readiness / CI green.
- **Fail closed on restack / conflict repair / pre-merge repair** when the resulting head introduces a large unrelated documentation delta that violates the landing-page contract: the path SHALL NOT silently treat that head as ready-to-deploy eligible; it SHALL block or return the item to scoped repair/review with diagnostics naming the contract breach.
- **Docs/tooling/control only**: no change to pipeline stage machine semantics, merge authority, review-policy thresholds, or harness provider wiring.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `docs-landing-split`: Restore the lean README artifact on the integration branch; make the size, companion-link, and no-full-inventory contracts **executable** (enforced by the docs check surface and a #793-shaped regression fixture), not prose-only.
- `docs-freshness-gate`: Expand the docs freshness / `docs:check` surface beyond generator-owned artifacts so the README landing-page contract participates in the same pre-PR and CI fail-closed path as stale generated docs.
- `merge-queue-repair-hold`: Surgical restack / conflict-or-CI repair that lands a large unrelated documentation delta violating the landing-page contract SHALL fail closed (or leave a typed non-eligible hold with diagnostics) rather than re-gating as merge/ready success.
- `surgical-fix-rounds`: Pre-merge / fix-round repair discipline SHALL treat a large unrelated README (or equivalent landing-page) monolith restoration as out of surgical scope — fail closed or return to scoped review; do not silently advance that head as gate-passed.

## Acceptance criteria

- [ ] `README.md` on the change head is a lean landing page with **fewer than 400 lines**.
- [ ] `README.md` contains working relative links to `docs/cli.md`, `docs/config.md`, and `docs/concepts.md`.
- [ ] `README.md` does **not** re-embed a full hand-maintained CLI command inventory or full config key reference (those remain in the generated companions).
- [ ] Legitimate post-#790 README content that is not the #793 monolith append is preserved (at minimum stage-inventory accuracy and install packaging accuracy required by living specs).
- [ ] `npm run docs:check` / `node scripts/generate-docs.mjs --check` (or the docs-freshness check surface they feed) **fails** when README exceeds the line budget, is missing a required companion link, or matches the monolithic-inventory shape the guard targets.
- [ ] A regression fixture based on the #793 shape (lean README body + large unrelated monolithic append) fails the docs check; the test bites if the guard is removed.
- [ ] A restack, conflict repair, or pre-merge repair outcome that introduces such a large unrelated documentation delta **does not** silently reach ready-to-deploy / successful re-gate; it fails closed or returns to scoped review with a reason that names the documentation contract breach.
- [ ] No pipeline stage-machine, merge-authority, review-policy threshold, or provider-specific harness behavior changes; scope remains docs/tooling/control-plane.
- [ ] `npm run ci` is green after implementation (including `openspec validate --all` and `build.mjs --check` if core/plugin surfaces change).

## Impact

- **Docs artifact:** rewrite/restore root `README.md` (remove #793 monolith append; keep lean structure + legitimate post-split edits).
- **Tooling:** `scripts/generate-docs.mjs` and/or a dedicated README contract checker invoked from the docs check path; tests under `scripts/` and/or `core/test/` as appropriate.
- **Control plane (narrow):** merge-queue repair re-gate / surgical fix post-checks must observe docs-check (or equivalent README contract) failure and fail closed — without changing merge policy or review severity thresholds.
- **Specs:** deltas for `docs-landing-split`, `docs-freshness-gate`, `merge-queue-repair-hold`, `surgical-fix-rounds`.
- **Out of scope:** docs site publishing (#598); full documentation architecture rewrite beyond restoring #597's accepted layout; stage/review/merge product policy changes.
