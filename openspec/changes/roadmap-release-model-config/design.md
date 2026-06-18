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

### Decision 4: Per-deploy version marker format — lock-free CalVer `YYYY.0M.<short backlog-sha>`

**Alternative A**: CalVer `YYYY.0M.MICRO` (a zero-based run-index counter) — readable, but the counter is a read-modify-write of prior plan output, which requires serializing concurrent runs with a lock. Six review rounds showed that lock (and its stale-reclaim) cannot be made cleanly race-free with POSIX file primitives — all to protect a cosmetic marker.  
**Alternative B**: Git SHA prefix — unambiguous but opaque  
**Alternative C**: CI build ID — requires CI wiring, explicitly out of scope  
**Decision**: CalVer `YYYY.0M.<short>` where `<short>` is a short prefix of the **backlog SHA** the roadmap was generated against. The marker is a **pure function of the month + backlog SHA** — no read-modify-write counter — so it needs **no lock**: concurrent runs on the same backlog deterministically produce the same correct marker, and runs on different backlogs produce different markers. (`plan.json` is additionally written atomically via temp+rename so concurrent writes can't clobber.) This eliminates the entire lock/stale-reclaim/TOCTOU/crash-stranding class.

### Decision 5: Release refusal gate lives in the release sub-command handler

The guard is `pipeline release`-specific, not a global constraint. `resolveConfig()` loads config; the release handler checks applicability. Avoids cross-command coupling in the config layer.

## Risks / Trade-offs

- [Risk] Repos with no `epic:*`/`theme:*` labels fall back to tier grouping — 5 generic milestone buckets that may not map to meaningful shipping units. → Mitigation: document the label convention; the tier fallback is functional even if less semantic. A future change can require explicit epic labels.
- [Risk] The lane-size algorithm is implementation-defined. Very small backlogs (1–2 issues) may produce thin version lanes. → Mitigation: the spec guarantees unique assignment and semver titles; odd-sized lanes are acceptable and don't violate correctness.
- [Risk] A naive monotonic marker counter would need a read-modify-write of prior plan output, forcing a lock that cannot be made cleanly race-free. → Mitigation (adopted): the marker is content-addressed and deterministic (month + backlog SHA), so no counter and no lock are needed; concurrent runs are inherently safe and `plan.json` writes are atomic (temp+rename).

## Open Questions

1. **Lane size config** — Should `roadmap.lane_size` be a user-facing key in this change or deferred? This spec does not require it; the implementation uses an internal default.
2. **Continuous marker format** — Resolved (issue #214's open question): a lock-free, content-addressed CalVer `YYYY.0M.<short backlog-sha>` (see Decision 4). If the team later prefers build IDs, only the `roadmap-release-model` spec Requirement 4 + Decision 4 need updating.
