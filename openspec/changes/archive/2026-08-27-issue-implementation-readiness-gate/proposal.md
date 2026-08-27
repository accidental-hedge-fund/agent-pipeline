## Why

Thin or contradictory GitHub issues still enter delivery as soon as they carry `pipeline:ready`. That consumes a worktree and a planning/implementation run before anyone can tell that the outcome is not executable. An opt-in admission gate must stop that spend and return a body-hash-bound refinement draft instead of starting delivery.

## What Changes

- Add a documented `issue_readiness` configuration block. Default is `enabled: false`. When disabled, every current direct advance, queue, loop, train, and ship path keeps its exact behavior.
- Enable the gate in this repository's `.github/pipeline.yml` as the first dogfood consumer. Other repositories stay unchanged unless they opt in.
- Add one shared gate in front of every GitHub issue pickup path: direct `pipeline <issue>`, queue, loop/supervisor redispatch, train, and ship. No entry point may skip it.
- Immediately before evaluation, re-fetch the authoritative issue title, body, and labels. Do not evaluate stale queue inventory, prior-run text, or an earlier comment.
- Invoke the resolved Implementer, not the Reviewer and not a hard-coded provider, with the active planning treatment: `harnesses.implementer`, `models.planning`, and `effort.planning`, including normal `auto` routing.
- Accept a structured verdict of `ready` or `needs_spec`. Semantic readiness requires a clear problem/outcome, observable acceptance criteria, scope constraints or non-goals, and no unresolved contradiction. Canonical headings improve the drafted revision. They are not themselves required for admission.
- On `needs_spec`, create or update exactly one Pipeline-authored GitHub comment bound to the evaluated title/body hash and resolved planning treatment. The comment names concrete deficiencies and a proposed revised body that preserves author intent and follows the Summary, User story, Acceptance criteria, Out of scope, and Open questions contract.
- Move a rejected issue from `pipeline:ready` to a new `pipeline:needs-spec` admission state. The label exists in managed label setup. Every scheduler treats it as not eligible for pickup.
- The gate may write only its owned comment and the `pipeline:needs-spec` label transition. It never edits the issue body, milestone, unrelated labels, or project files.
- After an author applies the proposed body, they re-admit with existing `pipeline triage <N> --stage ready`. That request is not a bypass: the fresh body must pass the gate before any worktree or delivery harness starts.
- Unchanged title, body, and treatment reuse the recorded verdict and owned comment without another model call or comment. Any title, body, or treatment change invalidates the old verdict and triggers a fresh evaluation.
- A `needs_spec` result creates no worktree and invokes neither the planning nor the implementation delivery harness. Queue and loop output name the structured rejection reason. Independent eligible issues continue.
- A provider, harness, timeout, or schema failure produces typed `gate-unavailable` behavior. It has no structural, reviewer, provider, or model fallback. It blocks the affected issue and selected dependents. Independent selected issues remain eligible. Direct single invocation fails visibly.

Out of scope: automatic issue-body edits; automatic re-admission after an edit; a GitHub webhook for issue-edit detection; replacing `pipeline sweep`, `pipeline refine-spec`, or existing triage commands; reviewer/structural/provider/model fallback when the configured planning treatment is unavailable; retrospectively reprocessing every existing GitHub issue.

## Capabilities

### New Capabilities
- `issue-implementation-readiness-gate`: shared opt-in admission gate that evaluates a freshly fetched issue through the Implementer planning treatment, records a hash-and-treatment-bound verdict, writes one owned comment plus `pipeline:needs-spec` on rejection, reuses an unchanged verdict, and fails closed as typed `gate-unavailable` with no fallback.

### Modified Capabilities
- `pipeline-configuration`: accept an `issue_readiness` block with default `enabled: false`; unknown keys fail strict schema validation; this repository enables the block as dogfood.
- `pipeline-state-machine`: add `needs-spec` as a pre-delivery admission stage; the `ready` dispatch runs the shared gate before planning or worktree creation; `needs-spec` does not auto-advance.
- `loop-precondition-stage-gate`: treat `pipeline:needs-spec` as a pre-pipeline stage, same class as `pipeline:backlog`.
- `batch-queue-engine`: `pipeline:needs-spec` is not autonomous-eligible; a gate rejection or `gate-unavailable` on one selected issue does not abort independent siblings.
- `triage-sub-command`: `pipeline triage <N> --stage ready` remains a deterministic label write and an admission request. It does not skip the pickup gate.
- `init-command`: managed label setup creates `pipeline:needs-spec` with the other pipeline stage labels.

## Impact

- **Config:** `core/scripts/config.ts` and `core/scripts/types.ts` gain `issue_readiness` (`enabled` default false, optional timeout). Schema descriptions, init/sync scaffold, and generated `docs/config.md` document the block. This repo's `.github/pipeline.yml` sets `enabled: true`.
- **State machine / labels:** `STAGES` gains `needs-spec` next to `backlog`. `ensurePipelineLabels` / `desiredPipelineLabels` create it. `ready` dispatch calls the shared gate before the live-planning marker and `planningAdvance`. `needs-spec` dispatch is a non-advancing triage wait, like `backlog`.
- **Pickup paths:** direct advance/single, queue, loop/supervisor redispatch, train, and ship all hit the same function before worktree create or delivery harness invoke.
- **GitHub writes:** one owned comment (create or update) and the `ready` → `needs-spec` label transition on rejection. No body, milestone, or unrelated-label edits.
- **Tests:** injected GitHub, time, and harness fakes. No real network, git, or subprocess.
- **Packaging:** regenerate `plugin/` with `node scripts/build.mjs` in the same commit as any `core/` edit.

## Acceptance Criteria

- [ ] A documented `issue_readiness` config block exists. Default is `enabled: false`. With that default, direct advance, queue, loop, train, and ship keep their current pickup, worktree, and harness behavior.
- [ ] This repository's `.github/pipeline.yml` sets `issue_readiness.enabled: true`. A repository that omits the block remains ungated.
- [ ] Direct `pipeline <issue>`, queue, loop/supervisor redispatch, train, and ship all call one shared gate before worktree create or delivery harness invoke. A unit test for each path proves a disabled or missing call site would admit a thin issue.
- [ ] Evaluation reads a freshly fetched title, body, and labels. Stale queue inventory, a prior-run snapshot, and an earlier comment body are not the evaluated text.
- [ ] The gate invokes the resolved Implementer with `harnesses.implementer`, `models.planning`, and `effort.planning`, including `auto` routing. It does not invoke the Reviewer and does not hard-code a provider.
- [ ] A structured `ready` verdict admits an issue that has a clear problem/outcome, observable acceptance criteria, scope constraints or non-goals, and no unresolved contradiction, even when canonical headings are missing.
- [ ] A structured `needs_spec` verdict writes or updates exactly one Pipeline-authored comment bound to the evaluated title/body hash and resolved planning treatment. The comment lists concrete deficiencies and a proposed revised body that preserves author intent and contains Summary, User story, Acceptance criteria, Out of scope, and Open questions.
- [ ] A `needs_spec` result moves the issue from `pipeline:ready` to `pipeline:needs-spec`. `pipeline init` / managed labels create that label. Queue, loop, train, and ship treat it as not eligible for pickup.
- [ ] On `needs_spec` and on `ready`, the gate does not edit the issue body, milestone, unrelated labels, or any project file.
- [ ] `pipeline triage <N> --stage ready` still only writes labels (no model call). The next pickup re-fetches and must pass the gate before a worktree or delivery harness starts.
- [ ] The same title, body, and planning treatment reuse the recorded verdict and owned comment with zero extra model calls and zero extra comments. A title, body, or treatment change invalidates that record and evaluates again.
- [ ] `needs_spec` creates no worktree and does not invoke planning or implementation delivery. Queue/loop output names the structured reason. Independent eligible issues continue.
- [ ] Provider, harness, timeout, or schema failure returns typed `gate-unavailable` with no structural, reviewer, provider, or model fallback. Direct single invocation exits non-zero. Multi-item runs block that issue and its selected dependents and continue independent selected issues.
- [ ] Unit tests inject GitHub, time, and harness I/O and cover enabled/disabled behavior across every pickup path; fresh-body refresh; primary-treatment propagation; semantic verdicts; comment provenance/idempotency; label transition; re-admission; invalidation; gate-unavailable dependency behavior; and no-side-effect rejection.
- [ ] Generated plugin files and documentation stay in sync. `node scripts/build.mjs` and `npm run ci` pass.
