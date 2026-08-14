# #1061 Plan revision — supervisor recover-parked

## Status
- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [ ] Implementation (blocked on plan acceptance / next pipeline stage)

## Reviewer feedback dispositions
See chat response `## Feedback Incorporated` (authoritative for this revision).

## Implementation sequence (post-approval)
1. Pure eligibility + fingerprint + spend sentinel helpers + unit fixtures
2. `runRecoverParked` compose: deterministic → classify → spend → override → fix → re-enter
3. CLI registry + dispatch + result contract
4. Train hook + supervisor docs
5. `OPERATION_SURFACE` + `node scripts/build.mjs` + plugin mirror
6. `openspec validate` + `npm run ci`
