## Why

The pipeline has code review gates and CI gates but no stage that validates a completed change against the issue's own acceptance criteria and product intent, evaluated by an independent (non-implementing) harness. A change can pass all review and test gates while still missing issue coverage, skipping acceptance criteria, or drifting from the original problem statement — the "technically valid, wrong target" failure mode. A private acceptance rubric, evaluated by the reviewer harness after all implementation work is done, closes this gap without compromising the rigor-over-latency principle.

## What Changes

- Adds a new `shipcheck-gate` pipeline stage positioned after `eval-gate` and before `ready-to-deploy`.
- Adds a `shipcheck_gate` config block in `.github/pipeline.yml`; the gate is off by default when the block is absent.
- The **reviewer** harness (not the implementing harness) evaluates the rubric so the builder cannot self-certify.
- The rubric can inspect the issue body, plan, acceptance criteria, changed files, test/eval summaries, OpenSpec deltas, and the evidence bundle when available.
- Two modes: `advisory` (default) records pass/fail/findings on the issue/PR without blocking; `gate` mode blocks `ready-to-deploy` on failure.
- A configurable max-rounds/timeout bound applies; timeout surfaces as `needs-human` (or a blocker) rather than silent pass.
- Results are posted to the issue/PR with enough detail for a human to fix, override, or defer.

## Capabilities

### New Capabilities

- `shipcheck-gate`: A post-implementation, reviewer-owned acceptance rubric stage that evaluates the completed change against the issue's acceptance criteria, plan, and product intent before `ready-to-deploy`.

### Modified Capabilities

- `pipeline-state-machine`: Adds `shipcheck-gate` to the canonical `STAGES` sequence, positioned after `eval-gate` and before `ready-to-deploy`.
- `pipeline-configuration`: Adds the optional `shipcheck_gate` config block (`enabled`, `mode`, `max_rounds`, `rubric_path`).

## Impact

- `core/scripts/types.ts` — `STAGES` gains `"shipcheck-gate"`.
- `core/scripts/stages/shipcheck.ts` — new stage handler (reviewer harness invocation, rubric loading, result posting).
- `core/scripts/config.ts` — `PartialConfigSchema` gains the `shipcheck_gate` block; `DEFAULT_CONFIG` defaults it off.
- `core/scripts/pipeline.ts` — dispatch table gains `"shipcheck-gate"` → `shipchecK.advance`.
- Prompt template added: `core/scripts/prompts/shipcheck.md`.
- Unit tests in `core/test/shipcheck.test.ts`.
