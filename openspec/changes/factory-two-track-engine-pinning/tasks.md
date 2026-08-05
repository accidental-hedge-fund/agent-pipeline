## 1. Pin artifact and core helpers

- [ ] 1.1 Add the production pin artifact path and schema (`schema_version`, `version`, `tag`,
      `git_sha`, FRG ref, `promoted_at`, optional `previous`) under the chosen stable path
      (e.g. `docs/production-engine-pin.json`), initialized to the current last known
      FRG-passed release.
- [ ] 1.2 Implement pin load/validate helpers with injectable file I/O (no real network/git in
      unit tests).
- [ ] 1.3 Implement track classification (`pinned` | `candidate`) from pin version, running
      version, and intent (production vs FRG/eval candidate).
- [ ] 1.4 Implement promote helper: require FRG evidence `pass: true` for target version; update
      pin fields; retain prior pin; refuse on missing/failed FRG; never merge or tag.
- [ ] 1.5 Unit tests: pin parse/validate, track classification matrix, promote success, promote
      refusal without FRG pass (prove refusal bites).

## 2. Doctor track disclosure

- [ ] 2.1 Add `install:engine-track` (or equivalent) to doctor preflight via existing
      `buildPreflightChecks` / `DoctorDeps` seams.
- [ ] 2.2 Pass cases: pin match under pinned intent; candidate intent with version ≠ pin does not
      fail solely for mismatch.
- [ ] 2.3 Fail/warn cases: production intent + mismatch; missing/unreadable pin artifact with
      remediation naming reinstall / restore pin.
- [ ] 2.4 Unit tests with injected pin contents and version strings; no real I/O.

## 3. Run evidence track field

- [ ] 3.1 Extend run-dir engine identity writer to set `engine.track` (`pinned` | `candidate`) at
      run start; optionally `pin_version` / `git_sha` when known.
- [ ] 3.2 Ensure historical `run.json` without `track` remains readable (unknown track).
- [ ] 3.3 Do not rewrite `engine.track` on mid-run drift (existing `engine_drift` events stay the
      drift signal).
- [ ] 3.4 Unit tests for pinned vs candidate identity capture through run-store seams.

## 4. FRG / promote integration

- [ ] 4.1 Ensure FRG Layer B / factory-gate path classifies and records candidate track on
      associated runs.
- [ ] 4.2 Wire explicit opt-in promote after FRG pass (CLI flag or `pipeline factory-pin promote`)
      that only updates the pin artifact and prints reinstall instructions.
- [ ] 4.3 Unit tests: FRG fail does not promote; pass + promote updates pin; promote does not
      invoke merge/tag seams.

## 5. Documentation

- [ ] 5.1 Document two tracks, pin location, production install from pin tag, promote, and
      rollback (repoint + reinstall + doctor verify) in README and/or FRG runbook.
- [ ] 5.2 Cross-link FRG pass → promote eligibility; state explicitly that promote does not
      auto-merge or auto-tag.
- [ ] 5.3 Document doctor engine-track check and how to interpret pin mismatch vs intentional
      candidate soak.

## 6. Gates

- [ ] 6.1 Regenerate `plugin/` via `node scripts/build.mjs` after any `core/` changes; commit
      mirror with core.
- [ ] 6.2 Run `npm run ci` green (unit tests, mirror check, openspec validate).
- [ ] 6.3 Verify no auto-merge path or `auto_merge` config was introduced.
