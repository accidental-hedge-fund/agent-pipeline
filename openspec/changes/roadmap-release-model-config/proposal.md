## Why

The roadmap engine always produces an empty `milestones[]` array in `plan.json`, so the grouped-plan milestone output is dead today. Maintainers need to choose between version-based releases (semver lanes) and continuous delivery (theme groupings), and `pipeline release` has no guard to refuse running when a project ships continuously rather than via cut releases.

## What Changes

- `.github/pipeline.yml` gains a `roadmap.release_model` key accepting `semver` (default) or `continuous`; any other value fails config validation with an error naming the key and listing the allowed values.
- Under `semver` (default): `milestones[]` in `plan.json` is populated with version-numbered release lanes (e.g., `v1.7.0`) that bundle the already-ranked backlog issues; each issue appears in exactly one lane.
- Under `continuous`: `milestones[]` contains theme/epic groupings (no semver title); a per-deploy version marker for traceability is recorded in the output; no semver version strings appear as milestone titles.
- `pipeline roadmap --apply` creates one GitHub milestone per `milestones[]` entry and assigns each listed issue to that milestone (both models); default dry-run creates no milestones and assigns no issues.
- `pipeline release` refuses to run when `roadmap.release_model` is `continuous`: it exits non-zero without creating a branch or PR, prints a message naming the config key.

## Capabilities

### New Capabilities
- `roadmap-release-model`: Config key `roadmap.release_model`, its validation contract, `semver` milestone-bundling behavior, `continuous` theme-grouping behavior, `--apply` write-back for both models, and the per-deploy version marker format.

### Modified Capabilities
- `backlog-roadmap-engine`: `milestones[]` in `plan.json` is no longer hardcoded `[]`; its content is now governed by `release_model`.
- `pipeline-configuration`: `PartialConfigSchema`'s `roadmap:` block gains the `release_model` field; strict validation rejects unknown values.
- `release-sub-command`: Adds a continuous-model refusal gate that exits non-zero before any write when `release_model` is `continuous`.

## Impact

- `core/scripts/config.ts` — `PartialConfigSchema` `roadmap:` sub-key gains `release_model: z.enum(['semver','continuous']).optional()`
- `core/scripts/` roadmap engine (whichever module populates `milestones[]`) — new milestone-bundling logic for `semver`; new theme-grouping logic for `continuous`
- `core/scripts/pipeline.ts` (or the release handler) — `continuous` refusal gate before the version-bump step
- `core/test/` — new unit tests for the config validation, semver bundling, continuous grouping, and release refusal
