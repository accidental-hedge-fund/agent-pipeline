## 1. Schema and pure classification

- [x] 1.1 Define versioned `TesterEvidence` / `TesterTargetedCheck` types and status taxonomy in `core/scripts/tester-evidence.ts`
- [x] 1.2 Pure helpers: SHA match/stale, overall_status precedence, config_digest (canonical sorted JSON + sha256), worktree_id basename, toolchain allowlist, excerpt bound + aggregate budget, schema validate
- [x] 1.3 Pure prompt section renderer (authoritative vs supplemental labels; untrusted data framing)
- [x] 1.4 Unit tests for pass/fail/timeout/tooling/disabled/not_run/unavailable/stale/malformed, redaction, truncation, digest stability — no real I/O

## 2. Deterministic producer on `runTestGate`

- [x] 2.1 Plumb first-class `timed_out` (or equivalent) from `runTests` / `RunTestsResult` so timeout is not collapsed into bare fail
- [x] 2.2 After each terminal `runTestGate` outcome, when `runDir` is available, produce `TesterEvidence` for HEAD (`producer.component: "test-build-gate"`); map disabled / not_run / dirty unavailable / timeout / tooling / failed / passed
- [x] 2.3 v1 command inventory: single resolved test/build command only (format-gate out of suite authority)
- [x] 2.4 Optional allowlisted extractor seam (default empty); malformed → keep command authority
- [x] 2.5 Unit tests with injected `runTests` / dirty / head / write seams covering producer matrix

## 3. Persistence lifecycle

- [x] 3.1 Canonical path `{runDir}/tester-evidence.json` via atomic tmp+rename; all strings redact+sanitize
- [x] 3.2 Append `tester_evidence` event only on successful full-record write; on write failure elevate write-health (#633) and do not claim stored success
- [x] 3.3 Lookup contract: only current file; SHA mismatch → stale; no multi-SHA auto-pick; prior SHA only via events history
- [x] 3.4 Optional human summary (status, short SHA, command count, duration) — no full log
- [x] 3.5 Targeted-check append surface (`targeted-checks.jsonl` / event) that cannot overwrite authoritative file

## 4. Config

- [x] 4.1 `tester_evidence.on_missing` (`fail_closed` default | `fail_open`), `max_output_chars`, `max_artifact_chars`, optional `extractors` with Zod `.describe()` + defaults + init template comments

## 5. Review acquisition and shared injection

- [x] 5.1 `loadTesterEvidenceForReview` — missing/malformed/stale/current; never imply pass
- [x] 5.2 fail_closed: withhold review model invoke on non-current evidence (except current disabled/not_run); fail_open: invoke with explicit section
- [x] 5.3 Single append helper before `invokeReviewEnsemble` in: `review-routing.ts` (review-1/2), `pre-merge-sha-gate.ts` (delta), `planning.ts` (plan-review)
- [x] 5.4 Post-fix regeneration via existing `runFormatAndTestGates` → `runTestGate` only (no regenerate-inside-review)
- [x] 5.5 Unit tests: match, stale, fail_closed withhold, fail_open proceed, post-fix new HEAD, shared ensemble core prompt bytes, plan-review same helper

## 6. Scoreboard and accounting

- [x] 6.1 Structured Tester metrics extractors (duration, command count, overall_status, optional targeted-check count)
- [x] 6.2 Runs without artifact remain valid; Tester metrics absent — never inferred pass

## 7. Mirror, OpenSpec, and CI gate

- [x] 7.1 Regenerate `plugin/` via `node scripts/build.mjs` after any `core/` change; commit mirror with core
- [x] 7.2 Keep OpenSpec change valid (`openspec validate --all` as required by CI)
- [x] 7.3 Run `npm run ci` green before considering implementation complete

## Review

Implemented #646 SHA-pinned Tester evidence:

- Pure schema/helpers in `core/scripts/tester-evidence.ts`
- Producer on `runTestGate` with `timed_out` first-class on `RunTestsResult`
- Persistence: `tester-evidence.json`, `tester_evidence` events, write-health on failure, targeted-checks append-only
- Config: `tester_evidence` (fail_closed default)
- Review injection: review-1/2 (fail_closed withhold), delta re-review, plan-review section only (no withhold)
- Scoreboard `metrics.tester` from structured events
- Unit coverage in `core/test/tester-evidence.test.ts`
- `npm run ci` green; plugin mirror regenerated
