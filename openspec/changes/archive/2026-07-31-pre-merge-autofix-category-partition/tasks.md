## 1. Eligibility helpers and partition

- [x] 1.1 Introduce a pure partition helper (or equivalent) over blocking findings:
      `autoFixable` via `isAutoFixableFinding`, `residual` otherwise; keep
      `PRE_MERGE_AUTOFIX_CATEGORIES` as the single allowlist source of truth.
- [x] 1.2 Change the delta-fail auto-fix gate from `allBlockingAutoFixable(blocking)` to
      “non-empty autoFixable subset” (harness configured + no prior attempt still required).
- [x] 1.3 Keep pure residual-only batches failing closed without a harness call; keep
      empty-blocking false for attempt eligibility.
- [x] 1.4 Update comments / docs near the helpers so they describe partition, not
      all-or-nothing veto; leave allowlist membership unchanged.

## 2. Fix prompt scope and post-attempt path

- [x] 2.1 Scope the pre-merge auto-fix prompt / formatted blocking body to the
      **autoFixable** subset only (exclude residual non-allowlisted findings).
- [x] 2.2 Reuse the existing one-attempt + post-fix re-delta / noop re-verify path after
      partition attempts (no second harness for residual; no new unbounded loop).
- [x] 2.3 On escalate after mixed/residual paths, surface block reason text that names
      human-required residual keys/categories vs auto-fix-attempted keys/categories
      (and pure residual no-attempt vs exhausted attempt).

## 3. Unit tests (injected seams only)

- [x] 3.1 Mixed concurrency + `spec-divergence` → auto-fix still attempted for allowlisted
      subset; residual excluded from prompt; harness called once when no prior attempt.
- [x] 3.2 #729-shaped fixture regression: co-batched HIGH concurrency + HIGH
      `spec-divergence` does **not** skip auto-fix solely due to residual; prove bite under
      old all-or-nothing eligibility.
- [x] 3.3 All-allowlisted batch still attempts once (no regression).
- [x] 3.4 All-non-allowlisted / pure security / pure product-judgment still skips harness and
      blocks without attempt.
- [x] 3.5 After partition auto-fix, still-blocking residual (and/or still-broken allowlisted)
      escalates once with disposition-naming block reason; no second attempt.
- [x] 3.6 Update any existing tests that currently expect mixed allowlisted + excluded to
      skip harness under all-or-nothing (e.g. correctness+scope, concurrency+security) to
      the new partition outcomes while still asserting residual is not auto-fixed.

## 4. Mirror, validate, gate

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated
      `plugin/` in the same commit.
- [x] 4.2 Run `openspec validate pre-merge-autofix-category-partition` (and keep deltas
      archive-ready).
- [x] 4.3 Run `npm run ci` from repo root; fix failures before done.
