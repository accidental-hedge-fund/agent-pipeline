## Why

Issue #214 made the `semver` roadmap model populate `plan.json.milestones[]` by slicing the
ranked, unblocked backlog into fixed groups of five (`SEMVER_LANE_SIZE = 5`) and incrementing
the minor version by one per lane (`buildSemverLanes` in `core/scripts/roadmap/index.ts`). That
was a useful first milestone-grouping contract, but issue count is the wrong release boundary:
one issue can be a breaking architectural change while five issues can be trivial typo fixes.
The current model therefore produces misleading version lanes — it can split a coherent batch of
tiny maintenance issues into two "releases" while bundling a major breaking change with four
unrelated features under a single minor bump.

Maintainers and Pipeline Desk operators consume these generated milestones as the live release
plan. They need the engine to group work by **release substance** — compatibility impact,
delivery capacity (effort), risk, dependency order, and theme cohesion — and to choose the
semver increment (patch / minor / major) from the actual compatibility impact of the issues in
each milestone, not from a counter.

This change keeps the `semver` model's invariants (valid semver titles, each issue in exactly
one milestone, dependency-safe ordering) and replaces the fixed-count cap with capacity-aware
grouping. It does **not** introduce the deferred train/cadence model (#212) and does **not**
change the `continuous` model.

## What Changes

- The `semver` milestone builder stops using a fixed issue-count cap. Milestone boundaries are
  determined by an **effort-weighted capacity budget** plus risk/breaking isolation rules, so:
  - a single large, risky, or breaking-change issue can occupy its own milestone, and
  - more than five small, low-risk, cohesive issues can share one milestone.
- The semver **version increment between milestones reflects compatibility impact**: a milestone
  whose highest-impact issue is breaking bumps the **major** version; a backward-compatible
  feature milestone bumps **minor**; a maintenance-only milestone bumps **patch**. Compatibility
  impact is inferred from issue signals already available to the engine (labels such as
  `breaking-change` / `semver:*`, the `breaking change` / `migration` text heuristic, tier, and
  effort/risk).
- Each generated milestone carries a **product-term rationale** explaining its release boundary
  (compatibility impact, theme cohesion, risk/capacity, or dependency).
- Grouping **preserves dependency order**: for every `must_precede` edge A→B, A's milestone index
  is ≤ B's milestone index — the plan never requires a dependent to ship before its prerequisite.
- When issue metadata is too sparse to infer release impact confidently, the engine applies a
  **conservative default** (treat as a backward-compatible `minor`, never silently a `patch` or a
  `major`) and **records the uncertainty** so a human can promote the boundary rather than
  trusting an equal-weight guess.
- A new optional, strict-validated `roadmap.release_capacity` config block exposes the
  capacity policy (effort budget, breaking-change isolation) for operators who need to tune it;
  defaults keep the engine capacity-aware out of the box. `pipeline config schema` and the
  user-facing docs describe the release-capacity signals and this block.
- The `continuous` model is untouched — it stays theme/epic-oriented and is **not** subjected to
  semver capacity rules.

## Acceptance Criteria

- [ ] When `roadmap.release_model` is `semver` (or absent), generated milestone boundaries are
      not determined by a fixed issue-count cap (`SEMVER_LANE_SIZE` is removed as the boundary
      driver).
- [ ] The generated plan can place one large, risky, or breaking-change issue in its own
      milestone when that work dominates release capacity.
- [ ] The generated plan can group more than five small, low-risk, cohesive issues into one
      milestone when they fit one release's capacity.
- [ ] For every `must_precede` edge A→B, A's milestone index is ≤ B's milestone index — no
      milestone requires a dependent to ship before its prerequisite.
- [ ] Semver milestone version increments reflect compatibility impact where signals exist:
      maintenance-only → patch bump, backward-compatible feature → minor bump, breaking → major
      bump; consecutive milestone titles remain monotonically increasing valid semver.
- [ ] Each `plan.json.milestones[]` entry includes a non-empty `rationale` that names the
      release-boundary reason in product terms (compatibility impact, theme cohesion,
      risk/capacity, or dependency).
- [ ] When an issue's metadata is too sparse to infer compatibility impact, the engine assigns
      the conservative default (`minor`, never silently `patch`/`major`) and records the
      uncertainty in `plan.json` (per-milestone and/or `open_questions[]`).
- [ ] Under `roadmap.release_model: continuous`, milestones remain theme/epic groupings with no
      semver titles — the capacity rules do not run.
- [ ] `roadmap.release_capacity` is an optional, strict-validated config block; an unknown
      sub-key is rejected; an absent block resolves to capacity-aware defaults; `pipeline config
      schema` exposes the block with descriptions and the README documents it.
- [ ] Unit tests cover: a single large/breaking issue isolated into its own milestone; more than
      five small issues grouped into one milestone; dependency-constrained grouping order;
      compatibility-impact version selection (patch/minor/major); and the sparse-metadata
      conservative fallback with recorded uncertainty.

## Capabilities

### Modified Capabilities

- `roadmap-release-model`: The `semver` milestone behavior is no longer fixed-count. Milestone
  boundaries are capacity- and compatibility-aware; version increments reflect compatibility
  impact; each milestone records a product-term rationale; dependency order is preserved; sparse
  metadata produces a conservative, uncertainty-recorded default. The `continuous` model is
  explicitly unchanged.
- `pipeline-configuration`: `PartialConfigSchema`'s `roadmap:` block gains an optional, strict
  `release_capacity` sub-block (`effort_budget`, `isolate_breaking`); absent → capacity-aware
  defaults.
- `config-schema-command`: `pipeline config schema` exposes the `roadmap.release_capacity` block
  with descriptions.

## Impact

- `core/scripts/roadmap/index.ts` — `buildSemverLanes` replaced by capacity-aware grouping;
  `SEMVER_LANE_SIZE` removed as the boundary driver; new compatibility-impact and effort-capacity
  helpers.
- `core/scripts/roadmap/types.ts` — `MilestoneSpec` gains an optional `version_impact`
  (`major` | `minor` | `patch`) and an optional `uncertainty` marker; `RoadmapConfig` gains
  `release_capacity`.
- `core/scripts/config.ts` — `PartialConfigSchema` `roadmap:` sub-key gains optional strict
  `release_capacity` with `.describe()` annotations.
- `core/test/` — new unit tests for capacity grouping, breaking isolation, dependency order,
  compatibility-impact versioning, sparse-metadata fallback, and config validation.
- `README` / user docs — describe release-capacity signals and the `release_capacity` policy.
- `plugin/` mirror — regenerated after the `core/` changes.
