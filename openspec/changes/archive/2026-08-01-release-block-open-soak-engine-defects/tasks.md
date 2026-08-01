## 1. Preflight module and classification

- [x] 1.1 Add a pure/injected-deps open-soak-defect preflight helper under `core/scripts/` (e.g. `open-soak-defect-preflight.ts`) with a deps seam for issue listing, FRG evidence / loop identity, and optional ledger projections — zero real network in unit tests.
- [x] 1.2 Implement candidate attribution: FRG `loop_run_id` / `run_id`, issue body/title markers referencing those ids, created-since-previous-tag window, and optional #760/#763 fields when present.
- [x] 1.3 Implement engine-class classification: typed terminal / recovery-exhaustion evidence and #787 stage diagnostics preferred; exclude converged intermediate recoveries; label fallback only when both `bug` and `pipeline:engine-class` are present and typed evidence is missing.
- [x] 1.4 Implement fail-closed doctor-grade error formatting (version, soak identity, per-issue list with classification source, remediation including override).
- [x] 1.5 Implement override acceptance: non-empty reason required; return waived issue numbers + reason for PR recording; reject empty/whitespace reasons.

## 2. Release path integration

- [x] 2.1 Wire preflight into `runRelease` after FRG pass resolution and **before** any version-file mutation (live and dry-run).
- [x] 2.2 Extend release CLI/`ReleaseDeps` with the audited override flag and pass reason into preflight.
- [x] 2.3 Extend release PR body builder to record waived issue numbers + override reason when override was used.
- [x] 2.4 Confirm merge-queue release-when-complete prepare reuses the same `runRelease` gate (no bypass).

## 3. Label hygiene for auto-file paths

- [x] 3.1 Update papercut / improve auto-file creation so engine-class clusters receive `pipeline:backlog`, `bug`, and `pipeline:engine-class`; non-engine-class remain backlog-only.
- [x] 3.2 Update durable-run-blocker auto-file creation with the same engine-class label set for `workflow-engine-defect` / engine-class taxonomy members.
- [x] 3.3 Ensure labels still never include pipeline stage labels, assignees, or milestones, and still do not auto-advance filed issues.

## 4. Tests

- [x] 4.1 Unit tests: open-defect set blocks release before mutation (injected deps).
- [x] 4.2 Unit tests: empty blocking set passes preflight.
- [x] 4.3 Unit tests: override with non-empty reason permits pass and PR body includes waiver section.
- [x] 4.4 Unit tests: empty override reason still fails closed.
- [x] 4.5 Unit tests: typed evidence blocks despite missing/wrong labels.
- [x] 4.6 Unit tests: label-fallback selection when both markers present and typed evidence absent.
- [x] 4.7 Unit tests: converged intermediate non-terminal events do not block.
- [x] 4.8 Unit tests: engine-class auto-file label sets for papercut and durable-run-blocker paths.
- [x] 4.9 Prove at least one regression test fails without the preflight/label fix (bite check).

## 5. Docs, mirror, and gate

- [x] 5.1 Document the gate + override in release/operator docs or FRG runbook cross-link (minimal, accurate).
- [x] 5.2 Regenerate `plugin/` via `node scripts/build.mjs` when `core/` changes; commit mirror with code.
- [x] 5.3 Run `npm run ci` from repo root and fix until green.
- [x] 5.4 Run `openspec validate release-block-open-soak-engine-defects` (and `--all` if required by local workflow) and keep the change structurally valid.
