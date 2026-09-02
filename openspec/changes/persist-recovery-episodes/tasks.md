## 1. Recovery Episode record on the shared family

- [ ] 1.1 Extend the shared recovery-attempt / operation-claim record with invariant, candidate epoch, evidence identity, attempts per strategy, strategy cursor, and `next_eligible_at`, and verify a unit test fails when any of those fields is missing after a claimed treatment
- [ ] 1.2 Point `claimOrResumeRecoveryEpisode` at that persisted record (not observation-only), and verify a second process with the same operation, invariant, epoch, and evidence identity resumes the same episode without minting a second identity
- [ ] 1.3 Persist the episode through the existing atomic claim/ledger write path, and verify a fixture that writes a competing private episode schema as production authority fails
- [ ] 1.4 Keep prose-only variation on the same normalized evidence identity from resetting the cursor, and verify two fingerprints that differ only in incidental formatting resume the same episode

## 2. Per-strategy cursor and inapplicable skip

- [ ] 2.1 Charge attempts per applicable strategy instead of class-wide `retry_budget` as production authority, and verify a fixture with class-wide remaining budget 0 still claims a later applicable recipe that has not spent its own bound
- [ ] 2.2 Advance the strategy cursor when one applicable strategy reaches its bound, and verify the next configured applicable recipe is claimed without writing `run_fatal` or `recovery_exhausted` as a lifecycle stop
- [ ] 2.3 Skip inapplicable deterministic recipes (absent HEAD `verify_head_goal`, never-started preflight) without consuming the later repair bound, and verify `repair_pipeline_item` remains reachable
- [ ] 2.4 Walk configured recipes in production order from the cursor (no round-robin that hides later recipes), and verify a three-recipe class claims the last recipe after the first two are spent or skipped
- [ ] 2.5 On process restart, resume the same cursor, and verify a fixture that restarts at the first recipe solely because the process restarted fails

## 3. Repeated evidence and Cooling

- [ ] 3.1 On repeated identical evidence at the configured limit, advance the cursor or persist Cooling with a future `next_eligible_at`, and verify the same strategy is not claimed again in that cycle
- [ ] 3.2 When every applicable strategy is exhausted, persist `LoopCoolingRecord` with capped exponential `next_eligible_at` from existing backoff fields, and verify the Logical Operation stays owned
- [ ] 3.3 Refuse treatment for a Cooling episode before `next_eligible_at`, and verify a proven-independent sibling remains schedulable while that episode cools
- [ ] 3.4 Replace live mechanical `run_fatal`, `recovery_exhausted`, `repeated_no_progress`, `supervisor_no_progress`, `supervisor_cycle_cap`, and `worktree_capacity` lifecycle stops with Cooling or an external-condition wait, and verify fixtures that persist those names as lifecycle stops fail
- [ ] 3.5 Keep genuine typed requests and authenticated cancellation unchanged, and verify a current `human-decision-required` diagnostic is not converted into Cooling
- [ ] 3.6 Keep historical `recovery_exhausted` / `run_fatal` evidence readable and keep `--resume` GitHub-ready catch-up, and verify a live mechanical fault does not require operator `--resume` solely to retain ownership

## 4. Write-ahead claims and fenced takeover

- [ ] 4.1 Keep `startRecoveryAttempt` as the write-ahead claim (candidate-bound, fenced by the current lock token, stable `attempt_id`), and verify replay of the same identity after crash returns the existing claim without a second charge
- [ ] 4.2 Refuse mutation without the current fence token, and verify a mismatched-token write leaves the ledger unchanged
- [ ] 4.3 After same-host process death, recover the store lock, mint a new token, and invalidate the dead token, and verify the previous token cannot mutate
- [ ] 4.4 On takeover, reconcile each `started` claim with `uncertain` certainty through the declared authoritative observer before any new mutation, and verify proven-complete is reconciled forward, proven-absent may replay under the same identity, and still-unknown stays an owned wait
- [ ] 4.5 Leave cross-host locks non-stale, and verify a different-hostname lock is not auto-taken over

## 5. Generation quarantine

- [ ] 5.1 Detect truncated or invalid JSON on published contract, ledger, Cooling, episode, and claim documents, and verify a truncated-ledger fixture is quarantined and is not live authority
- [ ] 5.2 Ignore leftover temporary write files as published authority, and verify the previously durable document remains live when it still parses
- [ ] 5.3 Reconstruct from the last valid generation plus live truth when safe, and verify an unsafe reconstruction stays Cooling or wait with quarantine evidence rather than becoming ownerless or human-owned

## 6. Crash-boundary tests

- [ ] 6.1 Add crash fixtures after each durable write used by episode persist, cursor advance, Cooling, claim start, fence publish, and generation quarantine, and verify the next process resumes without a second charge or ownerless terminal
- [ ] 6.2 Add crash fixtures before each external side effect claimed by a Recovery Episode, and verify replay uses the same idempotency identity and does not mutate under a dead token
- [ ] 6.3 Inject store, lock, and observer fakes for all of the above, and verify unit tests make no real network, git, or subprocess calls

## 7. Docs, validation, and CI

- [ ] 7.1 Align living specs and operator docs with episode, cursor, Cooling, and takeover language without adding a public supervisor CLI verb, and verify no `pipeline supervise-recovery` (or equivalent) is registered
- [ ] 7.2 After any later `core/` edit run `node scripts/build.mjs` and verify `node scripts/build.mjs --check` passes
- [ ] 7.3 Run `openspec validate persist-recovery-episodes` and `openspec validate --all`, and verify both exit 0
- [ ] 7.4 Run `npm run ci` from the repo root, and verify the full gate passes
