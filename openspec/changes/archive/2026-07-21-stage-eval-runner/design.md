## Context

The pipeline already isolates work per issue (`worktree.ts`), already invokes harnesses
through a normalized adapter contract with a treatment-identity description
(`cli-harness-adapters`, #431), already writes machine-readable per-run artifacts
(`run-directory-layout`, `run-artifact-conventions`), and already has one entry point per
stage under `core/scripts/stages/`. None of that is an experiment harness, because every
production run varies the task, the base commit, the prompt version, and the repository state
simultaneously with the treatment.

What this change adds is the control discipline: freeze the task, vary exactly one axis set,
and record enough identity to join the result back to normal evidence.

The naming collision with the existing `eval-gate` capability is real and worth stating
plainly: `eval-gate` is a **gate** that runs a repo-declared command against a real PR and
decides pass/fail. This change is an **experiment runner** that replays frozen fixtures
offline. They share a word and nothing else. The issue explicitly rules out reusing the gate
as the orchestrator, and this design does not touch `stages/eval.ts`.

## Goals / Non-Goals

Goals:
- Attribution: an observed difference between two cells is attributable to the treatment,
  because everything else is held byte-identical.
- Reproducibility: the manifest plus the seed fully determine the population and the order.
- Safety: an experiment cannot mutate production issue state, even by accident.
- Joinability: eval cells and ordinary runs share identity keys.

Non-Goals:
- Grading, scoring, statistics, or reporting (#433).
- Choosing a production model/effort policy from the results.
- CLI installation/authentication, or any hosted result service.
- Reusing or modifying the `eval-gate` stage.

## Decisions

### 1. The manifest is the unit of an experiment; the plan is the unit of auditability

Expansion (manifest → cells) is a pure function. It is separated from execution and its
output is **persisted before the first treatment runs** (`plan.json`). This matters more than
it looks: an experiment whose population is only knowable by inspecting which cells happened
to complete is not auditable, and a crash halfway through would otherwise leave the intended
denominator unrecoverable. A persisted plan also makes resume trivial — resume is "plan minus
completed", not a re-derivation.

`pipeline evals plan <manifest>` exposes the pure expansion on its own, so the population can
be reviewed before spending model tokens on it.

### 2. A cell id is a deterministic function of its coordinates

`cell_id = <experiment_id>/<fixture_id>/<treatment_id>/<replicate>`, with `treatment_id` a
deterministic slug of the treatment axes (harness, provider, model, effort). Consequences:
cell ids are stable across reruns, resume can match on them without a side table, and two
manifests that describe the same cell agree on its name.

Rejected alternative: content-hashed or sequence-numbered cell ids. Both break resume the
moment the manifest is edited in an unrelated place, and neither is readable in a filename or
a log line.

### 3. Isolation is per-cell, not per-fixture or per-treatment

Every cell gets its own worktree created fresh at `fixture.base_commit`, its own branch name,
its own session/output paths. Replicates are *not* allowed to share a worktree even though
they share a treatment — a replicate exists precisely to measure run-to-run variance, and
sharing state would let replicate *n* see replicate *n-1*'s files and destroy that
measurement.

Worktree creation reuses `worktree.ts` rather than forking a parallel implementation; the
only new requirement it must satisfy is checking out at an arbitrary base commit rather than
at the integration branch head.

### 4. Evaluation mode is a hard capability restriction, not a convention

Production-write suppression is implemented as an evaluation-mode `gh` surface that **refuses**
mutating operations (label set/remove, comment, PR create/edit/merge, push to a production
branch) rather than as a set of `if (!evalMode)` guards scattered through the stages. A
convention decays as stages gain call sites; a refusing seam fails loudly the first time a
stage tries.

The test for this is a recording fake asserting the *absence* of mutating calls across a full
matrix in both modes — a property of the recorded call log, not of reviewer vigilance. This
mirrors how the HTML-export change proved self-containment by scanning the bytes.

Note that "no production writes" is not the same as "no GitHub reads": a fixture may legitimately
carry a frozen snapshot of issue text, and reads against fixture data are local.

### 5. Scheduling is seeded, interleaved, and bounded

Order is a seeded permutation of the plan, then **interleaved by harness** so that a
provider-side disturbance (a rate-limit window, a model rollout, an outage) is spread across
treatments instead of landing entirely on whichever harness was scheduled during it. Running
all Claude cells then all Codex cells would alias time-of-day and provider state directly onto
the treatment — the exact confound this change exists to remove.

Concurrency is a manifest field and is bounded; concurrent cells are independent by
construction (decision 3), so the only shared resource is the provider account, which is
also why the interleave matters.

### 6. Four result classes, because three of them are not data

`completed` means the treatment ran and produced an outcome — including an outcome where the
model did badly. That is a *result*. `infra_error` (worktree/git/filesystem/runner defect),
`auth_error` (missing or expired credentials, quota or rate-limit refusal), and `timeout` are
*not* results about the treatment, and folding them into "failure" would systematically
penalize whichever harness happened to be misconfigured or throttled. They are recorded in
`failures.jsonl` and excluded from the treatment population; `runs.jsonl` carries the
`completed` cells.

Keeping both files (rather than one file with a class field) makes the common downstream
question — "what is my valid N?" — a line count rather than a filter, and makes an
experiment that silently lost half its cells to auth errors visible immediately.

### 7. Output contract: additive, append-only, and under the repo's existing artifact root

Layout: `<output_dir>/<experiment-id>/{manifest.json,plan.json,runs.jsonl,failures.jsonl}`.
`manifest.json` is the resolved manifest as executed (so a later edit to the source manifest
cannot silently reinterpret past results). The two `.jsonl` files are append-only: a completed
cell's line is never rewritten, which is what makes resume safe against a crash mid-write of
a *different* cell.

**Deviation from the issue text, stated explicitly.** The issue suggests
`artifacts/evals/<experiment-id>/…`. This repo's established local-artifact root is
`.agent-pipeline/` (`runs/`, `roadmap/`, `history/`, each git-ignored), and there is no
`artifacts/` directory today. Introducing a second top-level artifact root would fragment the
convention and the `.gitignore` story for no benefit. The default is therefore
`.agent-pipeline/evals/<experiment-id>/`, and `output_dir` is a manifest field, so
`artifacts/evals` remains expressible by anyone who wants it. The issue's wording ("an
additive filesystem contract **such as**") reads as illustrative rather than binding; if it
was meant literally, this is the decision to revisit.

### 8. Join keys are recorded, not reconstructed

Each record carries `experiment_id`, `fixture_id`, `treatment_id`, `replicate`, `prompt_hash`,
`config_hash`, and `base_sha`. `prompt_hash` and `config_hash` are hashes of the *materialized*
prompt text and the *effective* config for that cell — not of the template file or the config
file — so that a prompt template edit or a config default change is detectable as a
population difference rather than invisibly confounding a comparison across time.

### 9. Fixture provenance is a first-class field

`provenance: synthetic | harvested` is required. The human comment on the issue notes a second
fixture source — harvesting from shipped issues and from recorded `ReviewArtifact`/`--override`
dispositions — which produces organically-defective fixtures at zero authoring cost. That
harvester is not built here, but the two populations have different bias profiles and must be
reportable separately downstream, which is only possible if the field exists from day one.
Adding it later would leave every fixture written before that point unclassifiable.

## Risks / Trade-offs

- **Stage-mode entry points may not be cleanly invocable from frozen inputs.** Some stages
  today assume state written by their predecessor. Where that is true, the fixture's
  stage-entry artifacts must supply it; where a stage cannot be entered without a production
  GitHub read, that is a finding to surface rather than to work around by loosening the
  no-writes guarantee.
- **Cost.** A full matrix is `fixtures × treatments × replicates` model invocations. The
  manifest's concurrency and per-cell timeout bound wall-clock, not spend; spend accounting
  is owned by #429. The plan-only command exists partly so the bill is knowable before it is
  incurred.
- **Adapter coverage.** Grok Build / Pi / OpenCode treatments depend on #431's adapters
  landing; Claude and Codex treatments work without it. The runner depends on the adapter
  contract, not on any specific adapter, so partial coverage degrades to "fewer treatment
  values", not to a broken runner.
- **Fixture rot.** A fixture pinned to a base commit drifts from the current repo. This is
  intentional — the point is a frozen task — but it means a fixture's public checks may stop
  reflecting current expectations. Provenance plus base SHA make that diagnosable; refreshing
  fixtures is an ongoing maintenance cost accepted here.
