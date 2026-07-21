## 1. Record the convergence decision (ADR)

- [ ] 1.1 Confirm the verified external shapes before writing anything against them:
      `~/.claude/skills/goal-loop/.goal-loop-manifest.json` fields (`package`,
      `version`, `files`), `state.py` constants `CONTRACT_SCHEMA` / `LEDGER_SCHEMA`,
      and the `state.py` sub-command list — never guess these
- [ ] 1.2 Land `design.md` with the four-option ADR (facade / package dependency /
      monorepo absorption / permanent separation), the decision, and the falsifiable
      re-decision criteria
- [ ] 1.3 Cross-link the goal-loop v0.3 prerequisites (goal-loop#4, #6, #7) as the
      gating evidence for any consolidation follow-up

## 2. Define the engine-neutral per-item execution interface

- [ ] 2.1 Write the `pipeline/loop-execution@1` contract: request fields (`item_id`,
      `repo.name`, `repo.base_branch`, `engine`, `worktree_policy`, `done_definition`,
      `run_id`), terminal outcomes (`ready_to_deploy`, `blocked_needs_human`, `failed`,
      `abandoned`), and the evidence pointer (PR number + Pipeline run id)
- [ ] 2.2 Assert by construction that the contract exposes no per-stage verb, so the
      per-item advance loop can never own more than one issue
- [ ] 2.3 Document how an unrecognized outcome is recorded (`failed`, never a silent
      retry)

## 3. Implement the deterministic loop preflight in `core/`

- [ ] 3.1 Add a loop-preflight module with a `Deps` seam (goal-loop discovery root,
      `readTextFile`, engine-capability probe) following the repo's existing
      `ShaGateDeps` / `VerifyDeps` pattern
- [ ] 3.2 Implement `loop:contract-coherence`: discover the goal-loop install, read the
      ownership manifest and contract/ledger schema ids, compare to a Pipeline-side
      supported-set constant; fail on missing install, unreadable manifest, and any
      out-of-set id (including newer-than-supported)
- [ ] 3.3 Implement the native-`/goal` capability check for both engines, with
      remediation text naming the engine and the missing capability
- [ ] 3.4 Implement argument normalization: `--milestone`, `--label`, `--range`,
      `--roadmap-slice`, explicit issue list, `--resume <run-id>`, `--audit`; reject
      selector + `--resume` combinations
- [ ] 3.5 Enforce the fixed order — normalize → contract-coherence → native-goal →
      compile/lock/start — so every failure path is read-only

## 4. Wire the check into doctor and the installer

- [ ] 4.1 Register `loop:contract-coherence` in `buildPreflightChecks` so
      `pipeline doctor` (prose, `--json`, `--is-ok`) reports it
- [ ] 4.2 Call the same function from the installer, before any external mutation, and
      fail an incompatible pairing with both versions named
- [ ] 4.3 Verify doctor, installer, and run-start share one implementation (no
      divergent copies)

## 5. Register the `pipeline:loop` command surface

- [ ] 5.1 Add a `loop` entry to `OPERATION_SURFACE` in `scripts/build.mjs`, marked as a
      delegating entry rather than a CLI forward, with the full `argHint`
- [ ] 5.2 Add `loop` to `EXPECTED_OPERATIONS` in
      `core/test/namespaced-commands.test.ts`
- [ ] 5.3 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror in
      the same change (CI fails on a stale mirror)
- [ ] 5.4 Confirm the generated Claude command frontmatter is valid YAML (the
      `argument-hint` contains `:` and `[`, so it must be single-quoted)

## 6. Delegate to goal-loop without a second state store

- [ ] 6.1 Compile the normalized selector into a goal-loop discovery input and hand off
      to the installed goal-loop workflow / state interface
- [ ] 6.2 Confirm the facade creates no ledger, run-id namespace, lock, or run
      directory of its own
- [ ] 6.3 Ensure `--resume <run-id>` and `--audit` route to goal-loop's existing
      resume/status/report semantics unchanged

## 7. Preserve the legacy aliases

- [ ] 7.1 Verify `/goal-loop` and `$goal-loop` still start, resume, and audit the same
      runs with unchanged behavior
- [ ] 7.2 Specify (but do NOT enable) the deprecation notice and window; gate it on the
      bounded live run in step 9

## 8. Fixture tests (no real network, git, or subprocess)

- [ ] 8.1 Command parsing: one test per selector form plus the rejected
      selector-with-`--resume` combination
- [ ] 8.2 New run: selector → compiled contract → run started, with the expected
      goal-loop state calls recorded
- [ ] 8.3 Resume: `--resume <run-id>` reuses the same run id/contract/ledger; a run
      started under `claude` resumes under `codex` with no new run created
- [ ] 8.4 Audit: `--audit` produces the report with zero write calls recorded
- [ ] 8.5 Missing native `/goal`: non-zero exit, remediation names the engine, zero
      write calls
- [ ] 8.6 Mismatched versions: unsupported (older *and* newer) contract schema id →
      non-zero exit naming both ids, zero write calls
- [ ] 8.7 Legacy aliases: `/goal-loop` and `$goal-loop` reach the same run and emit no
      deprecation notice
- [ ] 8.8 Pre-existing run resumes with no migration/destructive rewrite
- [ ] 8.9 Prove each new test bites — confirm it fails without the corresponding
      implementation

## 9. Documentation, live proof, and finalize

- [ ] 9.1 Document `/pipeline:loop` and `$pipeline:loop` as the canonical durable-run
      entry point in `README.md` and both hosts' SKILL.md, keeping the goal-loop alias
      documented as supported
- [ ] 9.2 Execute one bounded live run through `/pipeline:loop` and record it as
      evidence (run id, selected items, outcomes)
- [ ] 9.3 Confirm no consolidation artifacts are present in the change (no repo
      archive/deletion, no copied state engine, no goal-loop version-boundary change)
- [ ] 9.4 Run `npm run ci` from the repo root and confirm it is green, including
      `build.mjs --check` and `openspec validate --all`
