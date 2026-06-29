## Context

`buildSemverLanes(roadmap, latestTag)` in `core/scripts/roadmap/index.ts` currently:

1. filters the ranked roadmap to `blocked_by.length === 0`,
2. slices that list into groups of `SEMVER_LANE_SIZE = 5`,
3. titles each slice `v{major}.{minor+k}.0` (minor bump per lane, patch always `0`).

The ranked `roadmap[]` it consumes is already **topologically sorted** — the engine guarantees
"Dependent ordering preserved after scoring" (A before B when B `must_precede`-depends on A) — and
each `RoadmapEntry` already carries the signals this change needs: `effort` (`XS|S|M|L|XL`),
`risks: string[]`, `score_breakdown` (`impact`, `risk_reduction`, …), `tier`, `unblocks[]`, and
`blocked_by[]`. The score module already detects compatibility-relevant text
(`/breaking.change|backwards.compat|migration/`) and reads labels for impact. So the inputs for
capacity- and compatibility-aware grouping are present; only the grouping/titling logic changes.

`roadmap-release-model` is defined by the in-flight `roadmap-release-model-config` change (#214),
which is **not yet archived** into `openspec/specs/`. This change's `MODIFIED` delta therefore
targets a requirement that becomes a living spec only after #214 archives.

## Goals / Non-Goals

**Goals:**
- Replace the fixed issue-count cap with capacity-aware milestone boundaries (effort budget + risk/breaking isolation).
- Choose the semver increment (patch/minor/major) per milestone from compatibility impact.
- Preserve dependency-safe ordering across milestone boundaries.
- Record uncertainty when metadata is too sparse to infer impact confidently.
- Keep the `continuous` model and the `pipeline release` refusal gate unchanged.

**Non-Goals:**
- Train / cadence release model (deferred in #212).
- Replacing the scoring/ranking/tiering algorithm (capacity grouping consumes its output unchanged).
- Pipeline Desk UI for editing roadmap policy (Desk consumes the engine plan).
- Date scheduling, velocity forecasting, or staff-capacity planning.
- Auto-merge, auto-release, tagging, publishing, or deployment behavior.

## Decisions

### Decision 1: Capacity = effort-weighted budget, not issue count

Map `EffortSize` → effort points: `XS=1, S=2, M=3, L=5, XL=8`. A milestone accumulates issues
(in ranked, dependency-safe order) until adding the next issue would exceed an **effort budget**
(`roadmap.release_capacity.effort_budget`, default `8`). This makes the boundary a function of
*delivery substance*, not count: an `XL` issue (8 pts) fills a milestone alone, while up to eight
`XS` issues (1 pt each) share one — directly satisfying "one big issue alone" and ">5 small issues
together". The exact point values are internal and asserted only through behavioral scenarios
(single-large isolation, many-small grouping), not pinned in the spec, so they can be tuned
without a spec change.

### Decision 2: Breaking / oversized issues are isolated into their own milestone

An issue is isolated (closes the current milestone, ships alone, opens the next) when it is
**breaking** (major compatibility impact — see Decision 3) or **oversized** (its own effort ≥ the
budget, i.e. `L`/`XL`). Isolation is gated by `roadmap.release_capacity.isolate_breaking`
(default `true`); oversized isolation is structural (an issue larger than the budget cannot share
a milestone without violating the budget regardless of the flag). This keeps a high-risk or
architectural change reviewable on its own and prevents it from silently dominating a mixed
release.

### Decision 3: Compatibility impact drives the version increment, inferred from existing signals

Per issue, classify compatibility impact as `major | minor | patch`:

- **major (breaking)** — a `breaking-change`/`semver:major`/`breaking` label, or the existing
  `breaking change` / `backwards incompat` / `migration` text heuristic.
- **patch (maintenance)** — a maintenance signal: `bug`/`chore`/`maintenance`/`semver:patch`
  label, or `cleanup`/`refactor`/`docs` text/tier with no feature signal.
- **minor (backward-compatible feature)** — any other confidently-classified issue
  (`feature`/`enhancement`/`semver:minor`).

A milestone's impact is the **max** over its issues (`major > minor > patch`). The version walks
forward from the latest released tag `[M, N, P]`: a `major` milestone → `v{M+1}.0.0`, a `minor`
milestone → `v{M}.{N+1}.0`, a `patch` milestone → `v{M}.{N}.{P+1}`. Titles stay valid semver and
monotonically increasing. This replaces the old "always minor bump" behavior and satisfies
"maintenance-only can be patch, feature minor, breaking major".

`MilestoneSpec` gains an optional `version_impact: 'major' | 'minor' | 'patch'` so the chosen
increment is machine-readable for Pipeline Desk (which consumes, not recomputes, the plan).

### Decision 4: Sparse metadata → conservative `minor` default + recorded uncertainty

When an issue carries no impact-bearing label and no impact-bearing text (e.g. confidence ≤ a low
threshold, or no signal matched), the engine does **not** treat it as equal to a classified issue.
It assigns the conservative default impact `minor` (never silently `patch`, which would
under-state a possible feature/break, and never silently `major`, which would inflate versions)
and flags the milestone/issue as uncertain. The uncertainty is recorded in `plan.json` — on the
milestone (e.g. an `uncertainty` note in the milestone record) and/or in `open_questions[]` — so a
human can promote a `minor` boundary to `major` when warranted. This makes the fallback auditable
rather than a silent equal-weight guess.

### Decision 5: Dependency order preserved by forward-scan over the already-sorted roadmap

Because grouping is a single forward scan over the topologically-sorted `roadmap[]`, a prerequisite
always lands in an earlier-or-same milestone than its dependent; isolation only *closes* the
current milestone at the scan position, never reorders. The spec asserts the invariant directly:
for every `must_precede` edge A→B, `milestoneIndex(A) ≤ milestoneIndex(B)`. Issues blocked by an
unresolved/external decision (`dependency_graph.blocked_pending_decision`) remain excluded from
version lanes, preserving the original behavior for genuinely-blocked work; in-plan dependencies
are honored by ordering rather than exclusion.

### Decision 6: Config is optional and tunes the model, not a raw count

`roadmap.release_capacity` is optional and strict-validated:

```yaml
roadmap:
  release_capacity:
    effort_budget: 8        # effort points per milestone (default 8)
    isolate_breaking: true  # give a breaking-change issue its own milestone (default true)
```

Absent → capacity-aware defaults (the engine is capacity-aware with zero config). This is
deliberately **not** a re-skin of the old issue-count cap as a tunable number (explicitly out of
scope for #347): the default behavior already groups by effort and compatibility impact; the block
only tunes the capacity model. `pipeline config schema` renders the block from the Zod
`.describe()` annotations, and the README documents the signals — satisfying the docs/schema AC.

## Risks / Trade-offs

- **Archive ordering** — the `MODIFIED` delta matches a requirement introduced by the unarchived
  #214 change. If this change archives first, the archiver will not find the target requirement.
  Mitigation: #214 (`roadmap-release-model-config`) is marked Complete and ships first in the
  normal flow; sequence this change after it.
- **Effort heuristic is coarse** — `estimateEffort` is a text heuristic, so capacity is
  approximate. Acceptable: the goal is *release-meaningful* boundaries, not precise estimation;
  operators can tune `effort_budget`, and sparse cases are recorded as uncertain.
- **Compatibility-impact false positives** — the `migration`/`breaking` heuristic can over-classify.
  Acceptable: over-classifying to `major` is the safe direction for consumers, and a human reviews
  the plan before applying it; recorded uncertainty makes the boundary auditable.

## Migration

No config migration required: an absent `release_capacity` block resolves to capacity-aware
defaults, and existing `roadmap.release_model: semver` repos transparently get capacity-aware
milestones on the next `pipeline roadmap` run. `continuous` repos are unaffected.
