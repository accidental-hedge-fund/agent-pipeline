## Context

The advance loop currently records lifecycle for the dispatch stage it sees at the start of an iteration. For an issue labelled `pipeline:ready`, that dispatch invokes the whole planning runner: carry-forward context, worktree bootstrap, plan authoring, plan review, plan revision, implementation, gates, push, PR creation, and transition to `review-1`. `evidenceStageName("ready")` maps this entire arc to `planning`, so run artifacts make implementation time appear to be planning time.

OpenSpec stale-delta detection already exists as a conservative pre-merge backstop, but finding it there burns a full review/fix/pre-merge cycle. Fix rounds have the same information after they finish changing the branch and before they push.

Stage accounting is intentionally observational. Adding prompt-size telemetry must preserve that property and must not persist raw prompts, responses, transcripts, or secrets.

Queue mode is concurrency-capable, but separate queue processes can still select the same ready issues. Per-issue locks prevent simultaneous mutation later; a batch-level lock avoids wasted process launches and duplicate operator confusion earlier.

## Goals / Non-Goals

**Goals:**

- Make labels and run artifacts reflect the actual long-running substages: `planning`, `plan-review`, and `implementing`.
- Catch the existing OpenSpec stale-delta condition during fix rounds before push.
- Record prompt size as sanitized numeric telemetry and expose it in scoreboard output.
- Serialize queue batch launches with a repo-local lock.

**Non-Goals:**

- Do not weaken standard or adversarial review policy.
- Do not remove the existing monolithic planning runner or redesign crash recovery persistence.
- Do not store raw prompt text or route decisions from accounting data.
- Do not broaden queue selection beyond `pipeline:ready`.

## Decisions

- The compound planning runner will own lifecycle emission for its substages while the outer advance loop skips lifecycle wrapping for the `ready` dispatch. This avoids a risky persisted state-machine split while making artifacts truthful.
- `ready -> planning` will happen at the beginning of `runPlanningPhases`. The OpenSpec-specific change ID remains posted in the plan comment after artifact authoring, but the stage label changes before long work begins.
- A small shared OpenSpec consistency helper will hold the stale-delta logic currently embedded in pre-merge. `pre_merge.ts` and `fix.ts` will call the same helper so behavior stays identical.
- Prompt telemetry will be `prompt_chars` and `prompt_estimated_tokens`, computed from the prompt string before invocation and sanitized as non-negative integers. Raw prompts remain excluded from artifacts.
- Queue locking will use an exclusive file under `.agent-pipeline/locks`, with stale PID cleanup following the existing lock conventions where practical.

## Risks / Trade-offs

- Substage lifecycle emitted inside the planning runner can drift from outer loop lifecycle conventions -> Mitigation: introduce a small helper and tests that assert exact event order and outcomes.
- Moving `ready -> planning` earlier changes blocker stage for bootstrap failures -> Mitigation: document this as intended and cover it with regression tests.
- Fix-round stale-delta blocking could be noisy if broadened -> Mitigation: reuse the existing structured `category: spec-divergence` condition rather than prose inference.
- Queue batch locking reduces parallel operator entry points -> Mitigation: it only serializes queue selection/launch batches, not issue processing within one queue invocation.
