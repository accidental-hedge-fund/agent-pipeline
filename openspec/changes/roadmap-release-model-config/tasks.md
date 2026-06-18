## 1. Config Schema

- [ ] 1.1 Add `release_model: z.enum(['semver','continuous']).optional()` to the `roadmap:` sub-schema in `config.ts` `PartialConfigSchema`
- [ ] 1.2 Add `.describe(...)` annotation for `release_model` (consistent with existing field annotations)
- [ ] 1.3 Add unit test: valid `semver` and `continuous` values are accepted; absent key defaults to `'semver'`; invalid value throws with the key name and allowed-values list

## 2. Semver Milestone Bundling

- [ ] 2.1 In the roadmap engine milestone phase, replace the hardcoded `milestones: []` return with a call to a new `buildSemverLanes(ranked, config)` function
- [ ] 2.2 Implement `buildSemverLanes`: assign ranked (non-blocked) issues to version-numbered lanes in ranked order; produce `MilestoneSpec[]` with semver-format titles (e.g. `v1.7.0`) starting from the version after the latest released tag
- [ ] 2.3 Add unit tests: non-empty output when backlog has rankable issues; all titles match `v<M>.<N>.<P>`; no issue_number appears in two entries; blocked issues are excluded

## 3. Continuous Milestone Grouping

- [ ] 3.1 Implement `buildContinuousGroups(ranked, issueLabels, config)`: group issues by `epic:*`/`theme:*` label prefix; fall back to tier name for unlabeled issues; produce `MilestoneSpec[]` with non-semver titles
- [ ] 3.2 Add unit tests: titles do not match semver pattern; issues with `epic:auth` label land in the same entry; issues without epic/theme labels are grouped under their tier name

## 4. Per-Deploy Version Marker (Continuous)

- [ ] 4.1 Implement `buildCalVerMarker(outputDir)`: derive `YYYY.0M.MICRO` from the current date and the count of prior plan runs this month in the output directory
- [ ] 4.2 In the roadmap engine output, set `plan.continuous_version_marker` when `release_model === 'continuous'`; omit the field when `release_model === 'semver'`
- [ ] 4.3 Add unit tests: marker present and non-empty for `continuous`; marker absent for `semver`; CalVer format is correct

## 5. Release Model Dispatch

- [ ] 5.1 In the roadmap engine milestone phase, dispatch to `buildSemverLanes` when `release_model === 'semver'` (or absent) and to `buildContinuousGroups` when `release_model === 'continuous'`
- [ ] 5.2 Add integration-level unit test: full roadmap run with `release_model: continuous` produces `milestones[]` with no semver titles and a `continuous_version_marker`

## 6. `--apply` Milestone Write-back

- [ ] 6.1 In `roadmap --apply` write-back logic, iterate `plan.milestones[]` and call `createMilestone` (or reuse via `getMilestones`) for each entry, then call `applyLabel`/issue-milestone assignment for each `issue_numbers[]` element
- [ ] 6.2 Add unit test: `--apply` calls `createMilestone` once per milestone entry and assigns each issue; dry-run calls neither

## 7. `pipeline release` Refusal Gate

- [ ] 7.1 In the `release` sub-command handler, read `config.roadmap.release_model` before the clean-tree precondition check; exit non-zero with a message naming `roadmap.release_model` if the model is `'continuous'`
- [ ] 7.2 Add unit test: refusal fires before any file write when `release_model === 'continuous'`; command proceeds when model is `'semver'` or absent

## 8. CI Gate

- [ ] 8.1 Run `npm run ci` from repo root and confirm all tests pass (core test suite + mirror-sync check)
- [ ] 8.2 Regenerate `plugin/` mirror via `node scripts/build.mjs` and commit with `core/` changes in the same commit
