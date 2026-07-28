# Harness and model evaluation — 2026-07-28

## Recommendation

Use Grok Build as the primary harness and Codex as the independent secondary
reviewer:

```yaml
harnesses:
  implementer: grok
  reviewer: codex

models:
  planning: grok-4.5
  implementing: grok-4.5
  review: gpt-5.6-terra
  fix: grok-4.5

effort:
  planning: high
  implementing: high
  review: high
  fix: high
```

This policy is independent of the invoking host profile.

## Decision evidence

The final comparison ran the complete stage graph—planning, independent plan
review, plan revision, implementation, review/fix round one, and review/fix
round two—over five deterministic agent-pipeline fixtures and three
replicates per policy. The candidates were compared apples-to-apples within
that campaign, but the campaign predated the production-prompt reconciliation
described below; treat the ranking as migration evidence, not a
byte-for-byte production simulation.

| Policy | Completed | Mean quality | Mean duration |
|---|---:|---:|---:|
| Grok 4.5/high → Grok 4.5/high | 15/15 | 0.850 | 505 s |
| **Grok 4.5/high → Codex Terra/high** | **15/15** | **0.817** | **460 s** |
| Grok 4.5/high → Codex Terra/max | 15/15 | 0.767 | 715 s |
| Codex Sol/max → Codex Terra/max (clean recovery) | 15/15 | 0.667 | 1,262 s |
| Codex Sol/max → Grok 4.5/high (clean recovery) | 15/15 | 0.600 | 901 s |
| Codex Luna/low → Grok 4.5/high | 15/15 | 0.567 | 399 s |
| Codex Luna/low → Codex Terra/max | 15/15 | 0.567 | 519 s |
| Codex Luna/low → Codex Terra/high | 15/15 | 0.533 | 278 s |

Grok→Grok produced the highest raw quality, but its +0.033 fixture-level
quality delta over Grok→Codex Terra/high had a confidence interval touching
zero, while taking about 10% longer and removing cross-provider independence.
Terra/max did not buy quality in the end-to-end corpus: it was about 55% slower
than Terra/high and scored lower.

The recommended pair is therefore the best operational balance: near-top
quality, lower latency, and an adversarial reviewer from a different provider.

## Screens

- Primary family: 90 cells—Grok 4.5/high plus every supported effort for
  GPT-5.6 Sol and Terra (low through ultra) and Luna (low through max), over
  five fixtures.
- Reviewer harness: 6 cells—Codex Terra/high versus Grok 4.5/high.
- Reviewer model/effort: 54 cells—the same 18 supported reviewer coordinates,
  three replicates on the seeded-defect review fixture.
- Final validation: 135 cells—three primary finalists × three reviewer
  finalists × five fixtures × three replicates.
- Recovery validation: 30 cells—clean reruns of the corrected
  Sol/max→Grok/high treatment and timeout-censored Sol/max→Terra/max treatment.

No experiment observed a provider rate-limit error. The recovery experiment
completed 30/30 cells with no infrastructure, authentication, or timeout
failure.

## Evaluator correction

The first final-validation pass exposed an evaluator fidelity defect:
`pipeline-paired` used `policy.effort.planning` for Grok plan-review even when
the deployable structured reviewer override required `high`. The evaluator now
accepts reviewer-coordinate `model`/`effort` overrides and applies them to
plan-review and both review rounds, matching `review_harness` production
configuration. A regression test covers Codex Sol/max → Grok/high.

The original 15 deterministic configuration failures and six 30-minute
timeouts were excluded from quality comparison. Both affected treatments were
rerun from scratch under the corrected evaluator and a 60-minute ceiling.

The subsequent code reconciliation found a second fidelity gap: the
pipeline-paired graph carried the right live artifacts but used simplified
eval-only wording instead of the production prompt builders, and it described
review-2 findings as final even when fix-2 changed the worktree afterward.
The reconciled evaluator now shares all eight production prompt contracts,
enforces the production plan output gates and review policy, passes review-1
context into adversarial review-2, keeps the eval contract installed during
review, and labels review-2/pre-fix-2 evidence separately from the final
post-fix-2 diff. Existing campaign scores were not rewritten or presented as
if they had run under that newer prompt fingerprint.

## Limitations and next gate

Five fixtures and three replicates are enough for a bounded migration
recommendation, but not a permanent universal ranking. Cost telemetry was
unavailable, the corpus is specific to agent-pipeline maintenance tasks, and
OpenSpec planning was not a campaign dimension. The next comparable campaign
should rerun the baseline and finalists under the reconciled production-prompt
fingerprint. Before making the configuration global, also run a bounded live
issue through the recommended policy and confirm CI plus the deployed/staging
outcome.

Durable artifacts:

- `.agent-pipeline/evals/pipeline-primary-family-screen-20260728/summary.json`
- `.agent-pipeline/evals/reviewer-model-effort-screen-20260728/summary.json`
- `.agent-pipeline/evals/pipeline-finalists-validation-20260728/summary.json`
- `.agent-pipeline/evals/pipeline-finalists-recovery-20260728/summary.json`
