## 1. Allowlist expansion (pure helpers)

- [x] 1.1 Expand `isAutoFixableFinding` in `core/scripts/stages/pre_merge.ts` so the allowlist is
  `{ correctness, missing-dep, concurrency }` (case-insensitive, trimmed); keep fail-closed for
  absent/empty/unrecognized categories
- [x] 1.2 Export or document a single-sourced allowlist constant (e.g. `PRE_MERGE_AUTOFIX_CATEGORIES`)
  used by the helper and referenced by tests so the category matrix cannot drift from runtime
- [x] 1.3 Update helper comments / JSDoc to point at the living category matrix (concurrency in;
  security/scope/product-judgment/spec-divergence/data-loss/observability out)

## 2. Unit tests for eligibility

- [x] 2.1 Update `core/test/pre-merge-autofix.test.ts` so `isAutoFixableFinding` asserts
  `concurrency` → true (and case variants); keep `security`/`scope`/`product-judgment-required`/
  `spec-divergence`/empty/undefined → false
- [x] 2.2 Update `allBlockingAutoFixable` tests: concurrency-only and mixed allowlisted sets → true;
  mixed allowlisted + security → false; empty → false
- [x] 2.3 Prove the concurrency expansion test bites: temporarily removing `concurrency` from the
  allowlist fails the new assertion

## 3. Gate path: allowlisted routing (no first-hop skip)

- [x] 3.1 Add or extend a DI-based pre-merge gate test where a concurrency-only blocking delta set
  with no prior auto-fix commit invokes `attemptPreMergeAutoFix` once and re-reviews once
- [x] 3.2 Assert security-only (or mixed security) still escalates without invoking auto-fix
- [x] 3.3 Assert prior auto-fix commit exhausts the bound (no second attempt) with needs-human
- [x] 3.4 Audit the production branch in `enforceReviewShaGate` for any skip path that would
  first-hop allowlisted findings to needs-human; fix only if a real skip bug is found

## 4. Advisory carry-forward at delta

- [x] 4.1 Identify the prior-round digest / partition seam used for settled-finding demotion and
  extend it (or a thin wrapper) to recognize prior-round **advisory** findings as carry-forward
  candidates (same surface or stable fingerprint)
- [x] 4.2 Demote unverified same-surface/fingerprint re-raises (no head-state evidence) to advisory;
  record reason on comment/event; do not introduce a new durable store
- [x] 4.3 Keep verified regressions blocking; route remaining blockers through the expanded allowlist
- [x] 4.4 Unit tests: advisory reappears without head evidence → demoted; with head evidence → still
  blocks; no prior advisory history → no carry-forward demotion

## 5. Mirror, docs, and gate

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/`
  with the same change
- [x] 5.2 Run `cd core && npm test` for the touched suites; then `npm run ci` from repo root
- [x] 5.3 Confirm OpenSpec still validates: `openspec validate pre-merge-delta-expand-bounded-autofix`
  (and `openspec validate --all` when archiving later)

## 6. Dogfood narrative check

- [x] 6.1 Walk a #668-class fixture (concurrency HIGH findings at pre-merge delta, no prior auto-fix
  commit) through the DI path and record in the PR/description that the outcome is auto-fix once
  or exhausted needs-human — not silent first-hop needs-human for allowlisted categories
