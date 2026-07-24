## Context

The eval layer (#432/#433) already provides everything needed to *run* a frozen task and grade it:

- `core/scripts/evals/fixture.ts` loads and validates a fixture — `fixture_id`, `schema_version`,
  a full immutable `base_commit`, task input, per-stage `stage_entry_artifacts`, public/hidden
  checks, `acceptance_criteria`, `allowed_change_paths`, `grader_refs`, `category`, `risk`, and
  `provenance` (`synthetic | harvested`).
- `core/scripts/evals/run.ts` expands a manifest into cells, executes each in a fresh isolated
  worktree at `base_commit`, and records identity keys (`prompt_hash`, `config_hash`, `base_sha`).
- `core/scripts/evals/gh-eval-surface.ts` is a `gh` seam that *refuses* every mutating GitHub
  operation, so eval-mode code cannot perform a production write even if it tries.
- `core/scripts/artifact-sanitize.ts` already redacts secrets and screens injection in run
  artifacts.

The correction side (#499/#500) produces the demand signal: a `correction_event` ledger and a
compiler that, for a recurring correction, may name `eval` as the next control level. Today that
recommendation dead-ends — there is no supported authoring path from "this should be an eval" to a
concrete, loadable, executable fixture draft. This change is that path, and it deliberately stops
at a human-approved draft.

Two novel pieces of work: (1) a **harvest workflow** that composes existing sanitization, surface
resolution, and the fixture/grader contracts into a reviewable draft under a strict authority
boundary; and (2) a **fixture-contract extension** making environment fidelity explicit and
default-safe.

## Decision 1 — draft-only default, explicit apply to promote, no production writes

The command's default is a **draft** written to a scratch/preview location (or printed), never the
corpus. Promotion into `core/evals/fixtures/` requires an explicit `--apply`/`--promote` action and
produces a normal git diff for review — a human owns the "add this test" button, mirroring golden
rule #4 (the pipeline never merges; a human owns the consequential write). The command is wired to
`gh-eval-surface.ts`, so even the promotion path cannot make a production GitHub write. It never
queues, advances, overrides, merges, or deploys. This is the same read-only-plus-explicit-write
posture as `pipeline improve` (`--apply` files only `pipeline:backlog` issues), narrowed further:
here the only write is a repo-local fixture file, gated behind maintainer approval.

## Decision 2 — one bounded ability per harvest, with a recorded control-level rationale

A harvest proposes **exactly one** ability or failure mode to measure — not a batch. A fixture that
tries to measure several capabilities at once grades ambiguously and resists a clean allowed-change
boundary. The proposal records the source evidence (which runs/items, recurrence count when the
compiler supplies it) and *why an eval* is the right control — reusing #500's graduation ladder
(`documented rule -> skill/rubric -> eval -> deterministic gate`). If the evidence points at a
lower rung (an instruction or rubric would suffice) or a higher one (a deterministic gate), harvest
says so and does not fabricate an eval. This keeps the authoring honest: the compiler proposes the
control level; harvest only executes the `eval` case and records the justification.

## Decision 3 — environment fidelity is a first-class, validated part of the fixture contract

The existing fixture contract is silent about external dependencies, so "self-contained at
`base_commit`" is only true when a task happens not to touch a network/service/data surface. This
change adds an explicit **environment-fidelity contract**: an optional list of external
dependencies, each declaring:

- `mode`: exactly one of `live`, `simulated`, or `forbidden`, plus a mode `version` so a
  simulation/mode change is detectable.
- `required_permissions`: the permissions the dependency needs (empty is allowed).
- `initial_state`: the deterministic starting state the dependency is placed in.
- `expected` outputs/errors: what a call is expected to return or raise.
- deterministic `setup`/`teardown` behavior.

The loader validates completeness: a dependency with an unknown `mode` or a missing required field
is rejected **by name**, exactly like the existing missing-field rejection. A fixture that declares
no external dependencies remains valid (the common `synthetic` case). This lives in the
`eval-fixture-contract` capability because it is a property of the fixture, not of the harvest
tool — a hand-authored fixture gets the same validation.

## Decision 4 — simulated/forbidden by default; `live` requires explicit maintainer selection

The default proposed mode for any newly declared dependency is `simulated` (when a deterministic
stand-in is possible) or `forbidden` (when the task must not touch it). `live` is never proposed by
default. A `live` dependency that can incur cost, mutate external state, or access production data
requires an **explicit maintainer selection** to be set — the workflow surfaces the cost/mutation/
production-data risk and refuses to silently promote a draft whose default was flipped to `live`.
This is the environment-fidelity analogue of #500's "the compiler proposes, humans dispose": the
tool proposes the safe mode; only a human opts into a live external touch. It also protects the
runner's core guarantee — evaluation mode performs no production writes — from being quietly eroded
by a harvested fixture that reaches out to a live production service.

## Decision 5 — hash the environment contract + resolved surface into fixture/cell provenance

Reproducibility across experiment populations depends on knowing the environment and agent surface
were the same. This change derives an **environment-and-surface provenance hash** over (a) the
resolved environment-fidelity contract and (b) the resolved capability-surface inventory (stage,
materialized prompts, harness/model configuration, tools/hooks, repository paths, referenced
services/data). The fixture exposes it, and every cell derived from the fixture records it
alongside the existing `prompt_hash`/`config_hash`/`base_sha` identity keys — so a change in
dependency mode or resolved surface shows up as a hash difference between populations, just as a
prompt-template change already does. Identical inputs hash identically; a single mode flip changes
the hash. This is the `stage-eval-runner` cell-record modification.

## Decision 6 — promotion is loader-validated and (optionally) proven executable plan-only

Promotion re-runs the existing fixture loader against the draft: an invalid draft is rejected at
promotion naming the offending field, so a broken fixture never enters the corpus. Optionally,
promotion generates a **plan-only experiment** (`pipeline evals plan`-shaped) over the new fixture,
proving the draft expands into an executable cell plan without running a live model and without any
production GitHub write. This gives the maintainer evidence the draft is real before it lands, and
reuses the runner's existing plan path rather than inventing a new execution mode. Full execution
(`run`/`grade`) remains a separate, later step — harvest's job ends at a validated, plan-provable
draft.

## Decision 7 — reuse sanitization and the eval GitHub surface; add nothing new to secrecy

Evidence intake runs every excerpt through the existing `artifact-sanitize` path (secret redaction
+ injection screen) before it can enter a draft or a proposal body. Raw production payloads and
secrets are never copied verbatim — only redacted excerpts. Hidden checks and seeded-defect ground
truth continue to obey the existing contract (never surfaced to a treatment). No new secrecy or
sanitization mechanism is introduced; the change composes what #432/#433 and the artifact layer
already guarantee.

## Risks / trade-offs

- **Surface-inventory completeness is best-effort.** The resolved capability surface is only as
  complete as what the run artifacts and repo state expose; a dependency the agent touched but did
  not record cannot be inventoried. Mitigation: the environment contract defaults to `forbidden`
  for anything not explicitly declared, so an un-inventoried live touch fails closed rather than
  silently running live.
- **Draft quality depends on evidence quality.** Thin evidence yields a thin draft. Acceptable —
  the maintainer revision loop (Decision 2/Decision 6) and the explicit promotion gate are the
  backstop; a weak draft is rejected, not silently corpus-bound.
- **`schema_version` bump.** Adding the environment-fidelity field may require a fixture
  `schema_version` increment; existing fixtures without the field stay valid (the field is
  optional) so the bump is additive, and the loader continues to reject genuinely unsupported
  versions.
