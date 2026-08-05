## 1. Pin artifact module and path ownership

- [x] 1.1 Define `PRODUCTION_ENGINE_PIN_REL = ".agent-pipeline/production-engine-pin.json"` and
      schema (`schema_version`, `version`, `tag`, optional `git_sha` + `git_sha_source`,
      `frg_run_id`, optional `frg_evidence_path`, `promoted_at`, optional `previous`).
- [x] 1.2 Implement `resolveProductionPin`, `load/validate`, `classifyEngineTrack` with injected
      file I/O (repoDir-based; optional path override). Pin is **not** read from install package
      root as the live authority.
- [x] 1.3 Implement `promoteProductionPin` via `lookupFrgPass` only: pass + matching version +
      non-empty `run_id` required; refuse missing/fail/unparsable/wrong-version; no pin mutation
      on refusal; atomic tmp+rename write; retain `previous`; injected clock.
- [x] 1.4 Implement `initProductionPin --from-frg` (bootstrap) with the same FRG pass gate as
      promote; refuse blank init without pass.
- [x] 1.5 Implement `rollbackProductionPin` (from `previous` or validated `--to`); refuse and
      leave active pin unchanged when target invalid.
- [x] 1.6 Unit tests: parse/validate, classification matrix, promote success, every refusal class
      (missing/malformed/wrong-version/pass:false), no mutation on refusal, init bootstrap, rollback
      retain/refuse, same resolve path for doctor vs run-start fakes.

## 2. Enforceable track-selection interface

- [x] 2.1 Add CLI `--engine-track pinned|candidate` and optional config `engine_track`.
- [x] 2.2 Defaults: factory-gate / evals → candidate; factory-control loop/single/advance/doctor →
      pinned; ordinary non-factory product-repo advances leave two-track policy inactive (no pin
      required). Pin authority is factory control checkout / override, not every target repo_dir.
- [x] 2.3 Pinned intent + missing pin or version mismatch → fail before run is presented as pinned
      (run-start and/or doctor.runOnStart path).
- [x] 2.4 Candidate intent records `candidate` and does not fail solely for pin mismatch.
- [x] 2.5 Unit tests for intent precedence and negative enforcement.

## 3. Doctor track disclosure

- [x] 3.1 Add `install:engine-track` via `buildPreflightChecks` / pure `evaluateEngineTrackCheck`
      over `DoctorDeps.readTextFile` + injected version/intent.
- [x] 3.2 Pass: pin match under pinned intent; candidate intent with mismatch does not fail for
      mismatch alone; still report pin target + candidate.
- [x] 3.3 Fail: production pinned intent + mismatch; missing/unreadable pin under pinned intent
      with init/reinstall remediation.
- [x] 3.4 Additive to `install:version-coherence` and `install:version-freshness` (stable ids).
- [x] 3.5 Unit tests with fake pin JSON / versions / intent — no real I/O.

## 4. Run evidence track field

- [x] 4.1 Extend `RunEngineIdentity` with `track`, optional `pin_version`, optional `git_sha`.
- [x] 4.2 Capture classification once on fresh resolve at first `initRunDir`; resume path reuses
      existing engine object via `resolveRunEngineIdentity` (no reclassify/overwrite).
- [x] 4.3 Consumers treat missing `track` as unknown; never invent track from version alone.
- [x] 4.4 Do not rewrite `engine.track` on mid-run drift (`engine_drift` remains the drift signal).
- [x] 4.5 Unit tests: pinned vs candidate capture; historical without track remains readable;
      resume preserves track.

## 5. FRG / promote CLI integration

- [x] 5.1 FRG Layer B / factory-gate path forces candidate track on associated runs.
- [x] 5.2 Wire `pipeline factory-pin promote|init|rollback|show` (or equivalent) using the pin
      module; optional factory-gate `--promote-pin-on-pass` opt-in only.
- [x] 5.3 Promote never invokes merge/tag seams; tests assert absence of those deps calls.
- [x] 5.4 git_sha optional; promote only sets SHA when injected/arg-provided; doctor reports
      unknown when absent.

## 6. Documentation

- [x] 6.1 Document two tracks, pin path (repo `.agent-pipeline/production-engine-pin.json`),
      install from pin tag, promote, rollback, bootstrap init, doctor check.
- [x] 6.2 FRG runbook: candidate soak vs pinned dogfood; promote does not auto-merge/tag.
- [x] 6.3 Document SHA honesty (optional; unknown valid).

## 7. Gates

- [x] 7.1 Regenerate `plugin/` via `node scripts/build.mjs` after any `core/` changes.
- [x] 7.2 `npm run ci` green; `node scripts/build.mjs --check`.
- [x] 7.3 Verify no auto-merge path or `auto_merge` config was introduced.
