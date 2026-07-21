## Why

Agent Pipeline owns execution of **one** issue through `pipeline:ready-to-deploy`.
goal-loop (a separate skill, installed at `~/.claude/skills/goal-loop`, Python
`state.py` + `goal-loop/contract@2` / `goal-loop/ledger@2`) owns durable selection,
ordering, locking, recovery, reconciliation, the merge/refresh barrier, and
continuation across **many** issues — and it already mandates agent-pipeline as its
only per-item execution mode (`execution.mode: "agent-pipeline"`,
`handoff_stage: "pipeline:ready-to-deploy"`).

The product boundary is useful internally, but today it is exposed as two separately
installed top-level skills that the user must discover, install, version, and compose
by hand — even though one *requires* the other for every selected item. The command
surface should present a single entry point: `/pipeline:loop` (Claude) and
`$pipeline:loop` (Codex).

This change makes `pipeline:loop` the canonical durable-run command **as a thin
facade** over the existing goal-loop core and ledger. It deliberately does **not**
copy the state engine into Agent Pipeline and does not merge repositories: the
goal-loop v0.3 live pilot (goal-loop#4, #6, #7) has not yet established stable
contracts, and absorbing an unstable engine would be the expensive, hard-to-reverse
choice. The consolidation question is answered by an ADR here and re-decided later
with pilot evidence.

## What Changes

- **ADR (`design.md`)**: compare four convergence options — thin facade, package
  dependency, monorepo/module absorption, permanent separate products — and record
  the decision (facade now, re-decide after a bounded live pilot) with the
  falsifiable conditions under which the decision is revisited.
- **Engine-neutral per-item execution interface**: define exactly one documented
  contract (`pipeline/loop-execution@1`) between the loop orchestrator and per-item
  Pipeline execution — inputs (item id, repo, base branch, engine, worktree policy,
  done definition), the terminal outcomes Pipeline may report, and the evidence
  pointer it returns. The interface is engine-neutral: identical for Claude and Codex.
- **Command registration**: add `loop` to the single-source `OPERATION_SURFACE` in
  `scripts/build.mjs`, so `/pipeline:loop` and `$pipeline:loop` are generated
  symmetrically, with one argument contract covering milestone, label, range,
  roadmap slice, explicit issue list, resume, and audit.
- **Delegation, not reimplementation**: `pipeline:loop` compiles/normalizes its
  arguments into a goal-loop discovery input and hands off to the installed goal-loop
  skill's contract, ledger, lock, recovery, reconciliation, and report semantics. No
  second state store, no second run-id namespace, no second lock.
- **Native `/goal` requirement**: `pipeline:loop` requires the host's built-in
  autonomous goal mode on both engines and refuses to start (with actionable
  remediation) when it is unavailable, rather than degrading into a non-durable loop.
- **Compatibility preflight**: a deterministic `loop:contract-coherence` check —
  surfaced in `pipeline doctor`, run by the installer, and run by `pipeline:loop`
  itself **before any external mutation** — that verifies an installed goal-loop
  whose contract/ledger schema ids are in Pipeline's supported set.
- **Aliases**: `/goal-loop` and `$goal-loop` keep working unchanged. The deprecation
  notice is gated on the facade being proven by a bounded live run — it is not
  emitted by this change.

## Capabilities

### New Capabilities
- `pipeline-loop-facade`: the `pipeline:loop` command surface, the engine-neutral
  per-item execution interface, delegation to the single goal-loop state store, the
  native-`/goal` requirement, and the alias/deprecation policy.

### Modified Capabilities
- `namespaced-command-surface`: the in-scope `pipeline:<command>` operation set gains
  `loop`, and the spec records that `loop` delegates to the installed goal-loop skill
  instead of forwarding to a pipeline CLI sub-command.
- `install-version-coherence`: `pipeline doctor` and the installer gain a
  `loop:contract-coherence` check for Pipeline↔loop contract compatibility.

## Impact

- `scripts/build.mjs` — `OPERATION_SURFACE` gains a `loop` entry (a delegating entry,
  not a CLI forward); both host projections regenerate.
- `plugin/` — regenerated mirror gains `commands/pipeline:loop.md`.
- `hosts/claude/SKILL.md`, `hosts/codex/…`, `README.md` — document `/pipeline:loop`
  and `$pipeline:loop` as the canonical durable-run entry point.
- `core/scripts/` — a small, dependency-injected loop-preflight module
  (goal-loop discovery + contract-version compatibility + native-`/goal` capability),
  wired into `doctor` and the installer.
- `core/test/namespaced-commands.test.ts` — `EXPECTED_OPERATIONS` gains `loop`.
- `core/test/` — new fixture tests for argument parsing and preflight outcomes.
- **No change** to the pipeline state machine, labels, review policy, or evidence
  gates; **no** goal-loop repository change, archive, or ledger migration.

## Acceptance Criteria

- [ ] `/pipeline:loop` (Claude) and `$pipeline:loop` (Codex) both exist in the
      generated host command surfaces, are produced from the single
      `OPERATION_SURFACE` source, and accept an identical argument contract covering
      `--milestone`, `--label`, `--range`, `--roadmap-slice`, an explicit issue list,
      `--resume <run-id>`, and `--audit`.
- [ ] For equivalent inputs, `/pipeline:loop` and `$pipeline:loop` start or resume
      **the same** canonical durable run: one run id, one contract, one ledger, one
      lock — demonstrated by a fixture in which a run started under the `claude`
      adapter is resumed under the `codex` adapter with no new run id created.
- [ ] Every selected item is executed through the normal Pipeline state machine and
      evidence gates — the facade never advances an item's stage labels itself and
      never marks an item done at anything other than `pipeline:ready-to-deploy`.
- [ ] The per-item execution interface is written down as a versioned contract
      (`pipeline/loop-execution@1`) with named inputs, terminal outcomes, and an
      evidence pointer, and is identical for both engines.
- [ ] No second state store exists: the change adds no ledger, run-id namespace, lock
      file, or run directory of its own — a test asserts the facade's only durable
      writes go through the goal-loop state interface.
- [ ] Existing goal-loop runs created before this change remain resumable through
      `/pipeline:loop --resume <run-id>` with no migration step and no destructive
      rewrite of their contract/ledger.
- [ ] `/goal-loop` and `$goal-loop` remain functional and emit **no** deprecation
      notice in this change; the notice is specified but gated on the bounded live run.
- [ ] `pipeline:loop` refuses to start when the host's built-in `/goal` autonomous
      mode is unavailable, exits non-zero with actionable remediation, and performs no
      external mutation (no issue/PR/label/branch write, no lock acquisition).
- [ ] `pipeline doctor` reports a `loop:contract-coherence` check that passes for a
      supported installed goal-loop, fails when goal-loop is absent, and fails naming
      **both** version/schema ids when the installed contract schema is outside
      Pipeline's supported set; the installer runs the same check and refuses to
      complete an incompatible install.
- [ ] Incompatible-version and missing-`/goal` detection happen **before** any
      external mutation — asserted by a fixture whose fake gh/state seams record zero
      write calls on those paths.
- [ ] Fixture tests cover: command parsing (each selector form), new run, resume,
      audit, missing native `/goal`, mismatched contract versions, and the legacy
      `/goal-loop` / `$goal-loop` aliases — with no real network, git, or subprocess
      calls.
- [ ] `design.md` contains the four-option ADR with an explicit decision and the
      falsifiable re-decision criteria for repository consolidation.
- [ ] A bounded live run through `/pipeline:loop` is recorded as evidence before any
      repository-consolidation decision is taken; no consolidation is performed in
      this change.
- [ ] `node scripts/build.mjs` output is committed (mirror in sync) and
      `npm run ci` passes.
