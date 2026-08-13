## 1. Inventory first-cut vs full #1025 contract

- [ ] 1.1 Confirm epic #1028 landing of `tryResumeStaleBlocked` / `stageEligibleForStaleBlockedResume` and the advance early-exit call site in `pipeline-run.ts` (or current equivalent).
- [ ] 1.2 Map current currency outcomes (`current` / `superseded` / `unknown`) to keep vs clear against design D2; document any gap where `unknown` with H ≠ S still keeps forever.
- [ ] 1.3 Enumerate other production early-exits that STOP / hold solely on `pipeline:blocked` before resume can run (train, loop dispatch wrappers, CLI single) and mark each as already-wired, needs-wire, or not-applicable.
- [ ] 1.4 Note co-label interaction: `pipeline:needs-human` present with `pipeline:blocked` — does clear alone allow stage re-entry, or is another gate required?

## 2. Currency and resume classification

- [ ] 2.1 Align `tryResumeStaleBlocked` (or successor) with design D2: clear on `superseded`; clear on `unknown` when H ≠ S; keep when H == S; keep when PR/head unreadable; keep when pipeline-internal-only current.
- [ ] 2.2 Reuse the shared supersession classification used by the pre-merge SHA gate (`resolveReviewedShaCurrency` or equivalent single helper) so resume and gate cannot drift (`review-sha-gating` ADDED requirement).
- [ ] 2.3 Ensure resume never writes `--override` dispositions and never expands the security auto-fix allowlist.

## 3. Advance / train / loop wiring

- [ ] 3.1 Ensure the advance already-blocked branch attempts stale-block resume before surface-blocker / break / train-terminal STOP for resume-eligible stages.
- [ ] 3.2 On clear: re-fetch issue detail (or equivalent) and continue the same advance so pre-merge SHA gate / delta review runs against H.
- [ ] 3.3 On keep: preserve existing STOP / hold / surface behavior after the attempt.
- [ ] 3.4 Confirm train and loop production paths reach that advance enter-path (no parallel STOP that races before resume).

## 4. Unit regressions

- [ ] 4.1 Non-internal H after block on S: clearBlocked called once; resume result is cleared; advance continues (or clear is observable for the wiring seam under test).
- [ ] 4.2 HEAD still S: no clearBlocked; keep; terminal STOP/hold after attempt remains allowed.
- [ ] 4.3 Pipeline-internal-only since S: no clear solely for internal tip; no spurious re-review cascade (#98).
- [ ] 4.4 S absent from PR history (rebase) with H ≠ S: clear and re-enter review path (not permanent keep).
- [ ] 4.5 Unreadable PR/head: keep; no clear.
- [ ] 4.6 No invented override: after resume/re-review path, security residual keys are not auto-overridden solely because HEAD moved (assert no override write on resume itself).
- [ ] 4.7 All unit tests inject deps (no real network, git, or subprocess).

## 5. Mirror, validate, CI

- [ ] 5.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 5.2 Run `openspec validate stale-blocked-after-head-rereview` (and `openspec validate --all` as needed) until clean.
- [ ] 5.3 Run `npm run ci` from the repo root and fix failures until green.
