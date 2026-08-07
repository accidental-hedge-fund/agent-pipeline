## Why

Single-task benchmarks and test-passing patches do not show whether a codebase remains cheap to change. Agent Pipeline claims to improve maintainability under successive requirements, but the eval suite only measures isolated checkpoints — so compounding design debt, inherited regressions, and treatment differences (bare harness vs pipeline, review/quality variants) stay invisible. This change adds multi-change maintainability fixtures that apply ordered, incrementally disclosed requirements against persistent repository state and report cumulative correctness and effort signals without inventing a synthetic “slop” score.

## What Changes

- Introduce **multi-change maintainability fixtures**: an ordered series of checkpoints, each disclosing only the next requirement, with deterministic held-out verifiers for new behavior and re-execution of every inherited verifier from prior checkpoints.
- Extend the **eval runner** so a multi-change cell preserves repository state (and the declared pipeline evidence contract) across checkpoints while each checkpoint runs with **fresh model context**.
- Make **cumulative strict pass** a primary outcome: a checkpoint passes strictly only when its new verifier and every inherited verifier are green. Report current-step, accumulated, inherited, recovered, and terminal all-green states separately so early failure does not erase later diagnostic signal.
- Require **treatment comparison**, not only model comparison: same model and checkpoint sequence through at least a minimal bare / “just solve” harness and the current Agent Pipeline treatment, with optional controlled variants (adversarial review, deterministic code-quality feedback, and #575 design-dossier / human-attestation controls when their risk policy fires) without changing the benchmark contract.
- Record a **reproducible evidence trail** per step (prompts, treatment/config, model identity, repository revision, verifier results, resource use) and report per-change and cumulative correctness, time, tokens, cost, retries, interventions, code growth, change amplification, and structural telemetry as **separate signals** — never as a collapsed maintainability ground truth.
- Include fixture content requirements: architectural ambiguity, cross-cutting constraints, at least one **initially test-passing shortcut that raises later change cost**, at least one **stronger-to-weaker model portability probe**, and at least one **curated external canary** in an incrementally disclosed, inherited-regression shape alongside repo-native fixtures.
- Explicit non-goals: no universal maintainability/slop score; no blocking delivery solely on isolated structural metrics; no treating model-vs-model rankings as proof the pipeline improves outcomes; no hard dependency on #575 before bare-vs-pipeline can run.

## Acceptance Criteria

- [ ] The eval harness can run an ordered, incrementally disclosed series of changes against persistent repository state for a multi-change fixture.
- [ ] Each checkpoint runs with fresh model context while preserving repository state and the declared pipeline evidence contract between checkpoints.
- [ ] Each checkpoint has deterministic held-out verifiers for new behavior and the harness re-runs every inherited verifier from prior checkpoints.
- [ ] Strict checkpoint pass requires both new and inherited verifiers to pass; reports distinguish current-step, accumulated, inherited, recovered, and terminal all-green defect states.
- [ ] Each step preserves a reproducible evidence trail including prompts, treatment/configuration, model identity, repository revision, verifier results, and resource use.
- [ ] Baselines compare at least a bare harness and current Agent Pipeline using the same model, checkpoint prompts, repository lineage, and verifiers.
- [ ] The treatment model supports controlled comparison of adversarial-review and deterministic quality-feedback variants without changing the benchmark contract (same prompts and verifiers).
- [ ] Reports show per-change and cumulative correctness, time, tokens, cost, retries, intervention, code-growth, change-amplification, and structural telemetry as separate dimensions (no synthetic slop score presented as ground truth).
- [ ] At least one fixture performs a stronger-to-weaker model portability probe and reports the weaker model’s correctness, time, cost, and intervention.
- [ ] At least one fixture demonstrates that an initially test-passing shortcut makes later work materially harder under inherited-verifier accounting.
- [ ] At least one curated external canary uses the incrementally disclosed, inherited-regression benchmark shape.
- [ ] `#577` bare-vs-pipeline benchmark does not require `#575` to be present or configured.
- [ ] Unit tests cover multi-change fixture validation, checkpoint scheduling/isolation of model context vs repo state, inherited-verifier strict pass, defect-state accounting, and report separation of structural telemetry from correctness; `npm run ci` is green with `plugin/` regenerated when `core/` changes.

## Capabilities

### New Capabilities

- `eval-multi-change-maintainability`: multi-change fixture semantics and evaluation contract — ordered checkpoints, incremental disclosure, fresh context with preserved repo/evidence, held-out + inherited verifiers, cumulative strict pass, defect-state and effort reporting, treatment comparison (bare vs pipeline + controlled variants), portability probe, shortcut-debt and external-canary content requirements, and prohibition on presenting structural or model-judged metrics as maintainability ground truth.

### Modified Capabilities

- `eval-fixture-contract`: admit multi-change fixture schema (checkpoint sequence, per-checkpoint task input, held-out verifiers, inheritance, optional portability and canary metadata) while keeping single-task fixtures valid.
- `stage-eval-runner`: support a multi-change execution mode that sequences checkpoints in one cell lineage (persistent worktree/repo state, fresh treatment context per checkpoint, evidence trail per step).
- `eval-graders`: grade multi-change cells with new + inherited verifiers, strict cumulative pass, and defect states (current, accumulated, inherited, recovered, terminal).
- `eval-comparative-reporting`: report multi-change metrics (per-step and cumulative correctness/effort; code growth; change amplification; structural telemetry as non-ground-truth dimensions) and bare-vs-pipeline (and optional variant) pairing without collapsing axes into a single maintainability score.

## Impact

- `core/scripts/evals/` — fixture schema/types, loader validation, multi-change execution path, grader and reporting extensions for cumulative/inherited outcomes.
- `core/evals/fixtures/` — new multi-change fixture corpus (repo-native sequence(s), shortcut-debt sequence, optional external canary packaging) and any schema-version bump for multi-change records.
- `core/test/*evals*` — hermetic unit tests (no live model/network) for validation, sequencing, verifier inheritance, defect accounting, and report shape.
- Living specs under `openspec/specs/{eval-fixture-contract,stage-eval-runner,eval-graders,eval-comparative-reporting}/` after archive; new living spec `eval-multi-change-maintainability`.
- Related but non-blocking: #575 (design dossier / human attestation as optional treatment variant when configured); #536 trajectory artifacts as evidence carriers; existing paired-treatment modes as composition targets for the pipeline treatment.
