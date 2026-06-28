## Why

The pipeline intentionally leaves merge as a human-owned boundary, but for small, low-risk scoped changes this creates unnecessary friction — developers must wait for a human to click merge even when CI is green, review is clean, and the diff is purely mechanical. This change adds a structured eligibility gate so that low-risk PRs can be classified as `auto-merge-eligible` while keeping the default human-owned path and making all hard-denial decisions deterministic and auditable.

## What Changes

- Add a new pipeline outcome classification: `auto-merge-eligible` (alongside existing `ready-to-deploy` and `needs-human`).
- Introduce a deterministic policy envelope that hard-denies eligibility for any PR touching high-risk categories (migrations, auth, billing, security, infra, deps, secrets, schedulers, public APIs, release/production config).
- Add an LLM judge stage that emits a structured risk classification (scope size, blast radius, semantic risk, reversibility, confidence, reasons) within the deterministic envelope — the judge cannot override hard denials.
- Persist an `auto_merge_eligibility` artifact on the run evidence bundle capturing deterministic checks, judge output, final decision, linked IDs, CI/review snapshot, and a revert note.
- Expose eligibility classification from the CLI.

## Capabilities

### New Capabilities

- `auto-merge-eligibility`: Eligibility gate that combines a deterministic policy envelope with an LLM risk judge to classify a PR as `auto-merge-eligible` or `needs-human`, persisting a durable decision artifact on the run evidence bundle.

### Modified Capabilities

- `pipeline-state-machine`: Add the `auto-merge-eligible` outcome state alongside `ready-to-deploy`; the gate runs after review is clean and CI passes, before a final eligibility verdict is written.
- `evidence-bundle`: Add the `auto_merge_eligibility` artifact schema to the evidence bundle definition.
- `pipeline-configuration`: Add configurable policy thresholds (diff size, file count, allow/deny path patterns) for the eligibility envelope.

## Impact

- New stage module: `core/scripts/stages/auto_merge_eligibility.ts` (determistic checks + judge call).
- New prompt template: `core/scripts/prompts/auto_merge_eligibility_judge.md`.
- New eligibility artifact schema in `core/scripts/review-schema.ts` (or a co-located schema file).
- `core/scripts/pipeline.ts`: wire the new stage into the run loop after the pre-merge gate.
- `core/scripts/config.ts`: add policy threshold config keys.
- `core/test/`: new test file `auto-merge-eligibility.test.ts`.
- References issue #23 (graduated autonomy / governance thread).
- No auto-merge *execution* in this change — eligibility classification only.
