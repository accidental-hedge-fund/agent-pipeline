## Why

The SemVer roadmap classifier treats free-form title and body keywords such as
`breaking change` and `migration` as hard major-impact signals. Incidental prose
can therefore force a major release lane even when the issue does not change a
public contract. Maintainers need compatibility impact to come only from
explicit structured metadata so the release plan is auditable and stable under
doc-only edits.

## What Changes

- Compatibility impact for the applied SemVer release plan is classified **only**
  from the mutually exclusive labels `semver:major`, `semver:minor`, and
  `semver:patch`.
- Title and body text may still explain impact, but **MUST NOT** set or override
  the applied SemVer class (the body/title keyword heuristic is removed for
  applied classification).
- A conflicting set of explicit SemVer labels is unresolved: the conflict is
  recorded visibly, and the issue receives **no** automatic milestone
  assignment from that run.
- An issue with no explicit SemVer label is visibly uncertain for applied
  classification; it is not silently promoted to major (or any other class)
  because its prose mentions `migration`, `breaking`, or similar words.
- Generic type labels (`bug`, `enhancement`, and similar) may produce a
  **recommendation** only. They do not replace explicit impact for the applied
  release plan.
- Each issue’s classification records selected impact (or unresolved reason),
  source label (when present), and uncertainty in `plan.json`, the Markdown
  roadmap output, and the apply preview.
- Existing `continuous` release-model grouping remains unchanged and is not
  subjected to SemVer impact classification rules.

## Acceptance Criteria

- [ ] Under `release_model: semver` (or absent), only `semver:major`,
      `semver:minor`, and `semver:patch` set applied compatibility impact.
- [ ] The three explicit SemVer labels are mutually exclusive for applied
      classification; a conflicting set records a visible unresolved
      classification and excludes that issue from automatic milestone
      assignment.
- [ ] An issue with no explicit SemVer label remains visibly uncertain for
      applied impact; the plan does not assign major solely because title/body
      contain `migration`, `breaking change`, or similar prose.
- [ ] Generic type labels (`bug`, `enhancement`, and peers) may appear as
      recommendations but do not set applied impact without an explicit
      `semver:*` label.
- [ ] Classification records per issue include selected impact (or unresolved
      status), source label when applicable, and uncertainty, and those fields
      appear in `plan.json`, Markdown output, and apply preview.
- [ ] Changing only title/body text while structured SemVer labels stay the same
      does not change applied compatibility impact for that issue.
- [ ] Regression tests cover: incidental `migration` prose without a SemVer
      label does not produce major; explicit `semver:patch` stays patch despite
      breaking-language prose; explicit `semver:major` produces major; missing
      metadata remains unresolved; conflicting SemVer labels fail visibly.
- [ ] `release_model: continuous` grouping and titles remain theme/epic-oriented
      with no SemVer capacity/impact path applied.
- [ ] Generated documentation and the `plugin/` mirror stay current;
      `npm run ci` passes.

## Capabilities

### New Capabilities

- _(none)_

### Modified Capabilities

- `roadmap-release-model`: Replace prose- and mixed-heuristic SemVer impact
  classification with explicit `semver:*` label authority for the applied plan;
  define conflict and missing-label unresolved outcomes; require per-issue
  impact provenance (impact/source/uncertainty) in plan artifacts; keep
  continuous mode unaffected.

## Impact

- `core/scripts/roadmap/index.ts` — `classifyCompatibilityImpact` and
  `buildSemverLanes` (applied impact source of truth, exclusion of unresolved
  issues from auto milestone assignment, provenance emission).
- `core/scripts/roadmap/types.ts` — plan/milestone (and any new per-issue
  classification) fields for impact, source label, and uncertainty.
- `core/scripts/roadmap/writeback.ts` — Markdown and apply-preview surfaces show
  the recorded classification.
- `core/test/roadmap-capacity.test.ts` (and related roadmap tests) — invert
  prose-based major expectations; add conflict/missing/explicit-label
  regressions.
- Living OpenSpec `roadmap-release-model` requirements for impact classification
  and sparse-metadata defaults.
- Operator docs that still describe body-keyword major signals (config/README
  only if they restate the old heuristic).
- No change to continuous release grouping, merge authority, or milestone
  full-reconciliation (#910).
