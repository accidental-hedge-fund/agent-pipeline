## 1. Ownership record and ternary classifier

- [x] 1.1 Add a versioned durable ownership-record type (schema version, issue, stage, attempt id, worktree path, pre-HEAD, pre-porcelain, in-flight, last-known/post porcelain, result class) with host-local run-store persistence and hydration, and verify a unit test round-trips a record after discarding in-memory state.
- [x] 1.2 Implement the shared leftover-vs-unknown classifier (scratch | owned leftover | unknown product) as a pure helper next to `classifyWorktreeDirt`, and verify tests cover: clean pre + timeout edits = owned; extra paths after post-snapshot = unknown; missing record = empty owned set; scratch-only is not owned.
- [x] 1.3 Fail closed when the pre-attempt record cannot be made durable (do not spawn, do not claim ownership), and verify a unit test asserts no harness spawn on write failure.

## 2. Snapshot before spawn and last-known refresh

- [x] 2.1 Write and durable-flush the pre-snapshot at the shared product-mutating harness-round / invoke seam (implement, fix-round, test-fix, pre-merge auto-fix) **before** child spawn, and verify a unit test fails if spawn occurs before the record exists.
- [x] 2.2 Refresh last-known porcelain on a bounded in-flight heartbeat and write a post-snapshot on the timeout/crash path when the process can still run, and verify tests cover heartbeat last-known plus timeout post-snapshot using fake clocks/storage.
- [x] 2.3 Clear in-flight only when the attempt completes with no owned leftovers, bound the record to attempt id and pre-HEAD, and verify a later dirty tree without a current in-flight record classifies as unknown.
- [x] 2.4 Hard-kill with no last-known/post does not claim pre-attempt product porcelain as owned; only newly attributable paths checkpoint; pre-existing unknown dirt still blocks.

## 3. Checkpoint recipe and salvage scope

- [x] 3.1 Add deterministic recipe `checkpoint_owned_harness_dirt` that salvages **owned paths only** (existing salvage subject, trailers, `node_modules` and marker exclusions), and verify mixed owned+unknown dirt commits only owned paths and leaves unknown unstaged (not discarded).
- [x] 3.2 Apply checkpoint after HEAD movement (intermediate commit) and on new-process re-entry, and verify tests cover timeout after product edits, timeout after intermediate commit plus later edits, and a no-op when leftovers were already salvaged.
- [x] 3.3 Wire the default engine-owned recovery policy to `unlink_engine_scratch` then `checkpoint_owned_harness_dirt` then `repair_pipeline_item`, and verify a policy-order unit test fails if implementer repair is first for owned-leftover evidence.
- [x] 3.4 Execute the recipe from `realExecuteRecovery` when owned-leftover evidence is current (single, loop, and train share the executor), and verify success does not mint a human hold and does not invoke `repair_pipeline_item` for that attempt when unknown dirt is empty.

## 4. Dirt-trust gates and implementing-resume

- [x] 4.1 Consult ownership in format-gate pre-flight: unknown product dirt still blocks with "pre-existing uncommitted changes" and does not run auto-fix; owned leftovers do not trip that guard and are not committed as `chore: auto-format`; verify existing unknown-dirt tests still bite and a new leftover test would fail without the consult.
- [x] 4.2 Consult ownership in test-gate dirty trust the same way (owned leftovers are not unknown product; unknown product still attempts-0 hard-blocks with path disclosure), and verify injectable tests for leftover-only vs unknown vs mixed.
- [x] 4.3 Change `dispatchResume` / `resumeFromImplementing` so commits-ahead does not skip the implementer when ownership shows an interrupted incomplete implement with owned leftovers; checkpoint first; re-invoke implementer when the deliverable is unsatisfied; verify a `#758`-class fixture (intermediate commit + leftover product files, new process) runs checkpoint + implementer and does not format-gate-block in four seconds with zero implementer calls.
- [x] 4.4 After checkpoint, if implement-deliverable-present is satisfied and the tree is clean of unknown dirt, allow the post-implement path without an empty implementer commit, and verify that path still runs format/test gates on the checkpointed HEAD.

## 5. Evidence, block kind, and drift guard

- [x] 5.1 Emit durable terminal evidence with exactly one disposition among `recovered`, `checkpointed`, `resumed`, `rejected` (rejected discloses unknown paths), and verify summary/blocker consumers can read those tokens from a fake run-store.
- [x] 5.2 Use blocker kind `harness-failure` (projects `workflow-engine-defect`) for residual owned-leftover blocks, never `needs-human` / `human-decision-required`, and verify a composition test fails if leftover residual parks as human.
- [x] 5.3 Extend the porcelain dirt-site inventory so dirt-trust sites record ownership consultation, and verify the drift-guard fails when a new auto-fix/resume dirt-trust site omits that disposition.

## 6. Mirror, validate, CI

- [x] 6.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes.
- [x] 6.2 Run `openspec validate resume-owned-harness-timeout-dirt` until clean, then `npm run ci` from the repo root, and verify both are green.
