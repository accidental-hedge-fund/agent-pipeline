## Context

Today Agent Pipeline has three durable control layers for **item** work:

| Layer | Owns | Durable home |
| --- | --- | --- |
| Per-item advance (`pipeline-run` / stages) | One issue’s stage machine through `ready-to-deploy` | Issue run dir + labels + evidence |
| Durable multi-item loop (engine + store + supervisor) | Dependency-ordered whole-item dispatch, recovery budgets, ledger | `<state-home>/runs/<run-id>` |
| Recovery controller (#761) | Bounded recovery for blocked items | Recovery ledger on the run |

It does **not** own a restart-safe controller for the **factory lifecycle** that sits above those layers: intake → contract adoption → multi-item loop execution → optional operator merge/release preparation → engine pin/promotion observation. Factory plans have treated that outer orchestration as an agent’s job (session chat, Hermes, ad-hoc scripts). That creates a second scheduler and second store, loses authority on restart, and conflates outer-host identity with implementer/reviewer treatments (#784) and with “who is the controller.”

Related foundations this design consumes but does not rewrite:

- #784 outer-host lifecycle identity and registry
- #530 / living independent-scheduler specs (serial default + proven independence)
- #761 production recovery-controller integration
- #662 autonomous merge remains out of scope
- Durable loop sole-authority rules (no second ledger/lock/run-id namespace)

## Goals / Non-Goals

**Goals:**

1. Pipeline-owned macro-controller for coarse factory phases, **off by default**.
2. Immutable, canonically hashed execution-contract revisions with CAS adopt/replan.
3. Distinct identities: service controller, outer host, implementer, reviewer, privileged mutation actor.
4. Restart reconstructs phase + next action from durable evidence + live external truth.
5. Coarse actions are claim-before-side-effect and at-most-once under duplicate ticks.
6. Whole-item delegation only; no per-stage control path.
7. Concurrency budgets and independence proofs remain owned by the existing scheduler.
8. Injectable test seams covering the crash and CAS matrix in acceptance criteria.

**Non-Goals:**

- Autonomous merge, unattended release finalization, automated engine install/promote.
- Hermes (or any outer DB) as authoritative store or scheduler.
- Replacing loop engine, independent scheduler, or recovery controller.
- Multi-host distributed locks.
- Authority derived from labels, free-form prompts, profiles, or outer-host id alone.

## Decisions

### Decision 1 — Opt-in controller above loop/advance, not inside them

**Chosen:** A separate **factory macro-controller** module/API that:

- Is gated by an explicit enablement (config key and/or factory CLI entry point); default **disabled**.
- Owns coarse phase and next action for a **factory run** identity.
- Starts/resumes/observes existing durable **loop** (and, when the contract is single-item, advance) as **child** work.
- Never becomes a stage in the advance state machine and never imports stage transition verbs for item work.

**Rejected:** Encode factory phases as extra pipeline stage labels (pollutes the issue state machine).  
**Rejected:** Make the outer agent the durable authority and only “report” into Pipeline.

**Why.** Issue requires Pipeline as sole authority while preserving existing interactive and loop behavior when disabled.

### Decision 2 — Immutable execution-contract revisions + monotonic pointer

**Chosen:**

- Each **accepted** contract revision is an immutable document (write-once content) with a **canonical hash** over a defined body (excluding revision pointer metadata that is not part of the hashed contract content, if any such pointer fields exist — hash rules are explicit and tested).
- Replan creates a **new** revision document, records `replaces_revision` / prior hash, a structured **live-state reason**, and CAS-updates a single **current revision** pointer from `expected_revision` → `new_revision`.
- Overwrite of an accepted body is refused.

Minimum contract body fields (normative intent; exact JSON keys are implementation detail but must be present and validated):

| Area | Content |
| --- | --- |
| Repository | repo identity, base branch, observed base SHA at adoption/replan |
| Selection | selector, issue/PR ids, milestones, dependency edges |
| Linked runs | durable loop/run ids (and legacy-run identity mapping when importing) |
| Controller | service controller identity + revision number |
| Identities | outer-host id; implementer treatment; reviewer treatment; privileged mutation actor — all distinct |
| Fingerprints | authority-policy, engine-pin, configuration, treatment fingerprints |
| Phase plan | coarse phase, completion policy, next action |

**Rejected:** Mutable single contract file rewritten in place.  
**Rejected:** Chat transcript or Hermes row as the contract of record.

**Why.** Immutability + CAS is the only restart-safe way to replan without partial mutation or silent history loss.

### Decision 3 — Coarse phase machine (factory-level), not stage machine

**Chosen:** A small closed set of **coarse phases**, for example (names illustrative; living enum is single-sourced in code + specs):

1. `intake` / contract-draft
2. `adopted` (contract accepted; work not yet running)
3. `executing` (linked durable loop/advance active)
4. `items_complete` (all contracted items terminal per completion policy; ready-to-deploy frontier)
5. `merge_prepare` / `release_prepare` (operator-gated next actions only)
6. `engine_observe` / `promote_observe` (observe pin/FRG posture; no autonomous install)
7. `factory_complete` / `factory_stopped` (terminal)

Each tick:

1. Load current revision + action claims + child run links (durable).
2. Observe live truth (GitHub/git/config/child run state) through injected seams.
3. Derive phase + next action **deterministically** from (contract revision, durable claims, live truth).
4. Claim next coarse action if needed; dispatch at most once.
5. Append evidence attributing the action to controller+revision.

**Rejected:** Free-form phase strings from the outer agent.  
**Rejected:** Controller calling `advanceStage` / label swaps for item progression.

**Why.** Coarse phases are about factory lifecycle; item stages already have owners.

### Decision 4 — Distinct control identities (never collapse)

**Chosen:** Record five distinct identity slots on the contract and in evidence:

1. **Service controller** — which macro-controller implementation/version is reconciling (not a stage adapter).
2. **Outer host** — session host from #784 registry (claude/codex/grok/… or extension).
3. **Implementer treatment** — stage adapter/profile side for implementation work.
4. **Reviewer treatment** — stage adapter/profile side for review work.
5. **Privileged mutation actor** — who is allowed to perform privileged mutations (operator-bound; not inferred from labels).

Validators refuse:

- Missing required slots when factory mode is enabled.
- Equality rewrites that force controller id = outer host id = adapter id.
- Recording a non-Claude controller identity as `codex` (or any silent remapping table).

**Rejected:** Single `engine` string that means host + controller + implementer.  
**Rejected:** Inferring controller from default profile harness.

**Why.** Issue AC and #784 both fail closed on identity collapse.

### Decision 5 — CAS adopt/replan and claim-before-side-effect

**Chosen:**

- **Adopt:** `expected_revision == null | prior` and live identity matches expected base/repo → write revision N, set current = N.
- **Replan:** `expected_revision == current` and live reason present → write N+1 immutable body, CAS current N→N+1; on mismatch, fail with no new current and no partial ledger mutation beyond any aborted temp write.
- **Coarse actions:** durable claim record keyed by `(factory_run_id, revision, action_id)` moves `pending → claimed → completed|failed|ambiguous` before external side effects (child start). Duplicate ticks see existing claim and do not double-dispatch.

Crash matrix (tested with injected faults):

| Crash point | Resume behavior |
| --- | --- |
| Before claim | Re-derive; may claim cleanly |
| After claim, before child start | Reconcile claim; start child once if still needed |
| After child start | Observe child via durable loop/advance identity; do not start second child for same action |
| After ambiguous child result | Reconcile against live truth; record terminal claim outcome without inventing success |

**Rejected:** Best-effort “start child then maybe log.”  
**Rejected:** Conversation-memory resume tokens as authority.

### Decision 6 — Single Pipeline-owned factory namespace; link to loop runs

**Chosen:**

- Factory runs live under a Pipeline state home subpath (e.g. `<state-home>/factory/<factory-run-id>/`) with: current pointer, revisions/, action claims, events/evidence.
- Linked durable **loop** runs keep their existing store layout and remain the sole authority for item ledger transitions.
- Macro controller stores **links** (run ids + hashes) on the contract; it does not fork a second item ledger.
- Legacy loop/goal-loop run identities can be recorded for import/mapping but never become a second write authority.

**Rejected:** Hermes as ledger.  
**Rejected:** Storing factory authority only in GitHub issue comments.

**Why.** Matches durable-loop sole-authority doctrine while adding a higher-level durable home.

### Decision 7 — Concurrency non-widening

**Chosen:** Macro-controller never sets loop `concurrency.budget` above the policy already on the linked loop contract. Default remains one active item. If the linked contract has an explicit budget and independence proofs, the **independent scheduler** remains the admission authority; macro only starts/resumes the loop supervisor.

**Rejected:** Factory “speed mode” that force-sets budget > 1.

### Decision 8 — Locks stay host-local

**Chosen:** Factory run lock is host-local PID/file lock (domain + factory-run key), same single-host disposition as issue-run and loop locks. Document that two hosts can still race on GitHub labels; macro does not invent a distributed lock.

**Rejected:** Claiming cross-host mutual exclusion from PID files.

### Decision 9 — Testability via deps seams

**Chosen:** All external effects go through `FactoryMacroDeps` (names illustrative): GitHub reads, git base SHA, clock, contract store, lock, child loop start/status, optional advance start/status. Unit tests inject fakes; no real network/git/subprocess.

**Why.** Required by repo testing conventions and the crash-matrix AC.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Scope creep into autonomous merge/release | Spec non-goals + merge-authority-boundary delta; phases only emit operator next-actions |
| Second scheduler accidentally implemented in chat skills | Default-off + skill docs: when enabled, outer host only launches/ticks macro; does not re-order items |
| Contract schema drift vs loop contract | Explicit link fields + hash tests; do not duplicate item stage state into factory contract |
| CAS races under multi-process same host | Factory lock + CAS on revision pointer; tests for duplicate tick |
| Identity collapse under “engine=codex” shorthand | Validators + golden tests for distinct slots |
| Operators enable factory mode expecting multi-host safety | Docs state single-host lock scope |

## Migration Plan

1. Ship schema + controller **disabled by default**; no behavior change for existing commands.
2. Add opt-in config/CLI for factory runs in control repo / dogfood only.
3. Optional import path for legacy loop run ids into link fields (read/map only).
4. Rollback: disable flag; factory dirs remain readable but unused; loop/advance unaffected.

## Open Questions

1. **Exact coarse-phase enum names** — finalize during implementation against factory dogfood scripts; keep closed enum in one module.
2. **CLI surface naming** — `pipeline factory …` vs config-only enable under existing loop entry; choose during tasks without expanding non-goals.
3. **Whether single-item factory runs may link advance-only (no loop)** — allowed if contract marks single-item and still uses whole-item handoff; prefer loop for multi-item always.
4. **Engine promote observe vs FRG pin writer** — observe-only in this change; pin mutation remains factory-two-track / operator surfaces.
