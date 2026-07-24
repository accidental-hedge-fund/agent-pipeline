## Why

Issues #432/#433 shipped the eval layer: a frozen-fixture contract, a deterministic experiment
runner that executes cells in isolated worktrees at an immutable `base_commit`, and objective
graders — all provably free of production GitHub writes. Issues #499/#500 shipped the correction
side: an append-only `correction_event` ledger and a control compiler that clusters recurring
corrections and proposes the *next control level* (`instruction | skill-rubric | eval |
deterministic-gate | human-judgment`).

Nothing connects them. When the correction compiler (or a `pipeline improve` cluster, or a plain
recurring run failure) concludes that the right next control is an **eval**, there is no supported
path to turn that evidence into a concrete, reviewable eval fixture. A maintainer must hand-author
the fixture JSON — pick a `base_commit`, reconstruct stage-entry artifacts, write public/hidden
checks and acceptance criteria, choose graders — from memory, with no environment-fidelity
discipline and no guarantee the draft is even loadable or executable. That authoring gap is where
regression coverage silently fails to accrue.

This change adds a **human-approved `pipeline evals harvest` workflow**: it takes sanitized
evidence, maps the relevant agent surface, proposes *one* bounded ability or failure mode to
measure, declares environment fidelity explicitly (every external dependency is `live`,
`simulated`, or `forbidden`), and stops at a **draft** until a maintainer approves promotion into
the repo's eval corpus. It authors — it does not autonomously create or approve tests, and it
never grants an agent authority to define success unilaterally.

It also closes a real gap in the fixture contract itself: today a fixture says nothing about the
external tools/services/data a task may touch, so "reproducible" is only true by luck. This change
makes environment fidelity a first-class, validated part of the fixture contract, defaulting to
`simulated`/`forbidden` and requiring explicit maintainer selection before any `live` dependency
that can cost money, mutate external state, or read production data.

## What Changes

- Add a `pipeline evals harvest` subcommand that accepts one or more **sanitized evidence
  references** — normal run artifacts, `pipeline improve` clusters, or `correction_event` /
  control proposals from #499/#500 — and is **draft-only by default**. It never queues, advances,
  overrides, merges, or deploys anything.
- The workflow **inventories the capability surface** relevant to the candidate: the stage, the
  materialized prompts, the harness/model configuration, the tools/hooks in play, the repository
  paths involved, and the referenced services/data dependencies — a resolved snapshot, not a guess.
- It proposes **exactly one** bounded ability or failure mode to measure and records the source
  evidence, affected runs/items, recurrence count when available, and why an eval (rather than an
  instruction/rubric/gate) is the appropriate control level.
- The generated draft uses the **existing #432/#433 fixture and grader contracts**: immutable
  `base_commit`, task input, stage-entry artifacts, public/hidden checks, acceptance criteria,
  `allowed_change_paths`, grader refs+versions, `category`, `risk`, and `provenance` (`harvested`).
- Extend the **fixture contract with an environment-fidelity declaration**: each external
  tool/service/data dependency is declared with a versioned mode of `live`, `simulated`, or
  `forbidden`, plus required permissions, initial state, expected outputs/errors, and deterministic
  setup/teardown behavior. Fixture validation rejects an unknown mode or an incomplete dependency.
- **Default to `simulated` or `forbidden`.** A `live` dependency that can incur cost, mutate
  external state, or access production data requires **explicit maintainer selection**; the
  workflow never proposes `live` as the default.
- Hash the **environment contract + resolved agent-surface inventory** into fixture/cell provenance
  so environment or surface drift is detectable across experiment populations.
- Support **iterative maintainer revision** of the proposed ability, task, dependency modes,
  checks, and grader before promotion.
- **Promotion requires an explicit apply/approval action** and produces a normal diff for review.
  Promotion validates the draft with the existing eval loader and can generate a **plan-only
  experiment** proving the draft is executable — without making production GitHub writes.
- Reuse existing **artifact sanitization and injection defenses**: secrets and raw production
  payloads are never copied into drafts or evidence excerpts.

## Capabilities

### New Capabilities

- `eval-fixture-harvest`: the human-approved `pipeline evals harvest` authoring workflow — sanitized
  evidence intake, capability-surface inventory, the single bounded ability/failure proposal with
  control-level rationale, conformance to the #432/#433 fixture and grader contracts, iterative
  maintainer revision, the draft-only-default / explicit-apply-to-promote authority boundary,
  loader-validated promotion with an optional plan-only executability proof, and secret/payload
  exclusion.

### Modified Capabilities

- `eval-fixture-contract`: add the **environment-fidelity declaration** (per-dependency
  `live | simulated | forbidden` mode with permissions, initial state, expected outputs/errors, and
  deterministic setup/teardown), the **simulated/forbidden-by-default with explicit-selection-for-live**
  rule, and the **environment-and-surface provenance hash** the fixture exposes.
- `stage-eval-runner`: every cell record additionally carries the fixture's environment-and-surface
  provenance hash, so environment or agent-surface drift is a detectable difference between
  experiment populations.

## Impact

- `core/scripts/evals/fixture.ts` — the environment-fidelity contract type and its validation
  (mode enum, required-field completeness, default-mode rule); the environment-and-surface
  provenance hash exposed off the loaded fixture.
- `core/scripts/evals/harvest.ts` (new) — the harvest workflow: evidence intake + sanitization,
  capability-surface inventory, single-ability proposal, draft rendering to the fixture/grader
  contract, iterative revision, and loader-validated promotion with an optional plan-only experiment.
- `core/scripts/evals/run.ts` / `results.ts` — thread the environment-and-surface provenance hash
  onto each cell record's identity keys.
- `core/scripts/pipeline.ts` — a `pipeline evals harvest` subcommand dispatch; draft-only by
  default, explicit `--apply`/`--promote` to write, wired to the eval-mode GitHub surface
  (`gh-eval-surface.ts`) so no production write is possible.
- `core/scripts/config.ts` — a fixtures/harvest config block if gating is needed (default-mode
  policy), rejecting unknown keys.
- `core/test/` — fixtures + tests for harvested correction evidence, ordinary run-failure evidence,
  `live`/`simulated`/`forbidden` dependencies, missing evidence, secret-bearing traces, iterative
  edits, rejected drafts, and explicit promotion.
- `plugin/` mirror regenerated. No state-machine edge, review verdict, blocking, or routing
  decision reads the harvest workflow — it only reads evidence and, on explicit approval, writes a
  repo-local fixture file.

## Acceptance Criteria

Observable, falsifiable outcomes that make #535 done:

- [ ] `pipeline evals harvest` accepts one or more sanitized evidence references drawn from normal
      run artifacts, `pipeline improve` clusters, or `correction_event` / control proposals, and
      produces a draft; a test drives it from each source kind.
- [ ] The command emits a capability-surface inventory for the candidate covering stage,
      materialized prompts, harness/model configuration, tools/hooks, repository paths, and
      referenced services/data dependencies.
- [ ] The command proposes exactly one bounded ability or failure mode and records the source
      evidence, affected runs/items, recurrence count when available, and why an eval is the
      appropriate control level.
- [ ] A generated draft conforms to the #432/#433 fixture and grader contracts (immutable
      `base_commit`, task input, stage-entry artifacts, public/hidden checks, acceptance criteria,
      allowed-change boundary, grader refs+versions, `category`, `risk`, `provenance: harvested`)
      and loads under the existing fixture loader.
- [ ] The fixture contract declares each external tool/service/data dependency with a versioned
      mode of `live`, `simulated`, or `forbidden`, plus required permissions, initial state,
      expected outputs/errors, and deterministic setup/teardown; the loader rejects an unknown mode
      or an incomplete dependency by name.
- [ ] A `live` dependency that can incur cost, mutate external state, or access production data is
      never the default proposal (default is `simulated` or `forbidden`) and requires an explicit
      maintainer selection to become `live`; a test asserts the default and the required selection.
- [ ] The environment contract and resolved agent-surface inventory are hashed into fixture/cell
      provenance; two fixtures/cells differing only in environment mode or resolved surface produce
      different hashes, and identical ones produce identical hashes.
- [ ] The workflow supports iterative maintainer revision of the proposed ability, task, dependency
      modes, checks, and grader before promotion, and re-renders a consistent draft after each edit.
- [ ] Dry-run/draft is the only default behavior; repository writes require an explicit
      approval/apply action and produce a normal diff; the command never queues, advances,
      overrides, merges, or deploys anything, and performs no production GitHub write.
- [ ] Promotion validates the draft with the existing eval loader and can generate a plan-only
      experiment proving the draft is executable without production GitHub writes; an invalid draft
      is rejected at promotion, naming the offending field.
- [ ] Secrets and raw production payloads are never copied into a draft or evidence excerpt; a
      secret-bearing trace yields only redacted excerpts, and existing injection defenses apply.
- [ ] Tests cover harvested correction evidence, ordinary run-failure evidence,
      live/simulated/forbidden dependencies, missing evidence, secret-bearing traces, iterative
      edits, rejected drafts, and explicit promotion; each test bites without the change; `npm run
      ci` is green and the `plugin/` mirror is regenerated and committed.
