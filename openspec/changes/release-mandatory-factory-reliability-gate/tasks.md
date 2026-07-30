## 1. Runbook, taxonomy, and evidence schema

- [x] 1.1 Author `docs/factory-reliability-gate-runbook.md` (or hosts-skill equivalent) covering:
      driver invocation, concurrency settings, scenario-pack selection/creation, numeric thresholds
      (K clean ready-to-deploy, N capacity stress, max engine-class rate), blocker taxonomy
      (engine-class vs product-class vs human-authority), evidence path/layout, release attachment
      steps, and the hard rule: no release tag without FRG pass for that version.
- [x] 1.2 Define the machine-readable FRG evidence JSON schema (`schema_version`, `version`,
      `run_id`, `pass`, `scenarios[]`, `scoreboard`, `thresholds`) and document field meanings in
      the runbook.
- [x] 1.3 Map each scenario id (`capacity-blocked-retain`, `resume-mid-flight`,
      `openspec-multi-change`, `implement-lockfile-dirt`, `local-docs-parity`,
      `clean-item-throughput`, `blocker-taxonomy`, `pr-supersession`, `release-plan-row`,
      `empty-depends-on-stack-honesty`) to pass criteria and to Layer A vs Layer B ownership.

## 2. Hermetic Layer A scenario pack

- [x] 2.1 Add hermetic composition tests for `capacity-blocked-retain` (low max worktrees, blocked
      retain ≥ N, next eligible item must not false-block as needs-human solely for capacity).
- [x] 2.2 Add hermetic tests for `resume-mid-flight` (supervisor interrupt/resume; no permanent dead
      `pr_opened` strand; live next_action for in-flight items).
- [x] 2.3 Add hermetic tests for `openspec-multi-change` (shared active-change set / archive pass
      vs residual still-active coherence; foreign or partial archive cases).
- [x] 2.4 Add hermetic tests for `implement-lockfile-dirt` (uncommitted lockfile after HEAD
      advanced; fold/clean path; no human-block on known lock dirt with 0 attempts).
- [x] 2.5 Add hermetic tests for `local-docs-parity` (docs/generator failure surfaces before PR open
      or before ready-to-deploy, matching CI parity intent).
- [x] 2.6 For any required Layer A scenario not yet testable, add an explicit waiver entry naming
      scenario id + tracking issue (no silent gaps); prove each implemented assertion bites.
- [x] 2.7 Confirm Layer A tests use injected deps only (zero real network/git/subprocess) and run
      under `core` unit suite / `npm test`.

## 3. Live Layer B driver

- [x] 3.1 Implement FRG driver CLI entrypoint (e.g. `pipeline factory-gate` or
      `pipeline release-check --for <version>`) that resolves target version and documented
      concurrency settings.
- [x] 3.2 Implement scenario-pack work-list selection or fixture creation (synthetic/scratch or
      labeled reliability pack — not full product milestone).
- [x] 3.3 Wire driver to start multi-item durable loop via shipped runtime (no second ledger/lock
      namespace).
- [x] 3.4 Project per-item outcomes and blocker taxonomy scoreboard from durable ledger/events into
      the FRG evidence report; compute overall `pass` against runbook thresholds (K, N, engine-class
      rate, required scenario outcomes).
- [x] 3.5 Persist immutable evidence under the stable path from the runbook; support `--json`
      machine-readable output; exit non-zero on `pass: false` or incomplete evidence.
- [x] 3.6 Cover `pr-supersession`, `release-plan-row`, and `empty-depends-on-stack-honesty` in the
      live pack (and hermetic where feasible); surface warn/fail for empty-depends_on OpenSpec
      stacking.

## 4. Release integration

- [x] 4.1 Extend `pipeline release` to look up FRG evidence for the resolved version and fail closed
      when missing, unparsable, or `pass: false` (additive to existing `npm run ci` gate).
- [x] 4.2 On successful FRG check, attach/include FRG `run_id` + pass summary on the release PR
      surface (body section or comment).
- [x] 4.3 Add unit tests for release FRG refusal and attachment seams via injected deps (no real
      network).
- [x] 4.4 Document the release refuse rule in release/operator docs cross-linking the FRG runbook.

## 5. First live FRG and repeatability proof

- [ ] 5.1 Execute a live FRG for the first shipping release after the gate lands (target v1.29.1)
      and retain the evidence artifact with `pass: true`.
      _Operator step at release cut — procedure + driver ready; not executed in implement PR._
- [ ] 5.2 Link the FRG `run_id` from the release PR / issue #723 evidence notes.
      _Depends on 5.1._
- [x] 5.3 Confirm a subsequent release can reuse the same driver + runbook without a one-off
      procedure (checklist note or second run when available).
      _Runbook + CLI are version-keyed and reusable; documented under Repeatability._

## 6. Gates

- [x] 6.1 Regenerate `plugin/` via `node scripts/build.mjs` after any `core/` changes; commit
      mirror with core.
- [x] 6.2 Run `npm run ci` green (including hermetic FRG pack and `openspec validate --all`).
- [x] 6.3 Verify no auto-merge path or `auto_merge` config was introduced.
