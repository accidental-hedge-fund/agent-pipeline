## Context

Agent Pipeline already advances issues to `pipeline:ready-to-deploy`, merges one PR via `pipeline merge`, and can run multi-item loops with dependency ordering (#905 / durable-run dependency integrity). Default loop completion is ready-to-deploy: a dependent may start while a prerequisite PR is still unmerged. That breaks dependent implementation that must build on integrated `main`.

The Hermes factory pilot under `ops/hermes-factory` was **removed** from the product tree (#921). Product direction is the factory simplification plan: integrate trains live in the Pipeline CLI; external supervisors stay thin.

**Implementation (PR #922):** `core/scripts/stages/train.ts` + `pipeline train` CLI. Advance uses `runSingleIssueCommand`; merge uses `mergePr`; containment uses `git merge-base --is-ancestor` of the PR merge commit vs `origin/<base>`.

Living specs already describe a `merged` item state and a merge barrier in the durable loop engine, but the engine does not call merge; train mode supplies merge evidence for an explicit operator-authorized run.

## Goals / Non-Goals

**Goals:**

- One operator-facing command to run an ordered issue list or milestone as an integrate train.
- With `--merge`: advance → merge via existing merge surface → squash-aware base containment → next item.
- Without `--merge`: behave like a thin sequential loop to ready-to-deploy only (compat / dry path).
- Capacity 1 when integrate/merge mode is active.
- Pause on `needs-human`, blockers, failed merge gates, or unprovable containment; resume without inventing authority.
- Machine-readable train status/events for thin supervisors (Buzz/Hermes).
- Preserve advance-loop isolation and forbid `auto_merge` config.

**Non-Goals:**

- Macro-controller, grant schemas, privilege brokers, MCP (#890, #899, #907).
- Hybrid FRG, pin promote, install, rollback as part of train.
- Parallel integrate trains against the same base (serial integrate is the feature).
- Changing default `pipeline loop` completion policy for all runs.
- Replacing `pipeline merge` gates or teaching release-PR merge in this change (Phase 3).
- Extending `ops/hermes-factory`.

## Decisions

### 1. New `pipeline train` command, not silent loop flag default

**Choice:** Register `train` as a first-class subcommand with explicit `--merge` (and later optional `--release`).

**Why:** Merge authority must be visible at the invocation site. A default-off flag on `loop` is acceptable as an alias later, but a named command makes docs and isolation tests clearer.

**Alternatives:** Only `loop --after-ready merge` (#765 shape); rejected as the sole surface because train ownership and status benefit from a dedicated verb. Implementation may still compose loop primitives.

### 2. Compose existing primitives; do not rewrite the durable loop

**Choice:** Train module sequences:

1. Resolve work list (milestone / issue list / deps via existing discovery).
2. For each item: call existing single/advance path (or loop item dispatch) to terminal ready or park.
3. If `--merge`: resolve linked PR → call shared merge implementation used by `pipeline merge` → observe `mergeCommit.oid` → fetch base → prove containment → record barrier clear → next.

**Why:** Avoid a third scheduler. Reuse merge gates and dep graph.

**Alternatives:** Full #901 completion-policy rewrite of the loop; deferred. Minimal train composition ships value without rewriting supervisor invariants.

### 3. Squash-aware containment proof

**Choice:** After merge, bind reviewed head to the PR, then require the PR's merge-result commit (squash merge commit) to be an ancestor of (or equal to, for a frozen tip policy) freshly fetched `origin/<base>`. Do not require the PR head to be an ancestor of base.

**Why:** Proven correct in the pilot; squash merges break head-as-ancestor proofs.

### 4. Train ledger is Pipeline + GitHub, not a second journal

**Choice:** Persist train identity under the existing loop/run-store conventions (or a thin train run record that points at loop run ids and issue PRs). On restart, reconcile from GitHub labels, PR merge state, and base tip — not from chat memory.

**Why:** Pilot dual ledgers produced ambiguous advance vs merge records.

### 5. Authority model

**Choice:** Invoking `pipeline train --merge` is session-bound operator (or supervisor) authority for that process, same class as typing `pipeline merge` repeatedly. Docs and golden rules list it as loop-isolated. No repository config enables it.

**Why:** Matches product honesty; pilot grant crypto on same UID was theater.

### 6. Status export

**Choice:** `pipeline train status --json` (or train events on the existing events stream) listing: train id, ordered issues, current issue, stage, PR, last merge result, next action, blocker. Thin Hermes only reads this.

**Why:** Phase 2 notifier needs a stable read model without #890.

## Risks / Trade-offs

- **[Risk] Mid-stage process death (plan-review resume)** → Mitigation: document as hard engine prerequisite; ship ownership/resume fixes alongside or before relying on train in production; train must fail closed and report ownership split rather than replan destructively.
- **[Risk] Serial train is slow** → Acceptable; correctness of base integration over throughput.
- **[Risk] Unrelated main advancement between items** → Containment fails closed; operator rebases or restarts train with fresh observation.
- **[Risk] Confusion with outer factory pilot** → Docs mark pilot frozen; train is the product path.
- **[Risk] Scope creep into release finish / FRG** → Keep `--release` out of this change or stub as “prepare only / not implemented” until Phase 3.

## Migration Plan

1. Land OpenSpec change + docs (factory simplification plan already approved).
2. Implement train command behind full unit tests; default loop unchanged.
3. Update README / golden-rule text to name `train --merge` as opt-in surface.
4. Retriage GitHub issues #901/#765 to point at this change; park #890-family as non-blockers.
5. Phase 2 Hermes skill switches from grant runner to `pipeline train` / `pipeline single`.
6. Do not remove `ops/hermes-factory` in this change; freeze only.

Rollback: leave `train` unused; advance/loop/merge paths unchanged.

## Open Questions

- Exact CLI: `pipeline train` vs `pipeline loop train` namespace — prefer top-level `train` for discoverability.
- Whether first slice supports only explicit issue lists (simpler) before milestone selectors — prefer both if discovery already exists; otherwise ship issue list + milestone in one PR if tests stay tight.
- How strictly base tip must equal merge commit vs only contain it when other commits land on main — prefer **containment** (ancestor check) for multi-operator repos; equal-tip only as optional strict mode.
