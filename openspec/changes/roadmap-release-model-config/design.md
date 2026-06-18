## Context

The roadmap engine (phase 5) writes `plan.json.milestones[]` today but returns it hardcoded as `[]`. The `createMilestone`, `getMilestones`, and `applyLabel` seams exist in the codebase but are unused for milestone creation. `.github/pipeline.yml` already has a `roadmap:` config block (strict-validated) but no `release_model` key. `pipeline release` operates semver-only with no guard for repos that ship continuously.

## Goals / Non-Goals

**Goals:**
- Populate `milestones[]` from the ranked backlog per a `release_model` config setting
- Validate `release_model` strictly at config-load time; invalid values fail fast with a clear error
- Implement a `continuous` model that groups issues by theme/epic rather than version lane
- Guard `pipeline release` against running on repos configured for continuous delivery

**Non-Goals:**
- Train / cadence-based release model (tracked separately in #212)
- Modifying the scoring, ranking, or tiering algorithm
- Auto-merge, tagging, publishing, or deploying releases
- Wiring the continuous version marker into CI/CD pipelines
- Migrating repos between release models automatically

## Decisions

### Decision 1: `semver` as the default when `release_model` is absent

All existing repos work today with `pipeline release`; defaulting to `semver` means no config migration. An absent key produces behavior identical to `release_model: semver`.

### Decision 2: Semver lane boundaries are internal to the engine

The spec guarantees correctness properties (each issue in exactly one lane, semver titles) without prescribing the exact lane-size algorithm. The implementation picks a sensible default (e.g., bundle by ranked order across the next N version slots based on tier sizes). A future `roadmap.lane_size` config key can expose this if needed, but it is out of scope for this change.

### Decision 3: Continuous grouping key — `epic:*`/`theme:*` label prefix with tier fallback

**Alternative A**: Re-use existing roadmap tier (5 fixed groups, always available but generic)  
**Alternative B**: `epic:*` / `theme:*` label prefix — semantically meaningful, maintainer-controlled  
**Decision**: `epic:*` / `theme:*` label prefix as the primary grouping key; fall back to the roadmap tier name for issues without such a label. This lets maintainers adopt label-based grouping progressively without breaking repos that don't use the convention yet.

### Decision 4: Per-deploy version marker format — CalVer `YYYY.0M.MICRO`

**Alternative A**: CalVer `YYYY.0M.MICRO` — human-readable, self-contained, no external dependency  
**Alternative B**: Git SHA prefix — unambiguous but opaque  
**Alternative C**: CI build ID — requires CI wiring, explicitly out of scope  
**Decision**: CalVer `YYYY.0M.MICRO` where MICRO is a zero-based run index within the calendar month. Readable, sortable, no external system dependency.

### Decision 5: Release refusal gate lives in the release sub-command handler

The guard is `pipeline release`-specific, not a global constraint. `resolveConfig()` loads config; the release handler checks applicability. Avoids cross-command coupling in the config layer.

## Risks / Trade-offs

- [Risk] Repos with no `epic:*`/`theme:*` labels fall back to tier grouping — 5 generic milestone buckets that may not map to meaningful shipping units. → Mitigation: document the label convention; the tier fallback is functional even if less semantic. A future change can require explicit epic labels.
- [Risk] The lane-size algorithm is implementation-defined. Very small backlogs (1–2 issues) may produce thin version lanes. → Mitigation: the spec guarantees unique assignment and semver titles; odd-sized lanes are acceptable and don't violate correctness.
- [Risk] CalVer MICRO counter requires tracking prior runs within a month. → Mitigation: derive from the count of existing plan output files this month, or start at 0 if none. Simplest viable default.

## Open Questions

1. **Lane size config** — Should `roadmap.lane_size` be a user-facing key in this change or deferred? This spec does not require it; the implementation uses an internal default.
2. **Continuous marker format** — The CalVer decision above resolves the open question raised in issue #214. If the team prefers build IDs, only the `roadmap-release-model` spec Requirement 4 needs updating before implementation begins.
