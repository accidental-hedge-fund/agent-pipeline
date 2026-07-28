## Why

The evaluator can compare one harness at a time, but a pipeline decision is about a primary agent and an independent reviewer working together. Its Cartesian axes also create invalid combinations when models or effort settings are harness-specific. Without paired, explicit treatments, the evaluator cannot compare the current Claude → Codex workflow with Codex → Grok or Grok → Codex without misrepresenting the evidence.

## What Changes

- Add explicit named treatments so a manifest can declare only valid harness/model/effort combinations while preserving existing Cartesian-axis manifests.
- Add a `paired` evaluation mode that runs a primary implementer, a secondary reviewer over the produced diff, a primary fix round for blocking findings, and a reviewer re-review in one isolated cell.
- Add a `pipeline-paired` mode for deployable policy evaluation across planning, plan-review, plan revision, implementation, and both review/fix rounds.
- Record phase identity, review findings, convergence, and final deterministic checks so paired treatments can be graded and compared against the current operating baseline.
- Extend comparative reporting to expose primary/reviewer identity and paired convergence metrics without conflating them with independent review-defect grades.

## Capabilities

### New Capabilities

- `paired-harness-evaluation`: Explicit treatment definitions and isolated primary → reviewer trajectories, including deployable full-pipeline policies, for harness-pair selection.

### Modified Capabilities

- `stage-eval-runner`: Accept explicit named treatments and execute the paired mode safely and deterministically.
- `eval-graders`: Grade paired cells from their final implementation state and record paired convergence separately from independent-review precision/recall.
- `eval-comparative-reporting`: Report paired treatment identity and convergence metrics in baseline comparisons.

## Impact

- `core/scripts/evals/{types,manifest,executor,stage-adapters}.ts`, graders, reporting, CLI documentation, and co-located tests.
- The generated `plugin/` mirror after Core changes.
- Existing fixtures, manifests, single-stage execution, and production pipeline state remain unchanged.
