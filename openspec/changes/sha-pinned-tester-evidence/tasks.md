## 1. Schema and pure classification

- [ ] 1.1 Define versioned `TesterEvidence` types (`schema_version: 1`, status taxonomy, command/test rows, identity + config digest + bounded toolchain fingerprint, producer metadata) in a pure module under `core/scripts/`
- [ ] 1.2 Implement pure helpers: SHA match / stale classification, overall status derivation from command rows, output bound + redaction integration, optional nested identity reserved for #692 compatibility
- [ ] 1.3 Unit tests for schema validation, pass/fail/timeout/tooling/partial/disabled/not_run/unavailable/stale, secret redaction, truncation — no real I/O

## 2. Deterministic producer on existing gates

- [ ] 2.1 Wire `runTestGate` (and combined format/test production path as designed) to emit/update `TesterEvidence` for HEAD when run/state dir is present
- [ ] 2.2 Map disabled, no-command skip, dirty-tree hard block, timeout, tooling failure, and multi-command partial outcomes into the status taxonomy
- [ ] 2.3 Optional allowlisted extractor seam: well-formed → `tests[]`; malformed → keep command authority; absent → no per-test rows
- [ ] 2.4 Unit tests with injected `runTests` / dirty / head / record seams covering producer paths from acceptance criteria

## 3. Persistence in evidence surfaces

- [ ] 3.1 Persist full structured record in the run directory and/or `summary.json`; append `events.jsonl` Tester outcome event
- [ ] 3.2 Apply existing secret-redaction and injection denylist to all Tester string fields before write
- [ ] 3.3 Surface artifact write failure with existing write-health / #633-style disposition; never claim stored on failure
- [ ] 3.4 Optional human summary comment path: compact status/SHA/duration/command count only — no full log dump

## 4. Review acquisition and prompt injection

- [ ] 4.1 Add config for `tester_evidence` (`on_missing` fail_closed/fail_open, max excerpt length) with `.describe()` and defaults; document in init/template surfaces
- [ ] 4.2 Implement `loadTesterEvidenceForReview` (or equivalent): SHA match, stale, malformed, missing → deterministic disposition; never imply pass without evidence
- [ ] 4.3 Inject authoritative suite section into review-1, review-2, and delta re-review prompt assembly; label supplemental targeted checks separately
- [ ] 4.4 After candidate-changing fix commits, invalidate prior evidence and require producer regeneration before treating suite evidence as current (reuse internal-commit classifier consistency with review-SHA gate)
- [ ] 4.5 Unit tests: match, mismatch→stale, missing fail_closed, missing fail_open, post-fix regeneration, targeted-check non-overwrite

## 5. Ensemble shared injection

- [ ] 5.1 Ensure ensemble fan-out shared prompt material includes the same Tester section for every agent (identity suffix only may differ)
- [ ] 5.2 Unit test with injected ensemble invoke fakes: N agents receive identical authoritative suite block / classification

## 6. Scoreboard and accounting

- [ ] 6.1 Expose structured Tester metrics (duration, command count, overall_status tallies, optional targeted-check count) to scoreboard/accounting consumers without prose parsing
- [ ] 6.2 Unit or pure tests: metrics from structured fields; runs without artifact remain valid with Tester metrics absent

## 7. Mirror, OpenSpec, and CI gate

- [ ] 7.1 Regenerate `plugin/` via `node scripts/build.mjs` after any `core/` change; commit mirror with core
- [ ] 7.2 Keep this change’s OpenSpec artifacts valid (`openspec validate sha-pinned-tester-evidence` / `openspec validate --all` as required by CI)
- [ ] 7.3 Run `npm run ci` green before considering implementation complete
