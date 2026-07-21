# Design — `pipeline:loop` facade over goal-loop

## Context

Two skills, one workflow:

| | Agent Pipeline | goal-loop |
|---|---|---|
| Unit of work | one issue | many issues |
| Owns | 11-stage state machine, review rigor, evidence gates, `pipeline:ready-to-deploy` | selection, dependency-aware ordering, run lock, ledger, recovery, reconciliation, merge/refresh barrier, continuation |
| Implementation | TypeScript, Node ≥ 24, type-stripped, `core/` → generated `plugin/` mirror | Python (`state.py`), JSON Schema contracts, `install.py` with an ownership manifest |
| Install surface | `~/.claude/skills/pipeline` (+ Codex overlay) | `~/.claude/skills/goal-loop` (+ Codex adapter), `.goal-loop-manifest.json` carries `package` + `version` |
| Contracts | pipeline labels + evidence bundle | `goal-loop/contract@2`, `goal-loop/ledger@2` |

goal-loop already hard-depends on Agent Pipeline: its contract pins
`execution.mode: "agent-pipeline"`, `handoff_stage: "pipeline:ready-to-deploy"`,
`ordering: "dependency-aware-sequential"`, `max_active_items: 1`, and it ships a
`state.py pipeline-preflight` command that verifies an installed Pipeline before a run
starts. The dependency is one-directional and already real; what is missing is a single
user-facing entry point.

**Verified facts** used below (checked against the installed skill and the goal-loop
checkout, not assumed): `~/.claude/skills/goal-loop/.goal-loop-manifest.json` →
`{"package":"goal-loop","version":"0.2.0","files":{…sha256…}}`; `state.py` constants
`CONTRACT_SCHEMA = "goal-loop/contract@2"`, `LEDGER_SCHEMA = "goal-loop/ledger@2"`;
`state.py` sub-commands `compile-contract`, `init`, `lock`, `transition`, `decision`,
`event`, `reconcile`, `status`, `show`, `pipeline-preflight`, `runs`.

## Decision 1 — ADR: how do the two products converge?

### Options considered

**A. Thin facade (chosen).** Agent Pipeline registers `pipeline:loop` in its host
command surface. The command normalizes arguments, runs a deterministic preflight, and
hands off to the *installed* goal-loop skill's workflow and `state.py`. No engine code
is copied; both repos keep independent release cadence.

- **Pros:** one user-facing command immediately; zero risk to goal-loop's authority,
  merge, dependency, and reconciliation gates; reversible in a single commit; does not
  freeze contracts that goal-loop v0.3 is still changing (goal-loop#4, #6, #7); the
  existing ledger keeps working, so no migration.
- **Cons:** two installs and two versions to keep coherent (mitigated by the
  `loop:contract-coherence` preflight); cross-language boundary (TS ↔ Python) stays;
  the facade adds one indirection layer to debug.

**B. Package dependency.** Agent Pipeline declares goal-loop as a versioned dependency
and vendors/installs it as part of its own install.

- **Pros:** one install command; version coherence enforced by the dependency
  resolver rather than a runtime check.
- **Cons:** goal-loop is a Python skill distributed by `install.py` with a
  checksum-ownership manifest, not an npm package — a real dependency edge means
  either a repackaging project or an installer that writes into another package's
  managed directory, which its manifest explicitly refuses. It also forces a lockstep
  release cadence onto a component still in v0.3 flux. **Deferred**, not rejected:
  this is the natural next step *if* the facade proves the boundary but the dual
  install remains the top user complaint.

**C. Monorepo / module absorption.** Move goal-loop's state engine into
`core/scripts/` as a Pipeline module (or merge the repositories).

- **Pros:** one repo, one release, one language, one test suite; the strongest
  long-term ergonomics if the two products are genuinely one product.
- **Cons:** highest-cost and least reversible option; would rewrite a durable state
  engine in a second language while its contracts are still moving; risks silently
  weakening the authority/merge/reconciliation gates during translation; strands
  existing runs unless a compatibility migration is designed first; and the issue's own
  non-goals forbid reimplementing goal-loop inside a Pipeline stage handler.
  **Rejected for now** — reconsider only with pilot evidence (see re-decision criteria).

**D. Permanent separate products.** Keep two top-level commands forever, improve docs.

- **Pros:** zero engineering cost; cleanest conceptual boundary.
- **Cons:** does not solve the stated problem — users must still discover, install,
  version, and compose two skills where one always requires the other. **Rejected.**

### Decision

**Adopt A (thin facade) now.** `pipeline:loop` becomes the canonical durable-run
command; goal-loop remains the sole owner of durable state, and is invoked, not
absorbed. Consolidation (B or C) is a **separately approved** future change.

### Re-decision criteria (falsifiable)

Revisit after the goal-loop v0.3 bounded live pilot (goal-loop#6) plus at least one
bounded live run through `/pipeline:loop`. Move toward **B/C only if all** hold:

1. `goal-loop/contract@N` and `goal-loop/ledger@N` have been stable across the pilot
   (no breaking schema bump), i.e. an absorbed copy would not immediately diverge.
2. Independent versioning demonstrably bought nothing: no goal-loop release in the
   window shipped without a matching Pipeline release, and vice versa.
3. The `loop:contract-coherence` check fired on real users more than once — i.e. the
   dual-install coherence burden is empirically real, not theoretical.
4. A non-destructive migration path for existing ledgers is designed and reviewed.

If (1) fails, stay on A. If (1)–(3) hold but (4) is unproven, prefer B over C.

## Decision 2 — one engine-neutral per-item execution interface

Define **`pipeline/loop-execution@1`** as the only contract between the loop
orchestrator and per-item Pipeline execution. It is a *documented data contract*, not a
new transport: it names what the orchestrator supplies and what Pipeline reports back,
so the same description holds whether the run is driven by Claude Code or Codex.

- **Request:** `item_id` (issue number), `repo` (`name`, `base_branch`), `engine`
  (`claude` | `codex`), `worktree_policy`, `done_definition`
  (`pipeline:ready-to-deploy`), and `run_id` for traceability.
- **Terminal outcomes:** exactly one of `ready_to_deploy`, `blocked_needs_human`,
  `failed`, or `abandoned`. Anything else is a protocol violation the orchestrator
  records as `failed` rather than silently retrying.
- **Evidence pointer:** the PR number (when one exists) plus the Pipeline run
  directory/run id, so the ledger references evidence instead of copying it.

Rationale: the orchestrator must never need to know *how* Pipeline advances an item,
and Pipeline must never need to know there are other items. Everything that crosses the
boundary is in this list; anything not in it is deliberately private to one side.
Notably, the interface has **no** "advance one stage" verb — the orchestrator hands off
a whole item, which is what keeps the per-item advance loop from recursively owning
multiple issues (a stated non-goal).

## Decision 3 — delegation without a second state store

`pipeline:loop` performs no durable bookkeeping of its own. Concretely:

- Run identity, contract compilation, locking, transitions, decisions, events,
  reconciliation, status, and audit all go through goal-loop's state interface
  (`compile-contract`, `init`, `lock`, `transition`, `decision`, `event`, `reconcile`,
  `status`, `show`, `runs`). The facade adds no ledger file, no run-id namespace, no
  lock, and no run directory.
- Because run identity is goal-loop's, cross-engine resume is free: the same selector
  compiles to the same canonical contract hash and therefore the same run, and
  `--resume <run-id>` addresses it directly regardless of which engine started it.
- Legacy runs need no migration: they are the *same* runs in the *same* store, reached
  through a different front door.

The facade's only new deterministic logic is argument normalization and preflight —
both pure functions over injected seams, which is what makes the fixture tests possible
without touching the network, git, or a subprocess (repo convention: `Deps` parameters,
cf. `ShaGateDeps`, `VerifyDeps`).

## Decision 4 — preflight ordering: refuse before mutating

The failure modes that matter (goal-loop missing, contract schema unsupported, native
`/goal` unavailable) must be detected **before** the first external side effect —
before acquiring the run lock, before any `gh` write, before creating a worktree or
branch. So the command's order is fixed:

1. parse + normalize arguments (pure)
2. `loop:contract-coherence` — discover the installed goal-loop, read
   `.goal-loop-manifest.json` (`package`, `version`) and the contract/ledger schema
   ids, compare against Pipeline's supported-set constant
3. native-`/goal` capability check for the active engine
4. only then compile the contract, acquire the lock, and start/resume

Steps 2–3 read only; a failure at either exits non-zero with remediation and zero
writes. The supported set is a constant in `core/` (e.g. `goal-loop/contract@2`),
bumped deliberately — a *newer* unsupported contract fails just as loudly as an older
one, since silently proceeding against an unknown schema is how a durable store gets
corrupted.

`pipeline doctor` runs the same check function so the diagnosis is available before a
run is ever attempted, and the installer runs it so an incompatible pairing is caught
at install time rather than mid-run.

## Decision 5 — alias deprecation is evidence-gated

`/goal-loop` and `$goal-loop` keep working with **no behavior change and no notice** in
this change. A deprecation notice is a user-visible promise that the replacement is
better; emitting it before a bounded live run has proven the facade would be a claim we
have not verified. The notice text and the window are specified here so that turning it
on later is a one-line, separately-reviewed change — not a redesign.

## Risks

- **Two installs drift.** Mitigated by decision 4; the check is deterministic and runs
  in three places (doctor, installer, run start).
- **Facade becomes a second orchestrator by accretion.** Mitigated by decision 3 plus a
  test asserting the facade makes no durable writes of its own; any future "just cache
  this locally" instinct must instead extend `pipeline/loop-execution@1`.
- **Contract drift during goal-loop v0.3.** Accepted and bounded: the supported-set
  constant turns drift into a loud, actionable preflight failure rather than a
  corrupted run.
