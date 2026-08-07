## Why

Agent Pipeline already owns a durable per-item advance controller and a durable multi-item loop, but it has no restart-safe **repository-level factory lifecycle** that spans intake, execution-contract adoption, loop execution, later merge/release phases, and engine promotion. The factory plan currently leaves that coarse lifecycle to an outer agent (chat session, Hermes, or other host scheduler). That duplicates Pipeline’s durable ledger/lock model and makes conversation or host-local databases a second execution authority — which fails on restart, concurrent ticks, and cross-engine handoff.

## What Changes

- **Factory macro-controller (opt-in).** Add a Pipeline-owned macro-controller that is **disabled by default**. When off, interactive `pipeline` / `single` / `loop`, merge, and release behavior is unchanged. When on, the controller is the sole coarse-phase authority for a factory run.
- **Immutable execution-contract revisions.** Introduce a versioned, canonically hashed execution contract that captures repository/base identity and observed base SHA; selector, issue/PR identities, milestones, and dependency edges; linked durable loop/run identities; controller identity and revision; outer-host identity separate from implementer/reviewer treatments; authority-policy, engine-pin, configuration, and treatment fingerprints; and the current coarse phase, completion policy, and next action. A replan **retains a new revision** with its live-state reason; it never overwrites an accepted contract body.
- **Compare-and-set adoption and replan.** Adoption and replan use CAS against the expected current revision. Stale expected revision or changed live identity fails closed with no partial mutation.
- **Restart-safe reconciliation.** Each tick reconstructs coarse phase and next action from durable evidence plus freshly observed external truth (GitHub, git, config, durable run state) — never conversation memory.
- **Delegation-only item work.** The controller defines coarse phase and next deterministic action, then delegates whole items to the existing durable loop / advance controllers. It MUST NOT invoke a per-stage transition, set stage labels, or replace the independent scheduler / recovery controller.
- **Distinct control identities.** Service controller, outer host, implementer, reviewer, and privileged mutation actor are distinct fields. A non-Claude controller is never silently recorded as Codex (or any other host).
- **Monotonic revision surface.** The current controller revision is monotonic and readable by status/evidence consumers.
- **At-most-once coarse actions.** Duplicate/concurrent ticks claim coarse actions so each is dispatched at most once; crash-before-claim / after-claim / after-child-start / after-ambiguous-child-result are first-class test cases.
- **Concurrency non-widening.** Default active-item behavior remains one; any existing explicit concurrency policy and proven-independence rules remain authoritative. This controller does not raise concurrency budgets.
- **Evidence and docs.** Run evidence and operator docs record which controller/revision owned every coarse action.

**Non-goals (explicit):**

- Autonomous merge, release finalization, engine installation automation, or Hermes integration.
- Replacing the dependency/ownership scheduler or the production recovery controller (#761).
- Granting authority from labels, prompts, profiles, or outer-host identity.
- Promoting host-local PID locks into distributed/multi-host locks.
- Unattended merge (#662 shadow-qualification remains a separate gate).

## Capabilities

### New Capabilities

- `factory-macro-controller`: Disabled-by-default Pipeline-owned factory lifecycle controller; immutable execution-contract revisions with canonical hashing; CAS adopt/replan; distinct control identities; monotonic current revision; restart-safe reconciliation from durable evidence + live external truth; coarse phase and next-action derivation; at-most-once coarse action claims; whole-item delegation only to durable loop/advance; concurrency non-widening; injectable test seams for crash/replan/stale/duplicate/legacy-run cases; evidence that attributes coarse actions to controller+revision.

### Modified Capabilities

- `outer-host-lifecycle-contract`: Clarify that outer-host identity remains distinct from the factory **service controller** identity (in addition to existing implementer/reviewer separation), and that outer-host identity MUST NOT be rewritten to equal the service controller or any stage treatment.
- `durable-loop-engine`: Link macro-owned factory runs to native loop contracts without introducing a second authoritative ledger, lock, or run-id namespace; macro-linked loop runs remain sole-authority under the existing engine rules.
- `durable-run-independent-scheduler`: Affirm that factory macro-controller activation does not alter the serial default or proven-independence concurrency admission rules.
- `merge-authority-boundary`: Affirm that the macro-controller’s later merge/release **phases** only prepare operator-facing next actions and do not perform autonomous merge or release finalization.

## Impact

- **New modules (intent):** factory macro-controller service, execution-contract schema/revision store, CAS adopt/replan API, coarse-phase reconcilers, action claim ledger — under `core/scripts/` with injectable `deps` seams (GitHub, git, clock, filesystem/run-store, child loop/advance start).
- **Durable storage:** a Pipeline-owned factory ledger/run namespace (not Hermes DB, not agent chat, not a second loop engine). Coexists with existing durable loop store paths; must not write into external goal-loop state homes.
- **CLI / config:** opt-in enablement (config flag and/or explicit factory command surface); default remains off so existing interactive and loop paths are behavior-identical.
- **Evidence / status:** status and evidence bundles expose controller id, revision, coarse phase, next action, and which revision owned each coarse action.
- **Locks:** host-local factory lock (domain-scoped, single-host semantics preserved); no claim of cross-host mutual exclusion.
- **Tests:** unit tests with injected seams covering crash points, replan, stale revision, duplicate tick, and legacy run identity — no real network/git/subprocess in unit tests.
- **Docs / mirror / CI:** operator docs for opt-in factory lifecycle; regenerate `plugin/` when `core/` or host packaging changes; `node scripts/build.mjs` and `npm run ci` green.
- **Out of scope code:** autonomous merge executor, release tag automation as unattended finalization, Hermes adapters, multi-host lock redesign, scheduler/recovery rewrites.

## Acceptance criteria

Observable, falsifiable outcomes that make #890 done:

- [ ] With the macro-controller disabled (default), existing interactive `pipeline` / `single` / `loop`, merge, and release command outcomes match pre-change behavior for the same inputs (no new required flags, no extra durable factory state required).
- [ ] Enabling the macro-controller uses exactly one Pipeline-owned execution contract, ledger/run namespace, lock, and action history for a factory run; no outer host, Hermes database, or agent chat is consulted as an authoritative scheduler or store.
- [ ] An accepted execution-contract revision is immutable: its body is unchanged after accept; a replan produces a **new** retained revision with a live-state reason and advances the monotonic current revision pointer via CAS.
- [ ] Every accepted revision is canonically hashed and records at minimum: repository/base identity and observed base SHA; selector, issue/PR identities, milestones, and dependency edges; linked durable loop/run identities; controller identity and revision; outer-host identity separate from implementer and reviewer treatments; authority-policy, engine-pin, configuration, and treatment fingerprints; coarse phase, completion policy, and next action.
- [ ] Service controller, outer host, implementer, reviewer, and privileged mutation actor are distinct identity fields; recording a non-Claude controller as Codex (or collapsing controller into any stage treatment) is impossible under the schema/validators.
- [ ] Read-only status/evidence APIs expose the current monotonic controller revision without requiring a mutating tick.
- [ ] Adopt/replan with a stale expected revision or a changed live identity fails closed and leaves contract, ledger, and action history partially unmodified (no half-applied replan).
- [ ] Two concurrent or duplicate ticks for the same coarse action result in at most one dispatch of that action (claim-before-side-effect).
- [ ] After process death at each of: before claim, after claim, after child start, after ambiguous child result — a restart reconstructs phase and next action from durable evidence plus freshly observed external truth and does not rely on conversation memory.
- [ ] The controller can start/resume/observe whole durable loop (or advance) runs for contracted items but has no API path that invokes a per-stage transition or stage-label write for item work.
- [ ] With no explicit concurrency policy, factory-driven work still schedules at most one active item; when an explicit concurrency policy and proven-independence rules exist, those rules remain authoritative and the macro-controller does not raise the budget.
- [ ] Unit tests inject GitHub/git/clock/service seams and cover crash-before-claim, crash-after-claim, crash-after-child-start, crash-after-ambiguous-child-result, replan, stale revision, duplicate tick, and legacy run identity.
- [ ] Run evidence (and operator documentation) attributes every coarse action to the owning controller identity and revision.
- [ ] `node scripts/build.mjs` (including `--check` in CI) and `npm run ci` pass with generated mirrors current.
