## 1. Types and classification contract

- [x] 1.1 Add per-issue compatibility classification types (status, applied impact, source label, uncertainty, optional recommendation/conflict labels) on the roadmap plan model in `core/scripts/roadmap/types.ts`
- [x] 1.2 Extend or replace `classifyCompatibilityImpact` so applied impact resolves only from exclusive `semver:major` | `semver:minor` | `semver:patch`, with explicit `unresolved_missing` and `unresolved_conflict` outcomes
- [x] 1.3 Remove title/body keyword matching (`breaking change`, `migration`, and peers) from applied SemVer classification
- [x] 1.4 Emit optional non-binding recommendations from generic type labels (and optional `breaking` / `breaking-change`) only when applied status is missing — never as applied impact

## 2. SemVer lane membership and version walk

- [x] 2.1 Gate `buildSemverLanes` (or equivalent) so only **resolved** applied-impact issues enter milestone `issue_numbers[]`
- [x] 2.2 Drive `version_impact` and major/minor/patch title increments only from resolved applied impacts of issues placed in each milestone
- [x] 2.3 Keep capacity packing, oversized isolation, and `isolate_breaking` behavior for resolved `major` issues; do not treat prose-only or recommendation-only issues as breaking
- [x] 2.4 Attach the full per-issue classification list to `plan.json` on every SemVer roadmap run

## 3. Surfaces (Markdown, preview, open questions)

- [x] 3.1 Surface per-issue impact, source label, and uncertainty/status in Markdown roadmap writeback
- [x] 3.2 Surface the same provenance in dry-run and apply preview logging
- [x] 3.3 Record unresolved missing/conflict cases so they remain visible (classification list and/or `open_questions[]`) without auto-assigning milestones

## 4. Continuous mode and regression guards

- [x] 4.1 Confirm `release_model: continuous` still groups by theme/epic with non-semver titles and does not apply SemVer exclusive-label assignment rules
- [x] 4.2 Leave continuous CalVer marker behavior unchanged

## 5. Tests

- [x] 5.1 Invert/remove tests that expect body `migration` / `breaking change` prose alone to produce applied major
- [x] 5.2 Add regression: incidental `migration` prose + no `semver:*` → unresolved missing, not major
- [x] 5.3 Add regression: `semver:patch` + breaking-language prose → applied patch
- [x] 5.4 Add regression: `semver:major` alone → applied major and major milestone when packed
- [x] 5.5 Add regression: missing explicit SemVer labels → unresolved + no automatic milestone assignment (type labels may only recommend)
- [x] 5.6 Add regression: conflicting `semver:*` labels → unresolved conflict, listed conflict labels, no automatic milestone assignment
- [x] 5.7 Add regression: title/body-only edit with labels fixed does not change applied impact
- [x] 5.8 Keep continuous-mode tests green for non-semver titles

## 6. Docs, mirror, and CI

- [x] 6.1 Update operator-facing docs that still claim body-keyword SemVer major signals (only where they restate the old heuristic)
- [x] 6.2 Run `node scripts/build.mjs` and include regenerated `plugin/` when core changes require it
- [x] 6.3 Run `npm run ci` and fix failures until green
