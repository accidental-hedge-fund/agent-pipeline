## Why

Every claim this repo makes about harness/model/effort policy — "Codex reviews better than
Claude", "high effort is worth the latency at plan-review", "the new adapter is good enough
to route production traffic to" — is currently backed by anecdote from production runs. Those
runs are not comparable: each one has a different issue, a different base commit, a different
prompt version, a different repository state, and a different reviewer mood. The difference
between two runs is confounded with everything that changed between them, so no observed
difference can be attributed to the treatment.

The pipeline already has the pieces needed to fix this — per-stage entry points, an isolated
worktree per run, a normalized harness-adapter contract with treatment identity (#431), and
machine-readable run artifacts. What is missing is the thing that *holds everything but the
treatment constant*: a runner that replays the **same frozen task** through a **matrix of
treatments** from the **same base commit**, in isolation, without touching production GitHub
state.

This change adds that runner. It is deliberately an experiment harness, not a gate: it does
not decide policy, does not score outputs, and does not participate in the state machine. The
existing `eval-gate` capability (a post-change pass/fail gate on a real PR) is a different
thing and is explicitly not reused as the orchestrator here.

## What Changes

- A new **experiment manifest** (versioned, repo-local, checked in) declares: experiment id,
  fixture ids, execution mode (a single stage, or end-to-end), the treatment axes
  (harness, provider, model, effort), replicate count, randomization seed, concurrency,
  per-cell timeout, and output directory.
- A new **fixture contract** describes one frozen task: base commit, issue/spec input,
  stage-specific starting artifacts (e.g. a frozen plan for a review fixture, a frozen diff
  for a fix fixture), public checks, grader references, task category, risk classification,
  and provenance (`synthetic` | `harvested`).
- The runner **expands the treatment matrix deterministically** into an explicit run plan
  (one *cell* = fixture × treatment × replicate) and **persists that plan before executing
  anything**, so the population under test is auditable and reproducible from the seed.
- Every cell executes in a **fresh isolated worktree** checked out at the fixture's base
  commit. No two cells share a worktree, branch, session, generated file, issue, label, or
  comment.
- **Stage mode** invokes exactly one stage (`planning`, `plan-review`, `implementing`,
  `review`, `fix`, `shipcheck`) from the fixture's frozen inputs. **End-to-end mode** runs the
  normal state machine inside the isolated evaluation context.
- **Evaluation mode performs no production GitHub writes**: no label transition, no comment,
  no PR create/update/merge, no push to a production branch, on any real issue.
- Execution order is **seed-randomized and interleaved across harnesses** so provider-side
  drift (quota, load, model rollout) is spread across treatments rather than aliased onto
  one of them; a run is **resumable** and never re-executes an already-completed cell.
- Outcomes are separated into **distinct result classes**: `completed` (the treatment
  produced a result — success or failure *of the treatment*), `infra_error` (worktree, git,
  filesystem, runner defect), `auth_error` (missing/expired credentials, quota/rate limit),
  and `timeout`. Infrastructure and auth failures are never silently counted as treatment
  outcomes.
- Every cell record carries **join keys** — experiment id, fixture id, treatment id,
  replicate index, prompt hash, config hash, base SHA — so eval cells can be joined against
  ordinary pipeline run evidence.
- Results are written under an **additive, append-only filesystem contract**:
  `<output_dir>/<experiment-id>/{manifest.json,plan.json,runs.jsonl,failures.jsonl}`.
- Core scheduling/isolation/resume logic is unit- and integration-tested against **fake
  harness adapters**; CI makes no live model call and no network call.

Non-goals (explicitly out of scope, tracked elsewhere): defining objective graders or the
statistical report (#433); installing or authenticating provider CLIs; changing or reusing
the existing `eval-gate` stage as the orchestrator; publishing results to any hosted service;
and automatically selecting a production model/effort policy.

## Capabilities

### Added Capabilities
- `stage-eval-runner`: the manifest schema, deterministic matrix expansion and persisted run
  plan, per-cell worktree isolation, stage and end-to-end execution modes, the
  no-production-writes guarantee, seed-randomized interleaved scheduling, resumability,
  result classification, join keys, and the output filesystem contract.
- `eval-fixture-contract`: the frozen-fixture schema (base commit, task input, stage-entry
  artifacts, public checks, grader references, category, risk, provenance) and its validation
  rules, consumed by the runner and by the downstream grading work.

## Impact

- `core/scripts/evals/` (new) — manifest parsing/validation, fixture loading/validation,
  matrix expansion, seeded scheduler, per-cell executor, result writer.
- `core/scripts/pipeline.ts`, `core/scripts/command-registry.ts` — a new `evals` command
  surface (`run`, `plan`) with its allowed flags.
- `core/scripts/worktree.ts` — reuse (not fork) worktree creation for eval cells at an
  arbitrary base commit.
- `core/scripts/stages/*` — stage entry points invoked in evaluation mode; a mode flag that
  suppresses production GitHub writes.
- `core/test/evals-*.test.ts` (new) — expansion determinism, scheduling/interleaving,
  isolation, resume, result classification, no-production-writes, all against fakes.
- `.gitignore` — ignore the default eval output root (local-only run output).
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` — document the command.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).

## Acceptance Criteria

- [ ] A versioned experiment manifest is parsed and validated, declaring experiment id,
      fixture ids, mode (a named stage or `end-to-end`), treatment axes (harness, provider,
      model, effort), replicate count, seed, concurrency, per-cell timeout, and output
      directory; a manifest missing a required field or naming an unknown mode/fixture is
      rejected with a message naming the offending field, and no cell is executed.
- [ ] `pipeline evals plan <manifest>` expands the Cartesian treatment matrix and writes the
      full run plan (every fixture × treatment × replicate cell, each with a stable cell id)
      to `<output_dir>/<experiment-id>/plan.json` **before** any treatment is executed;
      running the expansion twice with the same manifest and seed produces byte-identical
      plans.
- [ ] A fixture file is validated against the fixture schema — base commit, task input,
      stage-entry artifacts, public checks, grader references, category, risk, and
      provenance (`synthetic` | `harvested`) — and an invalid fixture fails the experiment
      before execution rather than producing a degraded cell.
- [ ] Each cell runs in a worktree created fresh at the fixture's `base_commit`; a test
      asserts that no two cells are given the same worktree path, branch name, session id, or
      output path, and that a cell's writes are confined to its own worktree and its own
      result record.
- [ ] Stage mode executes exactly one of `planning`, `plan-review`, `implementing`, `review`,
      `fix`, `shipcheck` from the fixture's frozen inputs, invoking no other stage; a test
      asserts each stage is independently invocable and that the preceding stages are not run.
- [ ] End-to-end mode runs the normal state machine within the isolated evaluation context
      and produces one cell record per replicate.
- [ ] In evaluation mode the runner performs **zero** production GitHub writes: a test with a
      recording `gh` fake asserts no label set/remove, no comment, no PR create/edit/merge,
      and no push to a production branch occurs for any cell, in either mode.
- [ ] Execution order is derived from the manifest seed and interleaves harnesses rather than
      running all cells of one harness consecutively; the order is reproduced exactly by a
      rerun with the same seed, and a test asserts that consecutive cells do not all share
      one harness when more than one harness is present.
- [ ] Re-invoking `pipeline evals run` on an interrupted experiment executes only the cells
      with no completed record and leaves existing `runs.jsonl` records unmodified.
- [ ] Every result record carries a `result_class` of `completed`, `infra_error`,
      `auth_error`, or `timeout`; a test asserts a worktree-creation failure records
      `infra_error`, a credential/quota failure records `auth_error`, a per-cell timeout
      records `timeout`, and a harness that returns an unsuccessful treatment outcome records
      `completed` — never conflating the four.
- [ ] Every result record carries `experiment_id`, `fixture_id`, `treatment_id`, `replicate`,
      `prompt_hash`, `config_hash`, and `base_sha`, and those keys are sufficient to join a
      cell to an ordinary pipeline run artifact.
- [ ] Results are written additively to
      `<output_dir>/<experiment-id>/{manifest.json,plan.json,runs.jsonl,failures.jsonl}`;
      `runs.jsonl` and `failures.jsonl` are append-only (existing lines are never rewritten),
      and each line is an independently parseable JSON object.
- [ ] The runner writes nothing under `.agent-pipeline/runs/` for a production issue and does
      not alter any existing pipeline behavior when no experiment is invoked — a test asserts
      the ordinary pipeline code paths are untouched.
- [ ] Unit and integration tests cover manifest validation, expansion determinism, scheduling,
      isolation, resume, and result classification using fake harness adapters and injected
      dependency seams, with no real network, git, or subprocess calls; `npm run ci` is green.
