## 1. Fixture contract

- [x] 1.1 Define the fixture type in `core/scripts/evals/fixture.ts`: `fixture_id`,
      `schema_version`, `base_commit`, task input, stage-entry artifacts (keyed by stage),
      public checks, grader references, `category`, `risk`, `provenance`.
- [x] 1.2 Implement `loadFixture()` / `validateFixture()` with a runtime validator (types are
      stripped, so the invariant needs a real runtime check), rejecting missing fields, a
      non-full-SHA `base_commit`, an unsupported `schema_version`, an invalid `provenance`, and
      a fixture lacking stage-entry artifacts for the targeted stage — each with a message
      naming the fixture and the field.
- [x] 1.3 Add one checked-in example fixture per supported stage under `core/evals/fixtures/`
      for use by tests and as the authoring reference.

## 2. Manifest and expansion

- [x] 2.1 Define the manifest type in `core/scripts/evals/manifest.ts` with `schema_version`,
      `experiment_id`, `fixture_ids`, `mode`, treatment axes, `replicates`, `seed`,
      `concurrency`, `timeout`, `output_dir` (default `.agent-pipeline/evals`).
- [x] 2.2 Implement `validateManifest()` rejecting missing fields, unknown mode, unknown
      fixture reference, and unsupported schema version — naming the offending field.
- [x] 2.3 Implement pure `expandPlan(manifest, fixtures)` producing one cell per
      fixture × treatment × replicate with a deterministic `cell_id`
      (`<experiment>/<fixture>/<treatment>/<replicate>`) and a deterministic `treatment_id`
      slug over the treatment axes.
- [x] 2.4 Implement `computePromptHash()` / `computeConfigHash()` over the materialized prompt
      text and the effective per-cell config.

## 3. Scheduling

- [x] 3.1 Implement a seeded PRNG and `scheduleCells(plan, seed)` producing a reproducible
      permutation.
- [x] 3.2 Apply harness interleaving so consecutive cells rotate across harnesses when more
      than one harness is present.
- [x] 3.3 Implement the bounded-concurrency executor honouring the manifest `concurrency`.
- [x] 3.4 Implement resume: read existing completed records, subtract their `cell_id`s from the
      schedule, and never rewrite an existing record.

## 4. Isolation and execution

- [x] 4.1 Extend the worktree helper (reuse `core/scripts/worktree.ts`, do not fork it) to
      create a worktree at an arbitrary base commit.
- [x] 4.2 Allocate per-cell worktree path, branch name, session identity, and output paths from
      the `cell_id`, so no two cells — including replicates — can collide.
- [x] 4.3 Implement the evaluation-mode GitHub surface: a `gh` seam that refuses every mutating
      operation (label set/remove, comment create/edit, PR create/edit/merge, push to a
      production branch) and records the refusal.
- [x] 4.4 Implement stage-mode execution: invoke exactly one of `planning`, `plan-review`,
      `implementing`, `review`, `fix`, `shipcheck` from the fixture's stage-entry artifacts,
      with no predecessor stage run.
- [x] 4.5 Implement end-to-end mode: run the state machine inside the isolated evaluation
      context, one cell record per replicate.
- [x] 4.6 Enforce the per-cell timeout, terminating the cell's harness process on expiry.
- [x] 4.7 Tear down each cell's worktree after execution, scoped strictly to that cell's
      worktree path.

## 5. Result recording

- [x] 5.1 Classify each cell outcome into `completed` | `infra_error` | `auth_error` |
      `timeout`, mapping harness/adapter failures onto `auth_error` only for credential, quota,
      and rate-limit refusals.
- [x] 5.2 Write `<output_dir>/<experiment-id>/manifest.json` (the resolved manifest as
      executed) and `plan.json` before the first treatment executes.
- [x] 5.3 Append `completed` cells to `runs.jsonl` and the three failure classes to
      `failures.jsonl`, one independently parseable JSON object per line, append-only.
- [x] 5.4 Include `experiment_id`, `fixture_id`, `treatment_id`, `replicate`, `prompt_hash`,
      `config_hash`, `base_sha` on every record.
- [x] 5.5 Route every artifact write through the repo's existing non-fatal-write and
      injection-denylist conventions.

## 6. CLI surface

- [x] 6.1 Add `pipeline evals plan <manifest>` (expand and persist the plan; invoke no harness,
      create no worktree) and `pipeline evals run <manifest>` to `core/scripts/pipeline.ts`.
- [x] 6.2 Register the `evals` command and its allowed flags in
      `core/scripts/command-registry.ts`, and add its `--help` usage lines.
- [x] 6.3 Add `.agent-pipeline/evals/` to `.gitignore` as local-only run output.

## 7. Tests

- [x] 7.1 Manifest validation: missing field, unknown mode, unknown fixture, unsupported schema
      version — each fails by name and executes nothing.
- [x] 7.2 Fixture validation: missing field, non-full-SHA base commit, bad provenance, missing
      stage-entry artifacts for the targeted stage, unsupported schema version.
- [x] 7.3 Expansion determinism: expanding the same manifest twice yields identical cells,
      `cell_id`s, and order.
- [x] 7.4 Plan-before-execute: the plan file exists before the first fake harness invocation;
      `evals plan` invokes no harness and creates no worktree.
- [x] 7.5 Scheduling: same seed reproduces the same order; consecutive cells interleave
      harnesses when more than one harness is present.
- [x] 7.6 Isolation: no two cells (including replicates) share a worktree path, branch, session
      identity, or output path; a cell's writes are not visible to another cell.
- [x] 7.7 No production writes: a recording `gh` fake shows zero label/comment/PR/push mutations
      across a full matrix in both stage and end-to-end mode; a stage that attempts one is
      refused and the refusal is recorded.
- [x] 7.8 Resume: an interrupted experiment re-executes only incomplete cells and leaves
      existing records byte-identical.
- [x] 7.9 Result classification: worktree failure → `infra_error`; credential/quota failure →
      `auth_error`; timeout → `timeout`; unsuccessful treatment outcome → `completed`.
- [x] 7.10 Join keys: every record carries all seven identity keys; differing materialized
      prompt or effective config yields differing hashes.
- [x] 7.11 Output contract: append-only `runs.jsonl` / `failures.jsonl`, each line
      independently parseable, failures excluded from `runs.jsonl`.
- [x] 7.12 Stage independence: each of the six stages is invocable alone with no predecessor
      stage invoked.
- [x] 7.13 All tests use injected fakes — no live model call, network, git, or subprocess.

## 8. Docs, mirror, gate

- [x] 8.1 Document the `evals` command, the manifest fields, and the fixture schema in
      `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`, stating that evaluation mode performs
      no production GitHub writes.
- [x] 8.2 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [x] 8.3 Run `npm run ci` from the repo root and confirm it is green.
