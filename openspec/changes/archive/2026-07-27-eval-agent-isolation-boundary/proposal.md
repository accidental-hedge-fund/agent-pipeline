## Why

The harness/model evaluation (#600, #602) produced two invalid local-Codex treatment cells, and
neither was caught by the evaluator's existing isolation controls. First, on an externally
sandboxed runner Codex died before it could reach the repository (`bwrap: loopback: Failed
RTM_NEWADDR: Operation not permitted`) unless an operator happened to know about the undocumented-
in-the-manifest `PIPELINE_CODEX_NO_SANDBOX=1` shell escape hatch — so the experiment's actual
execution environment was an unrecorded property of one operator's shell rather than a declared,
reproducible part of the experiment. Second, once that hatch was applied, the harness read the
checked-out repository's `AGENTS.md`, concluded it was doing normal pipeline work, created a nested
`.claude/worktrees/...` worktree, and invoked unrelated `pipeline` commands instead of performing
the frozen eval task. The cell had to be killed by hand before any score existed.

Today's evaluation controls (`createEvalGhSurface`'s refusing `gh` seam and `isolatedGhEnv`'s
credential stripping in `core/scripts/evals/executor.ts`) only stop *pipeline-wired GitHub writes*
and *authenticated* git/gh access. They give a local CLI harness no eval-specific instruction
contract, and they do nothing to stop an in-worktree nested worktree, a local commit, or a
`pipeline` advance — the exact behaviours observed. An evaluator that cannot keep a treatment inside
the cell boundary cannot produce model evidence; the partial experiments
`primary-model-screen-20260727` and `primary-model-screen-20260727b` are diagnostic artifacts, not
measurements.

## What Changes

- **Eval agent contract per cell.** Before the first harness invocation, the executor installs an
  eval-scoped root instruction contract into the cell's worktree at the paths the local CLI
  harnesses actually read as root instructions (`AGENTS.md`, `CLAUDE.md`), preserving any prior
  content and restoring the worktree to its `base_commit` state before checks, changed-path
  collection, and teardown — so the contract can never be scored as a treatment-produced change.
- **Contract content is specified, single-sourced, and drift-guarded.** It requires direct work on
  the frozen task only; prohibits planning delegation, nested worktrees, commits, pushes, GitHub
  operations, and any pipeline stage advancement; and states that repository workflow documents and
  installed pipeline skills carry **no authority** inside an evaluation cell.
- **Enforcement at the command boundary, not in prompt text.** Each cell gets a cell-scoped deny
  shim directory prepended to the harness child's `PATH` containing interceptors for `gh`,
  `pipeline`, and `git`. Denied categories are, at minimum: nested worktree creation, pipeline
  stage advancement, commit, push/remote mutation, and GitHub writes. A denied invocation exits
  non-zero with a named reason and is appended to a cell-scoped denial log.
- **Denied attempts become durable cell evidence, classified apart from correctness.** Cell records
  gain an isolation-boundary evidence field carrying both process-level denials and the previously
  **dropped** `gh` refusals (`runCell` returns `ghRefusals`; `run.ts` never persists them today). A
  boundary denial is an isolation event: it never silently changes `result_class` and is never
  folded into a grader's correctness score.
- **The externally sandboxed Codex mode becomes a declared evaluator capability.** The experiment
  manifest declares the execution sandbox mode explicitly; the eval runner resolves it and passes it
  into adapter invocation shaping rather than depending on ambient `PIPELINE_CODEX_NO_SANDBOX` in an
  operator's shell. The resolved mode is recorded on every cell record and enters the cell's config
  identity, so cells run under different sandbox modes are never pooled as if identical.
- **Injection-based regression tests** for Codex invocation shaping under each declared sandbox
  mode, and for a fake treatment that attempts a nested worktree / `pipeline` advance — proving the
  attempt is denied, recorded, and kept out of the correctness signal. No live model calls, no real
  git, gh, or subprocess use, per the repo's dependency-seam rule.

Out of scope: re-running or re-scoring the invalidated `primary-model-screen-20260727*` experiments;
changing grader rubrics; changing non-eval pipeline invocation behaviour (the ambient
`PIPELINE_CODEX_NO_SANDBOX` escape hatch stays exactly as-is for ordinary pipeline runs).

## Acceptance Criteria

- [ ] Running a local-CLI eval cell installs an eval root instruction contract into the cell
      worktree before the first harness invocation, at every root-instruction path the target
      harness reads.
- [ ] After the cell completes (including on failure, timeout, or an exception path), the worktree's
      root-instruction paths are restored to their `base_commit` content, and the contract file
      never appears in the cell's `changed_paths` evidence.
- [ ] The contract text states all four of: work directly on the frozen task only; no planning
      delegation, worktrees, commits, pushes, GitHub operations, or pipeline advancement; repository
      workflow documents and installed skills have no authority in the cell; the cell is an
      evaluation with no external side effects. A test fails if any of these clauses is removed.
- [ ] A treatment that runs `git worktree add …`, `pipeline advance …` (or any `pipeline` subcommand
      that advances stage state), `git commit`, `git push`, or `gh <write>` inside a cell receives a
      non-zero exit and a named denial reason from the boundary, and the underlying action does not
      occur.
- [ ] Every denial is present in the cell's durable record (`runs.jsonl` / `failures.jsonl`) as a
      structured isolation-boundary entry naming the attempted command and its denial category.
- [ ] `gh` refusals recorded by `createEvalGhSurface` reach the same durable cell evidence (they are
      dropped today).
- [ ] A boundary denial alone does not change a cell's `result_class`, and no grader reads the
      boundary-denial evidence as a correctness input.
- [ ] The experiment manifest declares the execution sandbox mode; an unknown value is rejected
      before any treatment executes, naming the offending field.
- [ ] The eval runner never reads `PIPELINE_CODEX_NO_SANDBOX` to decide a cell's Codex invocation;
      an injection test shows the declared mode alone selects
      `--dangerously-bypass-approvals-and-sandbox` vs `--full-auto`, with the rest of the argv
      byte-identical.
- [ ] The resolved sandbox mode appears on each cell record and is part of the cell's config
      identity, so two cells differing only by sandbox mode produce different config hashes.
- [ ] Ordinary (non-eval) pipeline invocations are byte-identical to today for both built-in
      harnesses, including the ambient `PIPELINE_CODEX_NO_SANDBOX=1` bypass path.
- [ ] `npm run ci` is green, including the regenerated `plugin/` mirror.

## Capabilities

### New Capabilities

- `eval-agent-isolation-boundary`: the eval-scoped agent/command boundary for a local harness cell —
  the installed-and-restored root instruction contract, its required content, process-level denial
  of the high-risk command set, durable boundary-denial evidence classified apart from correctness,
  and the declared (not ad hoc) execution sandbox mode.

### Modified Capabilities

- `stage-eval-runner`: the manifest gains a validated execution-sandbox-mode field; cell records
  gain isolation-boundary evidence; the "no production GitHub writes" requirement is strengthened
  from "the eval `gh` surface refuses" to "the surface refuses **and** the process boundary denies
  direct CLI writes, and every refusal/denial is durably recorded on the cell".
- `cli-harness-adapters`: Codex invocation shaping takes the external-sandbox mode from an explicit
  caller-supplied value, falling back to the ambient environment variable only when the caller
  declares none; all argv shapes stay byte-identical.

## Impact

- `core/scripts/evals/executor.ts` (contract install/restore, deny-shim `PATH`, denial collection,
  sandbox-mode plumbing), `core/scripts/evals/run.ts` (persist boundary evidence — currently drops
  `ghRefusals`), `core/scripts/evals/types.ts` (manifest + `CellRecord` fields),
  `core/scripts/evals/manifest.ts` (validation + config hash), `core/scripts/evals/gh-eval-surface.ts`
  (refusal record shape reuse).
- `core/scripts/harness-adapters/codex.ts` + `core/scripts/harness.ts` (explicit sandbox-mode input;
  ambient env var becomes the fallback, not the only source).
- New eval contract text asset under `core/scripts/evals/` (single-sourced, drift-guarded like
  `review-schema.ts` → `{{schema_block}}`).
- Tests: `core/test/evals-executor.test.ts`, `core/test/evals-run.test.ts`,
  `core/test/evals-manifest.test.ts`, `core/test/harness-adapters.test.ts` (or the golden-argv test
  that pins Codex argv).
- `plugin/` mirror regeneration (`node scripts/build.mjs`).
- No change to the label-driven state machine, no new autonomy, no `auto_merge` surface.
