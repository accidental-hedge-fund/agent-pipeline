## 1. Executable matrix inventory

- [x] 1.1 Add a TypeScript matrix inventory next to `ship-path-composition-coverage.ts` that declares operation, fault/state, public-entrypoint, and host dimensions, maps each required fault/state member to one FRG lifecycle class, and verify a unit test fails when a required class has neither a covering row nor a checked `not_applicable` reason
- [x] 1.2 Register numeric drive, `single`, `loop`, `train`, `merge`, merge-queue, `ship`, and every supervised disposition from the operation inventory as the operation dimension, and verify adding a new required dimension value without a row fails the inventory guard
- [x] 1.3 Encode checked `not_applicable` reasons as a closed set (including continuous-ship SemVer-only phases, hosts that cannot launch a verb, and example-only Hermes/OpenClaw), and verify those cells do not increment `covered_lifecycle_classes` or `missing_required_coverage`
- [x] 1.4 Wire inventory coverage into existing `aggregateUniqueOperationReliability` `covered_lifecycle_classes` rather than a new aggregator, and verify FRG `missing_required_coverage` increases when a required lifecycle class has no executed row

## 2. Stop stamping helper coverage

- [x] 2.1 Stop `passingUniqueOperationAttempts()` and `passingUniqueOperationManifest()` from declaring all five required lifecycle classes unless the matrix reports them covered, and verify the helper-stamp unit test fails while those helpers still stamp coverage
- [x] 2.2 Make release-eligible FRG refuse `pass: true` when unique-operation evidence lists covered classes the matrix did not execute for the scored candidate, and verify `validateReleaseEligibleFrgEvidence` names missing required coverage rather than a stable exclusion
- [x] 2.3 Keep `#740` hidden eval fixtures out of covering-module registration, and verify the inventory guard fails if a covering module path is an eval holdout fixture

## 3. Adapter-contract layer

- [x] 3.1 Add hermetic adapter-contract fixtures for exception, rejection, nonzero exit, signal, timeout, and malformed or contradictory output that inject at the operation-adapter seam, and verify each records a typed observation, does not let the adapter declare the run terminal, and performs no real network, git, or subprocess
- [x] 3.2 Add adapter-contract fixtures for interrupted or uncertain side effect, process death at each side-effect boundary, and strategy exhaustion, and verify mechanical rows end in Cooling or an external-condition wait with zero false-human and zero ownerless terminals
- [x] 3.3 Add adapter-contract fixtures for stale or corrupt durable state, event or ledger partial writes, candidate movement, dependency cycle, and no progress, and verify workflow-class rows stay owned and do not project human authority
- [x] 3.4 Add adapter-contract fixtures for unavailable harness, observer failure, clock or lease ambiguity, remote mutation, authentication, and unseen provider error shape, and verify infrastructure/authentication/unknown rows stay owned
- [x] 3.5 Add genuine Decision Request, Capability Request, and Authority Request fixtures, and verify each stops before unauthorized action and is not counted as a false-human projection
- [x] 3.6 Prove a fresh-process resume does not replay a known-complete side effect, and verify the test fails if the fixture mutates twice
- [x] 3.7 Register `#1362` typed preflight refusal and `#1344` candidate-engine provision as matrix fixtures, and verify they contribute typed observations rather than a second recovery policy

## 4. Installed-CLI black-box layer

- [x] 4.1 Drive the installed `pipeline` CLI through existing install-smoke seams with injected gh/harness/worktree fakes for numeric drive, `single`, `loop`, `train`, `merge`, merge-queue, and `ship`, and verify island unit tests alone cannot mark this layer covered
- [x] 4.2 Run supervised operation-inventory dispositions through the same installed-CLI harness, and verify a missing supervised disposition fails the inventory guard
- [x] 4.3 Assert mechanical installed-CLI rows produce no human projection, no ownerless terminal, and no terminal supervisor STOP, and verify a STOP-on-exhaustion stub fails those rows
- [x] 4.4 Keep installed-CLI rows free of live GitHub writes and production credentials, and verify the layer uses injected seams or install-smoke fakes

## 5. Host-conformance layer

- [x] 5.1 Evaluate `claude`, `codex`, `grok`, `opencode`, `omp`, and direct CLI through the existing outer-host conformance kit for required mechanical rows, and verify pass criteria are typed lifecycle outcomes rather than prompt-text equality
- [x] 5.2 Keep Hermes and OpenClaw as example-supervisor fixtures or checked `not_applicable`, and verify generated host packaging still does not treat them as shipped builtins
- [x] 5.3 Represent unsupported host capability as a typed Capability Request or checked `not_applicable` capability reason, and verify that cell is not a false-human projection

## 6. Ship-model coverage

- [x] 6.1 Add matrix rows for `#1024` `semver` and `continuous` ship models, and verify continuous SemVer-only phase cells are checked `not_applicable` rather than missing coverage
- [x] 6.2 Require SemVer phase rows when `roadmap.release_model` is `semver`, and verify a missing SemVer phase cell fails the inventory guard

## 7. Supersede terminal mechanical exhaustion

- [x] 7.1 Change autonomous recovery so mechanical and repair-budget exhaustion enter Cooling or an external-condition wait, and verify the former typed-engine-owned-terminal fixture fails
- [x] 7.2 Keep a live durable-loop drive that records `recovery_exhausted` in Cooling rather than a terminal run stop, and verify the former "live drive stays stopped" fixture fails
- [x] 7.3 Keep resume catch-up that repair-forwards already-ready GitHub identity on historical `recovery_exhausted` evidence, and verify `#1290`-style resume still persists ledger `ready` without a human ledger edit
- [x] 7.4 Stop train from STOPping a wave solely because a nested loop recorded mechanical or `recovery_exhausted` evidence, and verify independent ready-to-deploy siblings continue
- [x] 7.5 Preserve diagnostic quoting of `recovery_exhausted` as evidence text only, and verify train diagnostic text may still contain that token without treating it as lifecycle STOP

## 8. Delete legacy paths and add static guards

- [x] 8.1 Inventory command-local retry, recovery, parking, and STOP sites on supervised mutations, and verify each site maps to a replacement matrix row before deletion
- [x] 8.2 After each replacement row passes, delete the matching command-local path, and verify the obsolete implementation is absent from production modules
- [x] 8.3 Add a static guard that fails on retired recovery-controller imports, and verify a synthetic import fixture fails that guard
- [x] 8.4 Add a static guard that fails on command-local lifecycle `process.exit` for supervised mutations (read-only and bounded atomic administration remain documented), and verify a synthetic lifecycle-exit fixture fails that guard
- [x] 8.5 Add a static guard that fails on direct stage-label / `needs-human` writes from command modules, and verify a synthetic write fixture fails that guard
- [x] 8.6 Add a static guard that fails when production recovery routing switches on provider names or incident titles, and verify known GitHub/CI/conflict/auth/worktree strings appear only in fixtures

## 9. Docs, packaging, and CI

- [x] 9.1 Align `CONTEXT.md`, FRG runbook, CLI docs, and generated host SKILLs with matrix coverage, Cooling-on-exhaustion, and no command-local STOP guidance, and verify those surfaces no longer instruct a human to own mechanical exhaustion
- [x] 9.2 After any `core/` edit run `node scripts/build.mjs` and refresh generated docs if the generator is present, and verify `node scripts/build.mjs --check` passes
- [x] 9.3 Run `openspec validate prove-universal-fault-recovery` and `openspec validate --all`, and verify both exit 0
- [x] 9.4 Run `npm run ci` from the repo root, and verify the full gate passes
