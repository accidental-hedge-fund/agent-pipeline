## ADDED Requirements

### Requirement: Warn when an effort.* value is set for a stage whose harness ignores per-stage effort

`resolveConfig()` SHALL emit a non-blocking `console.warn` for each `effort.*` key that is (a) explicitly present in the file config and (b) backing a stage whose harness ignores per-stage effort. Because both the claude harness (`--effort`) and the codex harness (`-c model_reasoning_effort`) honor per-stage effort, the only harness that ignores it is a **custom reviewer CLI** configured via `review_harness` (which honors neither a model nor an effort flag). The warning SHALL name the key, its value, the affected reviewer command, and the reason the setting is ignored. It SHALL NOT throw, mutate the resolved config, or trigger a fallback.

> Note (see the change's design.md): issue #366 phrased this as "warn for a codex stage", which rests on the false premise that codex ignores effort (it does not — `harness.ts` appends `-c model_reasoning_effort`). The honest inert case is a custom reviewer CLI. If the maintainer prefers no effort advisory at all, this requirement is additive and may be dropped without affecting the rest of the change.

#### Scenario: effort.review set with a custom reviewer CLI warns

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer` and `effort: { review: high }`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` naming `effort.review`, the value `high`, the reviewer command `my-reviewer`, and an indication that the setting is ignored

#### Scenario: effort.review set with a claude reviewer — no warning

- **WHEN** `.github/pipeline.yml` sets `effort: { review: high }` and the effective reviewer harness is `claude`
- **THEN** `resolveConfig()` SHALL NOT emit an inert-effort warning for `effort.review` (claude honors `--effort`)

#### Scenario: effort.implementing set with a codex implementer — no warning

- **WHEN** `.github/pipeline.yml` sets `effort: { implementing: low }` and the implementer harness is `codex`
- **THEN** `resolveConfig()` SHALL NOT emit an inert-effort warning for `effort.implementing` (codex honors `-c model_reasoning_effort`)

#### Scenario: effort key absent — no warning

- **WHEN** `.github/pipeline.yml` has no `effort:` block, even with a custom reviewer CLI configured
- **THEN** `resolveConfig()` SHALL NOT emit any inert-effort warning (default-unset keys never warn)

### Requirement: The inert-effort advisory SHALL be non-blocking and SHALL NOT alter resolved config

The inert-effort advisory SHALL be advisory only. `resolveConfig()` SHALL return the same `PipelineConfig` regardless of whether the advisory was emitted; the inert effort value SHALL remain in the resolved config for its stage. No exception SHALL be thrown.

#### Scenario: pipeline run continues after inert-effort warning

- **WHEN** an inert-effort warning is emitted during `resolveConfig()`
- **THEN** `resolveConfig()` SHALL complete normally and return a valid `PipelineConfig`, with the effort value preserved for its stage
