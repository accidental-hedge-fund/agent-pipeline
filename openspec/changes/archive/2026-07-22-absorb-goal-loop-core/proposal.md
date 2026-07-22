## Why

`pipeline:loop` (#451) shipped as a **facade**: Pipeline normalizes arguments, runs a
read-only `loop:contract-coherence` check against a *separately installed* goal-loop skill,
then prints a selector for the calling agent to hand to that skill. Every durable
concern — contract compilation, ledger, lock, recovery budgets, reconciliation, dependency
ordering, authority gates, resume — lives in a second repository, in a second language
(Python `state.py`, 743 lines), behind a second install surface, on a second release
cadence.

That split has already cost real convergence. `checkLoopContractCoherence` exists solely to
detect version skew between the two products; `discoverGoalLoop` greps a *foreign repo's
source file* for `CONTRACT_SCHEMA = "..."` to learn its schema id. The headline command of
v1.21.0 refuses to start on any host that has not separately installed and version-matched
another package. goal-loop v0.3.0 (native-`/goal` self-attestation) is still unmerged on that
side, so Pipeline's supported set is pinned to `contract@2` while the capability Pipeline's
own preflight requires lives in `@3`.

The product decision recorded on #508 resolves the split: **Agent Pipeline becomes the sole
implementation and canonical product surface for durable multi-item orchestration.** This
change moves the durable state engine in-repo and retires the external dependency.

## What Changes

- **Add an in-repo durable loop store** (`core/scripts/loop/`): state-home resolution, run
  directory layout, atomic JSON writes, append-only `events.jsonl` / `decisions.jsonl`,
  exclusive locking with liveness-based staleness and non-destructive recovery, and the
  read-only `status` / `audit` projection. A dedicated module — **not** an advance-stage
  handler, and not reachable from the per-item advance loop.
- **Add an in-repo durable loop engine**: contract compilation (selector → normalized,
  dependency-ordered, canonically hashed contract), the item state machine and its exact
  legal transition graph, recovery budgets and stop conditions, the merge barrier,
  dependency topological ordering, the four authority gates (`push_pr`, `merge`, `release`,
  `deploy`), the agent-pipeline execution mandate, the native-`/goal` evidence mandate
  (goal-loop v0.3.0's capability), and reconciliation against caller-observed live truth.
- **Repoint the `pipeline:loop` facade** at the in-repo engine. `pipeline:loop` runs with no
  goal-loop skill installed anywhere on the host.
- **Add a one-way, non-destructive import** for existing goal-loop runs
  (`goal-loop/contract@2`, `@3`, `goal-loop/ledger@2`) so in-flight runs survive the cutover,
  supported for a defined migration window. Legacy run directories are read, never rewritten.
- **BREAKING**: retire `loop:contract-coherence` as an *external-install* check. `pipeline
  doctor` no longer fails because goal-loop is absent, and Pipeline no longer reads another
  package's `state.py` or `.goal-loop-manifest.json` to learn a schema id. The check is
  replaced by an in-repo store-compatibility check over the run's own recorded schema id.
- **BREAKING**: Pipeline SHALL NOT invoke the external goal-loop CLI on any path. The
  requirement forbidding Pipeline from owning a durable state engine is inverted: Pipeline
  now owns exactly one, and it is the only authoritative one.

Out of scope (deliberately): deleting or archiving the goal-loop repository itself (a
separate repo, not this change's diff), and any change to Pipeline's merge boundary — the
loop still stops every item at `pipeline:ready-to-deploy` and never merges.

## Capabilities

### New Capabilities

- `durable-loop-store`: the on-disk durable substrate — state home, run directory layout,
  atomic and append-only write discipline, exclusive locking and lock recovery, event and
  decision logs, and the read-only status/audit projection.
- `durable-loop-engine`: the orchestration semantics over that store — contract compilation
  and canonical run identity, dependency ordering, the item transition graph, recovery
  budgets and stop conditions, authority gates, the pipeline and native-`/goal` evidence
  mandates, the merge barrier, and reconciliation.
- `goal-loop-run-import`: read compatibility and one-way import for runs created by the
  external goal-loop skill, plus the bounded migration window and its removal condition.

### Modified Capabilities

- `pipeline-loop-facade`: the facade's durable-state delegation target changes from "the
  installed goal-loop store" to the in-repo engine; the preflight's external
  `loop:contract-coherence` step is replaced by an in-repo store-compatibility check; the
  legacy `/goal-loop` alias requirement is restated against the in-repo engine; and the
  requirement deferring consolidation is removed, having been decided by #508.

## Impact

- **New**: `core/scripts/loop/` (store, engine, contract, ledger, lock, events,
  reconciliation, import) and its co-located `core/test/loop-*.test.ts` coverage.
- **Changed**: `core/scripts/loop-preflight.ts` (external discovery + coherence removed,
  in-repo store check added; the native-`/goal` capability probe and argument normalization
  are untouched), `core/scripts/pipeline.ts` (`runLoopCommand` executes rather than prints a
  hand-off selector), `core/scripts/stages/doctor.ts` (loop check rewired),
  `core/scripts/loop-execution-contract.ts` (`pipeline/loop-execution@1` unchanged in
  meaning; its orchestrator side is now in-repo).
- **Removed**: `GOAL_LOOP_SUPPORTED_CONTRACT_SCHEMAS` / `GOAL_LOOP_SUPPORTED_LEDGER_SCHEMAS`,
  `goalLoopDiscoveryRoots`, `discoverGoalLoop`, `checkLoopContractCoherence` and their tests.
- **Docs**: `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` (the loop section describes an
  in-repo engine and drops the install prerequisite), README.
- **Generated**: `plugin/` mirror regenerated via `node scripts/build.mjs`.
- **External**: the goal-loop repository stops being a runtime dependency of Pipeline. No
  file in this repo executes `state.py`.

## Acceptance criteria

- [ ] On a host with **no** goal-loop skill installed at any discovery root
      (`~/.claude/skills/goal-loop`, `~/.codex/skills/goal-loop`, `~/.agents/skills/goal-loop`),
      `pipeline loop --milestone <m>` compiles a contract, initializes a run, acquires a lock,
      and reports a run id — with no `goal-loop` install-remediation error on any path.
- [ ] `grep -rn "goal-loop" core/scripts` returns no discovery, manifest-read, `state.py`
      parse, or subprocess invocation of the external skill; the only surviving matches are
      the import/compatibility module and its documentation.
- [ ] `pipeline doctor` passes on a host without goal-loop installed, and its loop check
      reports the in-repo engine's store schema ids rather than a foreign package's version.
- [ ] A run directory written by goal-loop `state.py` (`contract@2` or `@3` + `ledger@2`,
      mid-run, with items in `pending`/`in_progress`/`blocked`) is imported by
      `pipeline loop --resume <run-id>` and resumes from its existing item states, history,
      recovery budgets, consecutive-blocked count, and merge barrier.
- [ ] The import never mutates the legacy run's `contract.json`, `ledger.json`,
      `events.jsonl`, or `decisions.jsonl`; a byte-comparison of those files before and after
      import is identical.
- [ ] Import refuses, with zero writes, when the legacy run's lock is held by a live process.
- [ ] After import, the legacy run is marked superseded such that a second import of the same
      run id is refused rather than producing a divergent second run.
- [ ] The full goal-loop transition graph is enforced: every legal edge succeeds and every
      illegal edge (e.g. `merged → blocked`, `deployed → in_progress`, `pending → merged`) is
      refused, proven by a table-driven test over all state pairs.
- [ ] An authority gate that the contract does not grant refuses the transition, and no
      objective or selector text can widen a grant.
- [ ] A gated transition without directly-verified evidence is refused; `→ ready` requires
      `pipeline:ready-to-deploy` evidence and `→ merged` requires a pipeline-merge SHA.
- [ ] The native-`/goal` evidence mandate (goal-loop v0.3.0) is enforced on every entry to
      `in_progress` and on lock re-acquisition over an in-progress run: wrong engine, wrong
      run id, non-`active` status, and an attestation older than the documented freshness
      window each refuse the transition.
- [ ] Recovery budgets decrement only on `blocked → in_progress`, exhaustion stops the run
      terminally, and consecutive-blocked reaches its configured limit and stops the run.
- [ ] Two concurrent `pipeline loop` invocations against the same run produce exactly one
      lock holder; the second reports the existing holder and exits without a second run,
      second ledger, or second run directory.
- [ ] A lock held by a dead pid on the same host is recoverable; a lock held from another
      host is never auto-recovered.
- [ ] Snapshot items with a dependency cycle are refused at compile time; acyclic items
      produce a deterministic dependency-respecting order that is stable across repeated
      compilations and identical on both engines.
- [ ] Equivalent invocations under the `claude` and `codex` engines produce the same
      canonical hash and resolve to the same run id.
- [ ] `pipeline loop --audit` performs zero writes: no lock file, no ledger write, no event
      append, no GitHub mutation — proven through the injected seams.
- [ ] Every unit test for the loop module runs through a dependency seam with no real
      filesystem-outside-tmp, network, git, or subprocess access.
- [ ] `npm run ci` passes from the repo root with the `plugin/` mirror in sync.
