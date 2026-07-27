# Tasks — eval-agent-isolation-boundary (#607)

## 1. Declared execution sandbox mode

- [ ] 1.1 Add an explicit sandbox-mode input to harness invocation shaping: a new optional
  `InvokeOptions` field threaded into `AdapterInvocationContext` in
  `core/scripts/harness-adapters/types.ts`, consumed by `codexAdapter.buildInvocation`
  (`core/scripts/harness-adapters/codex.ts`). When the caller supplies a value it decides
  `--dangerously-bypass-approvals-and-sandbox` vs `--full-auto`; when absent, fall back to the
  existing `process.env.PIPELINE_CODEX_NO_SANDBOX === "1"` read so every current call site is
  byte-identical. Update the header comments in `harness.ts` and `codex.ts`.
- [ ] 1.2 Add the manifest field (`ExperimentManifest` in `core/scripts/evals/types.ts`) with a
  supported-value list and a managed-sandbox default; validate it in
  `core/scripts/evals/manifest.ts` alongside the other field checks (reject an unknown value naming
  the field, before any treatment runs).
- [ ] 1.3 Fold the resolved mode into `effectiveConfig` in `runCell` (so it enters `config_hash`) and
  onto `CellRecord` in `run.ts`; extend `CellRecord` in `types.ts`.
- [ ] 1.4 Pass the resolved mode from `runCell` through `realInvokeHarness` → `invoke()`; the eval
  path must never read `PIPELINE_CODEX_NO_SANDBOX`.
- [ ] 1.5 Tests: `harness.test.ts` — explicit mode selects each shape and differs only in the
  sandbox argument; explicit managed mode wins over an ambient `PIPELINE_CODEX_NO_SANDBOX=1`; no
  caller-supplied mode reproduces today's ambient behavior exactly (the existing two codex argv
  tests must keep passing unchanged). `evals-manifest.test.ts` — unknown mode rejected naming the
  field; omitted mode defaults to managed; two cells differing only by mode have different
  `config_hash`.

## 2. Eval agent instruction contract

- [ ] 2.1 Add a single-sourced contract asset under `core/scripts/evals/` (e.g.
  `agent-contract.ts` exporting the text plus the list of root-instruction filenames to install it
  at — `AGENTS.md`, `CLAUDE.md`), following the `review-schema.ts` single-source precedent.
- [ ] 2.2 Write the contract text covering the four required clauses: frozen-task-only scope; the
  prohibition list (planning delegation, nested worktrees, branch creation, commits, pushes, GitHub
  operations, pipeline advancement); no authority for repository workflow documents or installed
  skills; evaluation cell with no external side effects.
- [ ] 2.3 Add install/restore helpers in `core/scripts/evals/executor.ts` with a dependency seam
  (read/write/remove), capturing prior content in memory before writing.
- [ ] 2.4 Wire install before the first harness invocation in `runCell`; return `infra_error` without
  invoking the harness if installation fails.
- [ ] 2.5 Wire restore before `runChecks` and before `getChangedPaths`, and again (idempotently) in
  the existing `finally` block; a restore failure is logged + recorded as boundary evidence, never
  thrown (matches the existing non-fatal teardown convention).
- [ ] 2.6 Exclude the contract paths and the denial log from `detail.changed_paths` in
  `defaultGetChangedPaths`'s caller.
- [ ] 2.7 Tests: contract-drift test fails when any required clause is removed;
  `evals-executor.test.ts` — contract present at each path before the injected harness runs; restored
  on success, on harness failure, and on timeout; contract/denial-log paths never appear in
  `changed_paths`; install failure yields `infra_error` with no harness invocation.

## 3. Process-level command boundary

- [ ] 3.1 Add a cell-scoped deny-shim builder in `core/scripts/evals/executor.ts` (cell-scoped
  directory alongside `.eval-gh-config-empty`) containing interceptors for `gh` (deny all),
  `pipeline` (deny all), and `git` (deny `worktree`, `commit`, `push`, `remote`; pass everything
  else through to the real binary).
- [ ] 3.2 Each interceptor prints a named denial reason to stderr, exits non-zero, and appends one
  JSON line (`{ command, argv, category, at }`) to the cell-scoped denial log.
- [ ] 3.3 Prepend the shim directory to `PATH` in `isolatedGhEnv` (or a sibling that composes with
  it), keeping the change cell-scoped and leaving non-eval invocations untouched.
- [ ] 3.4 Read and parse the denial log after the harness returns; surface entries alongside the
  existing `ghRefusals`.
- [ ] 3.5 Tests: `evals-executor.test.ts` with injected fakes — denied categories produce a denial
  record and a non-zero result; a permitted git operation is passed through; the boundary env is
  scoped to the cell.

## 4. Durable boundary evidence

- [ ] 4.1 Add a boundary-evidence field to `CellRecord` (`core/scripts/evals/types.ts`) carrying both
  process denials and `gh`-surface refusals, plus a collection-failure reason field mirroring
  `trajectory_artifact_error`.
- [ ] 4.2 Persist it in `run.ts` — `runCell` already returns `ghRefusals` and today's `run.ts`
  **drops them**; carry both channels onto the record before `appendCellRecord`.
- [ ] 4.3 Confirm and pin that a boundary denial does not change `result_class` and that no grader in
  `core/scripts/evals/grading/` reads the new field.
- [ ] 4.4 Record boundary events on the trajectory `actions` list for diagnosis (kept out of grading
  input, consistent with #536's hidden-material containment).
- [ ] 4.5 Tests: `evals-run.test.ts` — a cell whose injected harness triggers a denial and a `gh`
  refusal persists both to `failures.jsonl`/`runs.jsonl` with an unchanged `result_class`; absent
  field means "no denials", a collection failure is recorded explicitly. Prove each test bites.

## 5. Documentation & mirror

- [ ] 5.1 Document the boundary and the declared sandbox mode in the evals documentation surface
  (manifest field, what is denied, where denials are recorded, and the known `PATH`-shim bypass
  limitation).
- [ ] 5.2 `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 5.3 `npm run ci` green from the repo root.

## 6. Validation against the reported failure

- [ ] 6.1 Re-check each acceptance criterion in `proposal.md` against the implemented behavior.
- [ ] 6.2 Confirm the two observed #607 modes are now covered: an externally sandboxed runner is
  configured by manifest declaration (not an ad hoc shell variable), and a treatment that adopts the
  repository's pipeline workflow is both instructed against it and denied at the command boundary,
  with the attempt recorded.
