## 1. Inventory epic first cut vs #1021 acceptance

- [x] 1.1 Confirm living filer module (`engine-class-live-sibling`) provides: provenance marker, labels `bug` + `pipeline:engine-class` + `pipeline:ready`, body `Depends on: #<N>`, pre-create evidence_key dedup, post-create title/key + rate-cap reconcile, no milestone invent when milestone omitted.
- [x] 1.2 Confirm recover coupling: only successful engine-scratch recover (e.g. `unlink_engine_scratch`) best-effort invokes the filer; product dirt / `human-decision-required` paths do not call it.
- [x] 1.3 Confirm train exposes current milestone into filer context (`pipeline train --milestone`) and clears it when the train invocation ends.
- [x] 1.4 Record any gap against proposal acceptance (missing negative tests, shared rate-cap budget leakage, fatal sibling failure, missing Depends on, wrong labels, milestone guess).
  - **Gap closed this change:** recover-path coupling tests (invoke once / filer throw non-fatal / product dirt + human-authority never call filer), train milestone context unit tests, empty-string milestone fail-closed, createIssue failure non-fatal. Implementation already present from epic #1028; no production-code gap found beyond test lock-in.

## 2. Close filer contract gaps

- [x] 2.1 Ensure labels never include `pipeline:backlog` on the live-sibling path; papercut / correction / durable-run-blocker paths remain backlog-only.
- [x] 2.2 Ensure rate-cap membership is marker-scoped and does not consume papercut / correction / durable-run-blocker open-issue budgets.
- [x] 2.3 Ensure no-milestone path creates without inventing a title from open milestones or improve-suggestion prose.
- [x] 2.4 Ensure sibling create/list/reconcile failures are non-fatal relative to recover success (no reverse of clear-blocked solely for file failure).

## 3. Recover and train coupling

- [x] 3.1 Wire or verify: successful engine-class recover → filer call with recovered issue number, stable `evidence_key`, and train milestone when in scope.
- [x] 3.2 Ensure non-engine recover / human-authority / product-dirt outcomes never invoke the filer.
- [x] 3.3 Ensure train does not STOP solely because recover cleared a mechanical `blocked` or because a sibling was filed/skipped (depends on #1020 clear + train blocked disposition; no new STOP on sibling alone).
- [x] 3.4 Never auto-merge and never apply review override from this path.

## 4. Unit regressions

- [x] 4.1 File one sibling for fresh `evidence_key` with train milestone: labels ready+engine-class+bug, milestone set, body has marker + `Depends on: #<recovered>`.
- [x] 4.2 Second identical `evidence_key` in-window: no second create (dedup and/or post-create reconcile).
- [x] 4.3 No milestone: create without milestone field; do not invent one.
- [x] 4.4 Rate-cap overflow / cross-host overshoot: post-create keeps lowest-numbered open survivors.
- [x] 4.5 Recover-path coupling test (injectable deps): successful `unlink_engine_scratch` (or equivalent) invokes filer once; filer throw does not flip recover to failed / re-block.
- [x] 4.6 Negative: product dirt / `human-decision-required` path does not call filer and does not assign a milestone.
- [x] 4.7 All unit tests stay injectable (no real network, git, or subprocess).

## 5. Mirror, validate, CI

- [x] 5.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit. *(test-only under `core/test/`; no `core/scripts/` source change → mirror unchanged; still verify `--check`.)*
- [x] 5.2 Run `openspec validate file-engine-class-live-sibling` (and `openspec validate --all` as needed) until clean.
- [x] 5.3 Run `npm run ci` from the repo root and fix failures until green.
