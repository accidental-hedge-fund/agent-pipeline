## 1. Shared worker-identity probe

- [x] 1.1 Extract pid, starttime, boot-identity, and heartbeat freshness from `pack-loop-liveness.ts` into a shared probe used by pack-loop and the Liveness Provider, and verify pack-loop liveness unit tests still pass with the same injected evidence
- [x] 1.2 Keep pack-loop handoff kind and FRG prepare JSON in `pack-loop-liveness.ts` as a caller of the shared probe, and verify a fixture still treats a non-terminal ledger without a live worker as `not-live` rather than verified completion

## 2. Liveness Provider core

- [x] 2.1 Add a Liveness Provider module that discovers same-host durable runs with a resume binding, non-terminal ledger, and `not-live` worker, and verify a unit test with injected store/lock/identity deps lists that run and hides verified-complete, cancelled, and cross-host records
- [x] 2.2 Claim the existing issue-run lock or loop-store lock (pid + starttime + token) before attach, and verify two concurrent restore fixtures grant exactly one fence and start no second supervisor
- [x] 2.3 Attach the same supervisor through existing `--resume` / `recoverLock` / detached re-entry, refresh worker identity, and verify the fixture keeps the original run identity and Logical Operation
- [x] 2.4 Treat wrapper `sentinel.json` with a non-zero exit as attempt evidence, and verify a non-zero sentinel plus unproven postcondition remains eligible and is not verified completion
- [x] 2.5 Relinquish the fence only after terminal evidence RecoverySupervisor already owns, and verify follow interruption or #1302 sink failure leaves the ledger unchanged
- [x] 2.6 Reject human-authority projection on worker death, and verify a fixture that classifies dead-worker as needs-human or a Decision Request fails

## 3. CLI status and restore

- [x] 3.1 Register `pipeline liveness status` and `pipeline liveness restore` as liveness surfaces (not recovery or merge), and verify command-registry help names them as discover/claim/reattach only
- [x] 3.2 Make `liveness status` emit `configured`, `available`, `active`, or `degraded` / `unavailable` with a typed capability condition, and verify injected adapter fixtures cover those four states
- [x] 3.3 Make `liveness restore` walk eligible runs and attach without calling repair or fault classification, and verify a restore fixture does not import recovery-recipe selection
- [x] 3.4 Keep `pipeline doctor` free of restore side effects, and verify doctor with a dead eligible run reports status only and does not attach a supervisor

## 4. Doctor continuous-liveness check

- [x] 4.1 Add doctor check `liveness:continuous` that consumes liveness status through injectable deps, and verify `--json` exposes the discriminant on the check record
- [x] 4.2 Report unconfigured keep-alive as a typed capability condition with `warn` or `skip`, and verify that absence does not fail doctor and does not use needs-human language
- [x] 4.3 Report a configured broken adapter as `degraded` / `unavailable` with remediation that names the adapter, and verify the copy is not a human-authority class
- [x] 4.4 Cover the check with doctor-deps unit tests and no real systemd, launchd, container, network, git, or subprocess calls, and verify the tests fail if those I/O seams are used

## 5. Detach and loop attach paths

- [x] 5.1 Route same-host dead-wrapper re-entry for a non-terminal detached run through the provider so the existing run identity is restored, and verify a second `--detach` against a live holder still exits non-zero
- [x] 5.2 Keep durable-loop dead-pid recovery on the same host as non-terminal resume, and verify the ledger does not record `run_fatal` or a terminal stop solely from worker death
- [x] 5.3 Document systemd, launchd, container, and harness-worker adapters as invoke-restore wrappers of the same CLI, and verify an injected adapter fixture calls restore rather than a host-specific recipe

## 6. Host artifacts and conformance

- [x] 6.1 Update `renderHostSkill` so generated SKILLs name shared liveness restore and portable follow for dead worker and interrupted follow, and verify they do not instruct fault classification, retry of `pipeline single`, or merge-from-follow
- [x] 6.2 Keep `SKILL_HOST_IDS` as `claude`, `codex`, `grok`, `opencode` with no OMP SKILL and no Hermes/OpenClaw membership, and verify generation and set-parity tests still fail on drift
- [x] 6.3 Constrain `examples/supervisor` Hermes and OpenClaw packs to launch, follow, reattach, answer, cancel, and notification, and verify a fixture fails if those packs classify recovery or retry a supervised verb
- [x] 6.4 Extend the outer-host conformance kit with liveness restore fixtures for builtin hosts plus direct CLI, and verify pass criteria are typed lifecycle outcomes rather than prompt-text equality
- [x] 6.5 Represent unsupported restore or follow as a typed Capability Request or checked `not_applicable`, and verify that cell is not a False-human projection
- [x] 6.6 Keep #971 wrappers as a non-authoritative baseline that calls the same restore/follow CLI, and verify they are not registered as the lifecycle owner

## 7. Docs, packaging, and CI

- [x] 7.1 Align `CONTEXT.md`, CLI docs, and doctor docs with Liveness Provider scope, doctor discriminants, and dead-worker-is-not-terminal, and verify those surfaces do not tell a human to own worker death
- [x] 7.2 After any `core/` edit run `node scripts/build.mjs` and verify `node scripts/build.mjs --check` passes
- [x] 7.3 Run `openspec validate host-neutral-liveness-reattach` and `openspec validate --all`, and verify both exit 0
- [x] 7.4 Run install smoke and `npm run ci` from the repo root, and verify the full gate passes
