## Context

The eval suite already has:

- **Frozen single-task fixtures** (`eval-fixture-contract`) with `base_commit`, task input, public/hidden checks, graders, and smoke-only labeling.
- **Stage / paired runners** (`stage-eval-runner`, `eval-paired-treatments`) that expand a treatment matrix into isolated cells and can run bare stages, end-to-end, `implementing-paired`, or `pipeline-paired`.
- **Grading and comparative reporting** (`eval-graders`, `eval-comparative-reporting`) that pair treatments per fixture, separate reliability from quality, and refuse single-axis collapse on Pareto frontiers.
- **Trajectory / verifier artifacts** (`eval-trajectory-artifacts`) for content-addressed evidence without leaking verifier material into treatment inputs.

What it lacks is a **multi-checkpoint lineage**: one repository that accumulates successive, incrementally disclosed requirements, with fresh model context each step, held-out verifiers that inherit, and reports that separate current-step failure from recovered and terminal states. Single-cell isolation (fresh worktree per cell) is the right default for single-task fairness, but maintainability measurement requires the opposite along the change axis: **same treatment lineage, evolving tree**.

This design extends the existing eval surfaces rather than inventing a parallel harness.

## Goals / Non-Goals

**Goals:**

- Represent multi-change fixtures as first-class, validated fixture data.
- Execute an ordered checkpoint sequence with persistent repository state and a declared pipeline-evidence contract, while resetting model/session context each checkpoint.
- Enforce deterministic held-out verifiers for new behavior and re-run all inherited verifiers; define strict cumulative pass.
- Account defects as current-step, accumulated, inherited, recovered, and terminal all-green — without erasing later signal after an early fail.
- Compare treatments (bare vs current pipeline; optional adversarial review, quality-feedback, #575 controls) under identical prompts and verifiers.
- Report correctness, effort, growth, amplification, and structural telemetry as separate dimensions.
- Ship at least one shortcut-debt sequence, one portability probe, and one external canary shape.

**Non-Goals:**

- A universal maintainability or “slop” score.
- Using cyclomatic complexity, duplication, verbosity, or similar as mandatory delivery gates.
- Proving pipeline value solely via model-vs-model rankings.
- Blocking bare-vs-pipeline on #575 landing.
- Changing production pipeline merge policy or the single-task eval default isolation model for non-multi-change fixtures.
- Live network calls or live model calls in unit tests.

## Decisions

### 1. Multi-change fixture as an extension of fixture contract, not a separate file type

**Decision:** Multi-change fixtures live under the same fixture loading surface (`core/evals/fixtures/`, `fixture.ts`) with a schema extension: a top-level shape that declares `kind: multi_change` (or equivalent) and an ordered `checkpoints[]` array. Single-task fixtures remain valid without that shape (`schema_version` may bump if needed; loaders MUST accept both).

Each checkpoint declares:

- stable `checkpoint_id` (unique within the fixture)
- task / prompt text disclosed only at that step
- held-out verifier set for **new** behavior (deterministic; never in treatment-visible inputs)
- optional stage-entry artifacts for the step’s execution mode
- optional metadata (e.g. `introduces_shortcut_debt`, portability role)

**Inheritance rule:** At checkpoint *k*, the inherited verifier set is the union of held-out verifiers from checkpoints `1..k-1`. Strict pass at *k* requires new + inherited green.

**Alternatives considered:** Separate “scenario packs” outside fixtures — rejected because grading, preflight, and join keys already key on `fixture_id`. One giant task_input with all requirements — rejected because it violates incremental disclosure and confounds multi-change measurement.

### 2. Execution: multi-change cell lineage (one worktree, many checkpoint steps)

**Decision:** Add a runner mode (or fixture-driven branch of existing modes) where a **cell** is a treatment × multi-change fixture × replicate lineage. Within that lineage:

1. Check out `base_commit` once into an isolated worktree (same isolation guarantees as today’s single-task cells: no production GitHub writes).
2. For each checkpoint in order:
   - Start a **fresh model/session context** (no conversation history from prior checkpoints).
   - Supply only that checkpoint’s disclosed prompt + the declared preserved pipeline evidence (see Decision 3).
   - Run the configured treatment (bare implement vs pipeline-paired graph, etc.).
   - Capture repository revision after the step (commit or dirty tree fingerprint as the evidence contract defines).
   - Run new + inherited held-out verifiers via the grading/verifier path (not treatment-visible).
   - Append a step evidence record; continue to the next checkpoint even if strict pass failed (diagnostic continuity), unless a hard infra/auth/timeout aborts the lineage per existing result classes.

**Contrast with today’s default:** single-task cells still get a fresh worktree per cell. Multi-change reuses the worktree **within** the lineage only.

**Alternatives considered:** N separate cells with manually replaying patches — rejected; loses treatment ownership of intermediate design choices. Full conversation continuity across checkpoints — rejected; confounds “maintainability of the repo” with “memory of the chat.”

### 3. Pipeline evidence contract is explicit and minimal

**Decision:** Between checkpoints the runner preserves:

- the **repository filesystem/git state** after the previous checkpoint’s treatment writes
- a **declared evidence bundle** limited to artifacts the production pipeline would legitimately hand forward when resuming work on the same branch (e.g. open PR identity if the treatment creates one in-eval isolation, last review verdict file paths if present, worktree path). The fixture or treatment profile names what is in-contract.

The runner SHALL NOT preserve free-form model chat, hidden verifier definitions, or grader internals. Trajectory collection continues to redact secrets and keep verifier-only material out of treatment trajectories (`eval-trajectory-artifacts`).

### 4. Treatments: same prompts/verifiers; vary harness graph only

**Decision:** Baseline experiment manifests for multi-change fixtures declare at least:

| Treatment id (illustrative) | Behavior |
| --- | --- |
| `bare` / `just-solve` | Minimal implement-only (or equivalent “solve the prompt”) path; no review/fix loop |
| `pipeline-current` | Current Agent Pipeline treatment graph (compose with existing `pipeline-paired` / production prompt builders where applicable) |

Optional controlled variants (same checkpoint prompts and verifiers):

- adversarial review enabled (pipeline graph with adversarial stage on)
- deterministic code-quality feedback injected into the loop (tooling-produced, not model-judged maintainability scores as pass/fail truth)
- #575 design-dossier / human-attestation path **only when** the fixture’s risk policy and config enable it; absence of #575 SHALL NOT block bare-vs-pipeline runs

Validation rejects a multi-change experiment that claims treatment comparison but supplies only one treatment for the baseline pair.

### 5. Strict pass and defect accounting

**Decision:** Verifier outcomes are boolean (or equivalent pass/fail) and deterministic. Define:

- **Current-step defects:** new verifiers that fail at checkpoint *k*
- **Inherited defects:** inherited verifiers that fail at *k*
- **Accumulated defects:** union of unresolved defect ids across the lineage up to *k* (stable ids per verifier or seeded defect)
- **Recovered defects:** defect ids that failed at some earlier checkpoint and pass at *k*
- **Terminal all-green:** after the final checkpoint, every declared verifier in the full inheritance closure is green

Strict pass at *k* ⇔ no current-step defects ∧ no inherited defects. A lineage may still complete later checkpoints after a non-strict step so recovered/terminal metrics remain informative.

**Alternatives considered:** Stop-on-first-fail only — rejected for diagnostic loss. Soft scoring of partial verifier pass as primary outcome — rejected; strict cumulative pass is primary; soft diagnostics may exist as secondary fields but MUST NOT replace strict pass.

### 6. Structural telemetry is additive, never ground truth

**Decision:** Collect deterministic structural signals (complexity, duplication, cycles, nesting, symbol churn, single-use wrappers, production/test LOC growth, touch-point hotspots, interface churn, change amplification) as **telemetry fields** and optional treatment inputs (e.g. quality-feedback variant may surface some of them to the agent). Reports MUST place them in a separate section/axis from correctness and MUST NOT emit a single weighted “maintainability score” that mixes them with verifier pass.

### 7. Portability probe as checkpoint role, not a separate runner

**Decision:** A fixture MAY mark checkpoint *N+1* with a portability role and a model override (weaker/cheaper model) while checkpoints `1..N` use a stronger model/treatment. The runner applies the override only at that checkpoint, keeps repo state and evidence contract continuous, and reports weaker-model correctness, time, cost, and intervention separately.

### 8. Fixture content strategy

**Decision (corpus minimum for done):**

1. **Repo-native multi-change sequence** representative of Agent Pipeline user work (architectural ambiguity + cross-cutting constraint).
2. **Shortcut-debt sequence** where an early checkpoint can be “solved” with a test-passing shortcut that causes measurable later inherited failure or amplification under later checkpoints.
3. **External canary** packaged or vendored under eval control (SlopCodeBench-style or curated subset) using the same incremental + inheritance shape — not a live pull of unpinned upstream at grade time.

All verifiers are held-out and deterministic. Harvested single-task fixtures are out of scope for conversion unless explicitly migrated later.

### 9. Schema versioning and preflight

**Decision:** Extend fixture validation and preflight so multi-change fixtures:

- reject empty checkpoint lists, duplicate `checkpoint_id`, missing verifiers on any checkpoint, or leakage of held-out verifier bodies into treatment-visible fields
- prove base_commit reachability (existing #637 preflight)
- optionally dry-run verifier executability at pin without model spend where feasible

Single-task preflight behavior stays unchanged.

### 10. Testing seams

**Decision:** Unit tests inject fake harness adapters and fake verifier runners (existing deps pattern). Prove:

- inheritance set construction
- strict pass boolean
- defect state transitions (including recovery after early fail)
- fresh-context flag / no chat leakage between steps
- report refuses synthetic ground-truth score field
- #575 optional path is skipped cleanly when unconfigured

No live model or network in `npm test`.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Multi-change lineages are expensive (tokens/time) | Small curated corpus; resume per checkpoint; infra failures classified separately; smoke fixtures remain single-task |
| Early design choices make later steps impossible, collapsing all treatments | Continue-after-non-strict; report recovered vs terminal; design shortcut-debt intentionally rather than accidentally |
| Structural metrics get misread as pass/fail | Spec + report schema forbid collapsed score; tests assert absence |
| Pipeline evidence contract drifts / leaks hidden checks | Explicit allowlist of preserved artifacts; trajectory leak tests |
| External canary bit-rots | Pin content and verifiers in-repo; preflight integrity |
| Coupling to #575 delays baseline | Baseline treatments do not require #575; optional variant only |
| Confusion with single-task cell isolation | Mode-gated docs; multi-change only when fixture kind declares it |

## Migration Plan

1. Land schema + validation (single-task fixtures still pass).
2. Land runner multi-change path behind fixture kind / mode detection.
3. Land graders + reporting extensions.
4. Add corpus fixtures and a sample experiment manifest for bare vs pipeline.
5. Archive OpenSpec change into living specs when implementation meets acceptance criteria.
6. Rollback: remove multi-change fixtures and mode; single-task eval path remains the default and is unaffected if multi-change is feature-gated by fixture kind.

## Open Questions

- Exact name of the runner mode string (`multi-change` vs fixture-kind auto-detection only) — prefer fixture-kind detection so existing mode enums stay stable when possible; resolve in implementation if manifest mode is required for clarity.
- Whether portability model override is declared on the checkpoint, the manifest, or both (recommend checkpoint default with optional manifest override for experiments).
- Depth of the first external canary (full SlopCodeBench import vs small curated sequence) — choose the smallest curated sequence that exercises inheritance and report shape.
