# Harness Pair Pilot — 2026-07-27

## Scope

This bounded pilot compared the current production-equivalent baseline with every ordered pair available on this machine:

| Treatment | Primary | Reviewer |
| --- | --- | --- |
| `claude-sonnet__codex-default` | Claude / Sonnet | Codex / default |
| `codex-default__grok-4-5` | Codex / default | Grok / grok-4.5 |
| `grok-4-5__codex-default` | Grok / grok-4.5 | Codex / default |
| `codex-default__codex-default` | Codex / default | Codex / default |
| `grok-4-5__grok-4-5` | Grok / grok-4.5 | Grok / grok-4.5 |

Each pair ran once against two frozen, independently checkable implementation tasks in a fresh worktree. The evaluator forbade GitHub writes, used a 900-second shared deadline, and recorded final deterministic checks plus review convergence. Raw evidence is ignored local output at `.agent-pipeline/evals/harness-pair-pilot-20260727b/`.

## Results

| Treatment | Correct tasks | Mean harness time | Review convergence | Caveat |
| --- | --- | ---: | --- | --- |
| Claude → Codex (baseline) | 2/2 | 217.9 s | 1 blocker; 0 cleared | 2 out-of-scope generated-plugin changes |
| Codex → Codex | 0/2 | 86.9 s | 2 blockers; 0 cleared | Failed both hidden acceptance checks |
| Codex → Grok | 0/2 | 113.5 s | 2 blockers; 1 cleared | One malformed final review |
| Grok → Codex | 2/2 | 129.0 s | 1 blocker; 1 cleared | 3 out-of-scope changes across two cells |
| Grok → Grok | 2/2 | 114.9 s | no blockers | One malformed final review; no independent review-recall evidence |

All 10 cells completed without authentication, timeout, or infrastructure errors. The comparative intervals are explicitly underpowered (`n=2` per treatment), so these observations do not authorize a production routing change.

## Decision

Do **not** migrate the production primary harness yet.

This pilot does **not** select a finalist. Subsequent trajectory audit found that every Codex-primary implementation attempt was blocked before repository access by the nested Codex sandbox (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`). Their zero-change/failed-check outcomes are infrastructure failures, not Codex-quality evidence. Grok-primary cells still demonstrate narrow two-fixture implementation capability, but the corpus and reviewer screen remain underpowered; no production routing conclusion follows.

## Direct reviewer screen

After repairing the native review-mode prompt to require the structured production verdict (#606), Codex and Grok each reviewed a seeded-defect fixture twice. This screen is also underpowered, but it is disqualifying evidence for a routing change:

| Reviewer | Replicate results | Mean duration | Reliability concern |
| --- | --- | ---: | --- |
| Codex / default | recall 0.0, precision 0.0 in both runs | 23.7 s | Missed both seeded defects in both runs |
| Grok / grok-4.5 | 0.0 recall in one run; 0.5 precision/recall in one run | 58.5 s | One malformed verdict; inconsistent defect detection |

Neither reviewer has sufficient measured recall to be promoted as a safe independent secondary. The pair-pilot finalist remains a throughput hypothesis only, not a production recommendation.

## Required follow-up

1. Add at least four independent implementation fixtures, including regression/fix and multi-file tasks.
2. Run three replicates for Claude → Codex, Grok → Codex, and Grok → Grok on the same frozen population.
3. Run the seeded review fixture as a role screen for Codex and Grok reviewers, measuring precision/recall separately from pair convergence.
4. Discover supported effort values, then vary only documented valid efforts for the finalists.
5. If a reviewer meets a predeclared recall/reliability floor on the expanded seeded corpus and Grok → Codex remains non-inferior on correctness, conduct a limited live pipeline pilot before editing production routing.
6. First implement enforced evaluator isolation (#607): explicit external-sandbox handling for Codex, an eval-specific instruction contract, and command boundaries that prevent repository workflow instructions from launching nested worktrees or pipeline runs.
