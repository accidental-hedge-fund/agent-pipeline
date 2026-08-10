## Context

See proposal.md for motivation.

Today `classifyCompatibilityImpact` in `core/scripts/roadmap/index.ts` mixes:

1. Legacy labels (`breaking-change`, `breaking`, `semver:major`)
2. Title/body regex for `breaking change` / `migration` → hard major
3. Explicit `semver:minor` / `semver:patch`
4. Generic type labels (`bug`, `enhancement`, …)
5. Sparse default → applied `minor` with `uncertain: true`

Milestones only store aggregate `version_impact` and optional `uncertainty`. Continuous
mode uses theme/epic grouping and must stay out of this path.

Living `roadmap-release-model` still requires every rankable issue in exactly one
milestone lane. That conflicts with “conflicting / missing explicit SemVer → no
automatic milestone assignment,” so the lane membership rule must change with this
design.

## Goals / Non-Goals

**Goals:**

- Single applied authority: exactly one of `semver:major` | `semver:minor` |
  `semver:patch`.
- Stable applied class under title/body-only edits when labels are unchanged.
- Visible unresolved outcomes (missing or conflicting labels) without inventing
  impact.
- Per-issue provenance in `plan.json`, Markdown, and apply preview.
- Preserve continuous mode and capacity/isolation mechanics for **resolved**
  SemVer issues.

**Non-Goals:**

- Choosing the “correct” impact for humans when metadata is missing or conflicting.
- Full GitHub milestone reconciliation (#910).
- Renumbering shipped releases or changing continuous CalVer markers.
- Changing risk/score text heuristics in `score.ts` (those are not SemVer class).

## Decisions

### Decision 1: Applied impact is label-only and exclusive

**Choice:** Applied classification uses only the three labels
`semver:major`, `semver:minor`, `semver:patch` (case-insensitive match on label
name). Exactly one distinct class present → applied impact resolved. Zero →
`unresolved_missing`. Two or more distinct classes among those three →
`unresolved_conflict`.

**Rationale:** Matches the issue’s authority list and mutual-exclusion rule.
Removes prose as a silent major source.

**Alternatives considered:**

- Keep `breaking-change` as applied major → rejected; not in the authoritative
  set; would still conflate type/signal labels with SemVer class.
- Infer applied impact from prose when labels missing → rejected; root cause of
  the bug.
- Prefer one label when conflicting (e.g. highest wins) → rejected; issue requires
  visible unresolved failure, not silent resolution.

### Decision 2: Remove title/body from applied and recommended SemVer class

**Choice:** Classification MUST NOT scan title or body for SemVer class words.
Prose remains free-form documentation only.

**Rationale:** “A body or title edit cannot change compatibility impact while
structured impact metadata is unchanged.”

**Note:** Other roadmap signals (risk phrases in `score.ts`, depgraph prompts)
may still mention migration language; they do not set SemVer class.

### Decision 3: Recommendations are non-authoritative

**Choice:** When applied status is `unresolved_missing`, the engine MAY emit a
**recommendation** derived only from generic type labels:

- Feature-class labels (`feature`, `enhancement`, `feat`) → recommend `minor`
- Maintenance-class labels (`bug`, `bugfix`, `chore`, `maintenance`, `refactor`,
  `documentation`, `docs`) → recommend `patch`
- Optional non-authoritative major signal: `breaking-change` / `breaking` →
  recommend `major` (recommendation only)

Recommendations never set `version_impact`, never place an issue into a SemVer
lane by themselves, and never override a resolved explicit label.

**Rationale:** Preserves operator guidance without false precision in the applied
plan.

### Decision 4: Unresolved issues are excluded from automatic SemVer milestone assignment

**Choice:** Under `semver`, only issues with **resolved** applied classification
enter `plan.json.milestones[]` / apply assignment. Missing or conflicting issues:

- Are omitted from automatic milestone `issue_numbers[]`
- Are listed in a dedicated classification record (and surfaced in Markdown /
  apply preview and preferably `open_questions[]`)
- Do not drive version increments

Ranked roadmap order and dependency graph computation remain; only SemVer lane
membership and apply assignment are gated.

**Rationale:** Directly implements “no automatic milestone assignment” for
conflicts and keeps missing impact from inventing a release lane.

**Living-spec implication:** MODIFY the “each issue in exactly one lane” rule so
it applies to **resolved** issues (or “issues eligible for SemVer assignment”),
not every rankable backlog issue.

### Decision 5: Per-issue classification record in the plan

**Choice:** Add a first-class per-issue list on `plan.json` (name in
implementation may be `compatibility_classifications` or equivalent) with at
least:

| Field | Meaning |
| --- | --- |
| `issue_number` | Issue id |
| `status` | `resolved` \| `unresolved_missing` \| `unresolved_conflict` |
| `applied_impact` | `major` \| `minor` \| `patch` \| `null` when unresolved |
| `source_label` | The winning `semver:*` label when resolved; else `null` |
| `uncertain` | `true` when status is not `resolved` |
| `recommendation` | Optional `{ impact, source }` when a type-label hint exists |
| `conflict_labels` | Present when status is `unresolved_conflict` |

Milestone-level `version_impact` remains the max applied impact among issues
**in that milestone only**. Milestone `uncertainty` may summarize excluded or
sparse cases but must not invent applied impact.

Markdown writeback and dry-run / apply preview MUST show the same fields (or an
equivalent human-readable line per issue: impact, source, uncertainty/status).

### Decision 6: Version walk and capacity rules use only resolved issues

**Choice:** `buildSemverLanes` (or successor) consumes only resolved-impact
issues for capacity packing, breaking isolation (`applied_impact === major` +
`isolate_breaking`), and semver title increments. Continuous mode never calls
this path for impact.

**Rationale:** Unresolved issues must not inflate majors or isolate as breaking
via prose/heuristics.

### Decision 7: Docs and mirror

**Choice:** After core behavior changes, regenerate `plugin/` via
`node scripts/build.mjs` and refresh any generated or hand docs that still claim
body-keyword majors. Full `npm run ci` is the done gate.

## Risks / Trade-offs

- **[Risk] Many open issues lack `semver:*` labels → large exclusion from lanes**  
  → Mitigation: recommendations + visible unresolved lists guide labeling; this
  is intentional honesty over false majors. Operators can label and re-run
  roadmap.

- **[Risk] Existing tests and archive narrative encode prose→major**  
  → Mitigation: invert those unit tests; add explicit regressions listed in the
  proposal acceptance criteria.

- **[Risk] Operators still use only `breaking-change` without `semver:major`**  
  → Mitigation: recommendation records major; applied plan stays unresolved until
  they add `semver:major`. Document in operator-facing roadmap notes.

- **[Trade-off] Stricter plan vs. denser auto-milestones**  
  Prefer correctness and auditability of release class over packing every issue
  into a version lane without metadata.

## Migration Plan

1. Ship classifier + plan schema fields + surfaces + tests.
2. No data migration: next `pipeline roadmap` run reclassifies from live labels.
3. Operators add `semver:*` labels where release class is known; re-run roadmap
   (apply remains separate; full reconciliation remains #910).
4. Rollback: revert the change; prior heuristic behavior returns (undesirable but
   simple).

## Open Questions

None that block specs or tasks. Field naming for the per-issue list is an
implementation detail as long as the required provenance is present and
testable.
