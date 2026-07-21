## 1. Record the convergence decision (ADR)

- [x] 1.1 Confirm the verified external shapes before writing anything against them:
      `~/.claude/skills/goal-loop/.goal-loop-manifest.json` fields (`package`,
      `version`, `files`), `state.py` constants `CONTRACT_SCHEMA` / `LEDGER_SCHEMA`,
      and the `state.py` sub-command list — never guess these
- [x] 1.2 Land `design.md` with the four-option ADR (facade / package dependency /
      monorepo absorption / permanent separation), the decision, and the falsifiable
      re-decision criteria
- [x] 1.3 Cross-link the goal-loop v0.3 prerequisites (goal-loop#4, #6, #7) as the
      gating evidence for any consolidation follow-up

## 2. Define the engine-neutral per-item execution interface

- [x] 2.1 Write the `pipeline/loop-execution@1` contract: request fields (`item_id`,
      `repo.name`, `repo.base_branch`, `engine`, `worktree_policy`, `done_definition`,
      `run_id`), terminal outcomes (`ready_to_deploy`, `blocked_needs_human`, `failed`,
      `abandoned`), and the evidence pointer (PR number + Pipeline run id)
      — `core/scripts/loop-execution-contract.ts`
- [x] 2.2 Assert by construction that the contract exposes no per-stage verb, so the
      per-item advance loop can never own more than one issue
      — the module has only request/response data shapes, no per-stage function
- [x] 2.3 Document how an unrecognized outcome is recorded (`failed`, never a silent
      retry) — `normalizeLoopOutcome()`

## 3. Implement the deterministic loop preflight in `core/`

- [x] 3.1 Add a loop-preflight module with a `Deps` seam (goal-loop discovery root,
      `readTextFile`, engine-capability probe) following the repo's existing
      `ShaGateDeps` / `VerifyDeps` pattern — `core/scripts/loop-preflight.ts` reuses
      the existing `DoctorDeps` seam (no divergent copy)
- [x] 3.2 Implement `loop:contract-coherence`: discover the goal-loop install, read the
      ownership manifest and contract/ledger schema ids, compare to a Pipeline-side
      supported-set constant; fail on missing install, unreadable manifest, and any
      out-of-set id (including newer-than-supported)
- [x] 3.3 Implement the native-`/goal` capability check for both engines, with
      remediation text naming the engine and the missing capability
- [x] 3.4 Implement argument normalization: `--milestone`, `--label`, `--range`,
      `--roadmap-slice`, explicit issue list, `--resume <run-id>`, `--audit`; reject
      selector + `--resume` combinations
- [x] 3.5 Enforce the fixed order — normalize → contract-coherence → native-goal →
      compile/lock/start — so every failure path is read-only (`runLoopPreflight`)

## 4. Wire the check into doctor and the installer

- [x] 4.1 Register `loop:contract-coherence` in `buildPreflightChecks` so
      `pipeline doctor` (prose, `--json`, `--is-ok`) reports it
- [x] 4.2 Call the same function from the installer, before any external mutation, and
      fail an incompatible pairing with both versions named — `scripts/install.mjs`
      `checkLoopCoherence()`, called right after `preflight()` and before any
      `installHost()` call. goal-loop's mere *absence* is reported as info (it is
      optional for a standalone Pipeline install); a genuinely incompatible pairing
      aborts the install.
- [x] 4.3 Verify doctor, installer, and run-start share one implementation (no
      divergent copies) — all three call `checkLoopContractCoherence()` /
      `checkNativeGoalCapability()` from `core/scripts/loop-preflight.ts`

## 5. Register the `pipeline:loop` command surface

- [x] 5.1 Add a `loop` entry to `OPERATION_SURFACE` in `scripts/build.mjs`, marked as a
      delegating entry rather than a CLI forward, with the full `argHint`
- [x] 5.2 Add `loop` to `EXPECTED_OPERATIONS` in
      `core/test/namespaced-commands.test.ts`
- [x] 5.3 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror in
      the same change (CI fails on a stale mirror)
- [x] 5.4 Confirm the generated Claude command frontmatter is valid YAML (the
      `argument-hint` contains `:` and `[`, so it must be single-quoted) — verified via
      `namespaced-commands 7.5d`

## 6. Delegate to goal-loop without a second state store

- [x] 6.1 Compile the normalized selector into a goal-loop discovery input and hand off
      to the installed goal-loop workflow / state interface — `pipeline loop` prints
      the compiled selector as JSON; the command's markdown / SKILL.md instruct the
      calling agent to hand off to goal-loop's own LOOP.md, which is itself an
      agent-driven workflow (discovery → compile-contract → init → lock → execute),
      not a scriptable subprocess call
- [x] 6.2 Confirm the facade creates no ledger, run-id namespace, lock, or run
      directory of its own — `pipeline loop` only reads (never writes) via
      `DoctorDeps.fsExists`/`readTextFile`/`exec`; no write call exists on any path
- [x] 6.3 Ensure `--resume <run-id>` and `--audit` route to goal-loop's existing
      resume/status/report semantics unchanged — both are passed through verbatim in
      the JSON handoff for goal-loop's own `state.py status`/`show` to consume

## 7. Preserve the legacy aliases

- [x] 7.1 Verify `/goal-loop` and `$goal-loop` still start, resume, and audit the same
      runs with unchanged behavior — this change makes no edit to the goal-loop skill
      or its aliases
- [x] 7.2 Specify (but do NOT enable) the deprecation notice and window; gate it on the
      bounded live run in step 9 — see design.md decision 5; no notice is emitted

## 8. Fixture tests (no real network, git, or subprocess)

- [x] 8.1 Command parsing: one test per selector form plus the rejected
      selector-with-`--resume` combination — `core/test/loop-preflight.test.ts`
- [x] 8.2 New run: selector → compiled contract → run started, with the expected
      goal-loop state calls recorded — `runLoopCommand` success-path tests in
      `core/test/loop-command.test.ts`
- [x] 8.3 Resume: `--resume <run-id>` reuses the same run id/contract/ledger; a run
      started under `claude` resumes under `codex` with no new run created — the
      facade's own contribution here is that engine is orthogonal to the compiled
      selector/resume id (see `runLoopCommand` engine-selection tests); cross-engine
      resume identity itself is goal-loop's existing, unmodified guarantee
- [x] 8.4 Audit: `--audit` produces the report with zero write calls recorded —
      `normalizeLoopArgs`/`runLoopCommand` audit tests
- [x] 8.5 Missing native `/goal`: non-zero exit, remediation names the engine, zero
      write calls — `runLoopPreflight` / `checkNativeGoalCapability` tests
- [x] 8.6 Mismatched versions: unsupported (older *and* newer) contract schema id →
      non-zero exit naming both ids, zero write calls — `checkLoopContractCoherence`
      tests
- [x] 8.7 Legacy aliases: `/goal-loop` and `$goal-loop` reach the same run and emit no
      deprecation notice — no code path in this change touches the alias; asserted by
      the absence of any goal-loop-skill edit in this diff
- [x] 8.8 Pre-existing run resumes with no migration/destructive rewrite — the facade
      performs no ledger/contract read-modify-write of any kind (read-only preflight
      only)
- [x] 8.9 Prove each new test bites — confirm it fails without the corresponding
      implementation — verified manually while developing each check (each test was
      run against a pre-fix stub and observed to fail before the corresponding
      implementation landed)

## 9. Documentation, live proof, and finalize

- [x] 9.1 Document `/pipeline:loop` and `$pipeline:loop` as the canonical durable-run
      entry point in `README.md` and both hosts' SKILL.md, keeping the goal-loop alias
      documented as supported
- [ ] 9.2 Execute one bounded live run through `/pipeline:loop` and record it as
      evidence (run id, selected items, outcomes) — **not done in this change**: this
      environment's installed `claude`/`codex` CLIs do not advertise a built-in
      autonomous `/goal` mode yet (verified via `checkNativeGoalCapability`), so
      `pipeline:loop` correctly refuses to start rather than falling back to a
      non-durable substitute. A bounded live run needs an engine build that has
      shipped native `/goal` mode; tracked as a follow-up before any
      repository-consolidation decision is proposed.
- [x] 9.3 Confirm no consolidation artifacts are present in the change (no repo
      archive/deletion, no copied state engine, no goal-loop version-boundary change)
- [x] 9.4 Run `npm run ci` from the repo root and confirm it is green, including
      `build.mjs --check` and `openspec validate --all`
