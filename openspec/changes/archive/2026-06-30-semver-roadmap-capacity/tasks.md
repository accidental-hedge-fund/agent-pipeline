## 1. Compatibility-impact classification

- [ ] 1.1 Add a `classifyCompatibilityImpact(entry, item)` helper in the roadmap engine returning `'major' | 'minor' | 'patch'` plus an `uncertain: boolean` flag, inferring impact from labels (`breaking-change`/`semver:*`/`bug`/`chore`/`maintenance`), the existing `breaking change`/`migration` text heuristic, tier, effort, and risk
- [ ] 1.2 Implement the sparse-metadata path: when no impact-bearing label or text matches, return `{ impact: 'minor', uncertain: true }` (never silently `patch`/`major`)
- [ ] 1.3 Add unit tests: breaking label/text → `major`; maintenance signal → `patch`; feature signal → `minor`; sparse metadata → `minor` + `uncertain: true`

## 2. Effort-weighted capacity grouping

- [ ] 2.1 Add an `effortPoints(effort: EffortSize)` map (`XS=1, S=2, M=3, L=5, XL=8`) in the roadmap engine
- [ ] 2.2 Replace `buildSemverLanes`'s fixed `SEMVER_LANE_SIZE` slicing with a forward scan over the dependency-ordered `roadmap[]`: accumulate issues into a milestone until the next issue would exceed the effort budget, then start a new milestone (remove `SEMVER_LANE_SIZE` as the boundary driver)
- [ ] 2.3 Implement isolation: an issue is placed alone in its own milestone when it is breaking (and `isolate_breaking` is enabled) or oversized (effort points ≥ budget); isolation closes the current milestone and opens the next
- [ ] 2.4 Add unit tests: one `XL` issue isolated alone; a breaking issue isolated when `isolate_breaking` is on; seven `XS` low-risk issues grouped into one milestone (count > 5 not a boundary)

## 3. Compatibility-impact version walk

- [ ] 3.1 Compute each milestone's impact as the max over its issues (`major > minor > patch`)
- [ ] 3.2 Walk versions from the latest released tag: `major` → `v{M+1}.0.0`, `minor` → `v{M}.{N+1}.0`, `patch` → `v{M}.{N}.{P+1}`; ensure titles are valid semver and monotonically increasing
- [ ] 3.3 Set `MilestoneSpec.version_impact` to the chosen increment
- [ ] 3.4 Add unit tests: maintenance-only milestone → patch title + `version_impact: 'patch'`; feature milestone → minor; breaking milestone → major; monotonic-increase invariant across a mixed plan

## 4. Per-milestone rationale and uncertainty

- [ ] 4.1 Generate a product-term `rationale` per milestone naming the boundary reason (compatibility impact, theme cohesion, risk/capacity, or dependency) — not a bare "ranked issues N–M" restatement
- [ ] 4.2 Record sparse-metadata uncertainty in `plan.json` (a milestone `uncertainty` note and/or an `open_questions[]` entry)
- [ ] 4.3 Add unit tests: every milestone `rationale` is non-empty and references a product-term reason; sparse-metadata run records uncertainty

## 5. Dependency-order preservation

- [ ] 5.1 Confirm the forward-scan grouping preserves order; assert `milestoneIndex(A) ≤ milestoneIndex(B)` for every `must_precede` edge A→B where both are placed
- [ ] 5.2 Keep excluding issues blocked by an unresolved/external decision (`blocked_pending_decision`) from version milestones
- [ ] 5.3 Add unit test: a dependency-constrained backlog where B depends on A places A in an earlier-or-equal milestone; isolation does not reorder a prerequisite after its dependent

## 6. Types and config schema

- [ ] 6.1 Add optional `version_impact?: 'major' | 'minor' | 'patch'` and an optional `uncertainty` marker to `MilestoneSpec` in `core/scripts/roadmap/types.ts`
- [ ] 6.2 Add optional `release_capacity?: { effort_budget?: number; isolate_breaking?: boolean }` to `RoadmapConfig`
- [ ] 6.3 Add the strict `release_capacity` sub-block to the `roadmap:` schema in `config.ts` `PartialConfigSchema` with `.describe()` annotations (`effort_budget` positive number; `isolate_breaking` boolean)
- [ ] 6.4 Add unit tests: valid block resolves; absent block uses capacity-aware defaults; unknown sub-key rejected; non-positive `effort_budget` rejected

## 7. `continuous` model unaffected

- [ ] 7.1 Verify `buildContinuousGroups` and the dispatch path do not invoke the new semver capacity logic
- [ ] 7.2 Add/confirm unit test: a `continuous` run produces no semver titles and applies no capacity budget or breaking isolation

## 8. Docs

- [ ] 8.1 Update the README / user docs to describe the release-capacity signals (effort capacity, compatibility impact, breaking isolation) and the `roadmap.release_capacity` policy block
- [ ] 8.2 Confirm `pipeline config schema` output exposes `roadmap.release_capacity` with descriptions

## 9. CI gate and mirror

- [ ] 9.1 Run `node --test --experimental-strip-types test/*.test.ts` from `core/` and confirm all tests pass
- [ ] 9.2 Regenerate the `plugin/` mirror via `node scripts/build.mjs` and commit it with the `core/` changes
- [ ] 9.3 Run `npm run ci` from repo root and confirm green (core tests + mirror sync + install smoke + `openspec validate --all`)
