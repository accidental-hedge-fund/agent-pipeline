## 1. Inventory first-cut vs full #1025 contract

- [x] 1.1 Confirm epic #1028 landing of `tryResumeStaleBlocked` / `stageEligibleForStaleBlockedResume` and the advance early-exit call site in `pipeline-run.ts` (or current equivalent).
- [x] 1.2 Map current currency outcomes (`current` / `superseded` / `unknown`) to keep vs clear against design D2; document any gap where `unknown` with H ≠ S still keeps forever.
- [x] 1.3 Enumerate other production early-exits that STOP / hold solely on `pipeline:blocked` before resume can run (train, loop dispatch wrappers, CLI single) and mark each as already-wired, needs-wire, or not-applicable.
- [x] 1.4 Note co-label interaction: `pipeline:needs-human` present with `pipeline:blocked` — does clear alone allow stage re-entry, or is another gate required?

## 2. Currency and resume classification

- [x] 2.1 Align `tryResumeStaleBlocked` (or successor) with design D2: clear on `superseded`; clear on `unknown` when H ≠ S; keep when H == S; keep when PR/head unreadable; keep when pipeline-internal-only current.
- [x] 2.2 Reuse the shared supersession classification used by the pre-merge SHA gate (`resolveReviewedShaCurrency` or equivalent single helper) so resume and gate cannot drift (`review-sha-gating` ADDED requirement).
- [x] 2.3 Ensure resume never writes `--override` dispositions and never expands the security auto-fix allowlist.

## 3. Advance / train / loop wiring

- [x] 3.1 Ensure the advance already-blocked branch attempts stale-block resume before surface-blocker / break / train-terminal STOP for resume-eligible stages.
- [x] 3.2 On clear: re-fetch issue detail (or equivalent) and continue the same advance so pre-merge SHA gate / delta review runs against H.
- [x] 3.3 On keep: preserve existing STOP / hold / surface behavior after the attempt.
- [x] 3.4 Confirm train and loop production paths reach that advance enter-path (no parallel STOP that races before resume).

## 4. Unit regressions

- [x] 4.1 Non-internal H after block on S: clearBlocked called once; resume result is cleared; advance continues (or clear is observable for the wiring seam under test).
- [x] 4.2 HEAD still S: no clearBlocked; keep; terminal STOP/hold after attempt remains allowed.
- [x] 4.3 Pipeline-internal-only since S: no clear solely for internal tip; no spurious re-review cascade (#98).
- [x] 4.4 S absent from PR history (rebase) with H ≠ S: clear and re-enter review path (not permanent keep).
- [x] 4.5 Unreadable PR/head: keep; no clear.
- [x] 4.6 No invented override: after resume/re-review path, security residual keys are not auto-overridden solely because HEAD moved (assert no override write on resume itself).
- [x] 4.7 All unit tests inject deps (no real network, git, or subprocess).

## 5. Mirror, validate, CI

- [x] 5.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [x] 5.2 Run `openspec validate stale-blocked-after-head-rereview` (and `openspec validate --all` as needed) until clean.
- [x] 5.3 Run `npm run ci` from the repo root and fix failures until green.

## Inventory notes (1.x)

- **1.1** Landed under epic #1028: `core/scripts/stages/stale-blocked-rereview.ts` + enter-path in `pipeline-run.ts` (~1904–1932) before surface-blocker / break.
- **1.2 Gap fixed in this change:** first-cut mapped `unknown` → keep forever; D2 requires clear when H ≠ S and currency is `unknown` (rebase/S absent). Unreadable PR/head still keep (fail closed) via pre-currency checks.
- **1.3 Wiring:** `pipeline single` / loop item advance / train all go through `runAdvance` → enter-path resume. Train parks post-advance only if labels still include `blocked` after that attempt (already-wired).
- **1.4 Co-label:** residual security uses `setBlocked(..., "needs-human")` blocker *kind* without moving stage to `pipeline:needs-human`. Stage stays `pre-merge` (or fix/review); `clearBlocked` alone re-enters. True stage `needs-human` (review ceiling) is not resume-eligible.
