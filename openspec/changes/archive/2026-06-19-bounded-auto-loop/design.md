## Context

The advance loop (`pipeline.ts`, the `for (let i = 0; i < MAX_ITERATIONS; i++)` body) dispatches one stage per iteration and either advances (incrementing a transition count) or stops on a non-advancing outcome: `blocked`, `waiting`, `no-op`, `finalized`, `error`. Many `waiting`/`blocked` stops are *recoverable and pipeline-owned* — a flaky test rerun, a stale-branch rebase, a reviewer/shipcheck finding fix — yet they require a human (or scheduler) re-invoke. Issue #149 adds an opt-in, budgeted way to auto-continue through those recoverable stops, then park with evidence. The hard-won convergence and safety machinery (review-loop-recurrence early-park #133, ceiling park, `review_policy`, `--override`, never-auto-merge floor, `harness_sandbox`, evidence bundle) must all remain authoritative — the auto-loop sits *outside* them as a bounded continuation governor, never a bypass.

## Goals / Non-Goals

**Goals**
- Reduce manual nudges for routine recoverable failure classes within explicit, falsifiable budgets.
- Keep the default (non-`auto_loop`) path byte-for-byte unchanged.
- Make every automatic continuation auditable (rationale + remaining budget) and bound the loop with both a round count and a wall-clock ceiling.
- Inherit, not re-implement, the existing safety/convergence guarantees.

**Non-Goals**
- Replacing human approval for merge/deploy (the pipeline still stops at `ready-to-deploy`; no merge stage exists).
- Running forever as a background daemon.
- Letting a model decide to expand scope beyond the issue (surgical-fix discipline #235 still applies).
- New review backends, new stages, or new state-machine edges.

## Decisions

**Decision: a new `bounded-auto-loop` capability + an `auto_loop` config block, not a rewrite of the state-machine baseline.**
The new behavior is expressed as its own capability that *augments* the `pipeline-state-machine` "Bounded advance loop" requirement (mirroring how `config-inert-models-warn` augments config loading "without changing validation … or the safety floor"). The baseline stop semantics stay intact; the auto-loop only changes what happens on a *recoverable* stop at an *allowlisted* stage when enabled. This keeps the never-auto-merge structural guarantee and `MAX_ITERATIONS` cap untouched and reviewable in isolation.

**Decision: budgets are an outer governor, composed with — not replacing — `max_adversarial_rounds`.**
`review_policy.max_adversarial_rounds` continues to bound review re-runs *within* a round. `auto_loop.max_rounds` bounds how many *recoverable-stop continuations* the run performs before parking; `auto_loop.max_wallclock_minutes` bounds elapsed time. Two independent budgets so a fast-failing flaky test can't burn the wall-clock and a slow single recovery can't exceed it silently. The first budget to exhaust parks the run.

**Decision: recoverability is derived from existing signals, not a new taxonomy.**
A stop is recoverable iff it is `waiting`, or `blocked` with a `BlockerKind` that already has a pipeline-owned recovery recipe (`BLOCKER_RECIPES` / the `auto_recover` path). The `stages` allowlist further gates *where* auto-continuation is permitted. This reuses the existing blocker-kind model rather than inventing a parallel classification, and keeps `error`/`no-op`/`finalized` and recipe-less blockers as hard stops.

**Decision: human checkpoints are hard stops the budget cannot cross.**
`needs-human` (ceiling, `ceiling_action`, or recurrence early-park #133) and the plan-review human-feedback gate (#23) stop the loop immediately, with budget remaining or not. The auto-loop never relabels away from `needs-human`; resumption stays on the existing `--override` path. This is the crux of "useful autonomy without new shipping authority."

**Decision: recurrence early-park is the anti-churn mechanism, reused as-is.**
Rather than a new "same-finding counter," the auto-loop relies on `review-loop-recurrence`: a blocking finding that recurs after a fix already early-parks at `needs-human`. The auto-loop simply must not re-budget around that park. This guarantees a single finding cannot churn to the budget ceiling and reuses a tested, drift-guarded mechanism.

**Decision: wall-clock uses an injected clock seam.**
Budget timing reads `deps.now()` (injected), so unit tests assert budget exhaustion deterministically with a fake clock and perform no real time, network, git, or subprocess calls — consistent with the `AdvanceReviewDeps` / `ShaGateDeps` seam pattern.

**Decision: continuation records reuse the evidence bundle recovery-event path.**
Each continuation writes a recovery/continuation event (recoverable class, rounds remaining, wall-clock remaining) — the evidence bundle already records recovery events, so no `schema_version` break — and surfaces a run-comment line. Writes are non-fatal (bundle writes are already non-fatal by spec).

## Risks / Trade-offs

- *Auto-continuation could mask a genuinely stuck run.* Mitigated by the two budgets + the always-evidence handoff at exhaustion; the run lands at `needs-human` with what was attempted and what remains, never silently.
- *A recoverable class could loop on a non-converging condition that isn't a review finding* (e.g. a perpetually flaky test). Mitigated by `max_rounds`/`max_wallclock_minutes` and the requirement that each continuation be a distinct pipeline-owned recovery; the budget is the backstop.
- *Default-unchanged must be provable, not assumed* — there is no `tsc` gate, so a regression test SHALL diff the advance-loop trace with `auto_loop` absent against the pre-change behavior to prove the default path is untouched.
- *Misconfiguration could over-grant autonomy.* Mitigated by strict schema validation (unknown keys / bad types / unknown stages rejected) and the structural absence of any merge/deploy/publish/step-disable key under `auto_loop`.
