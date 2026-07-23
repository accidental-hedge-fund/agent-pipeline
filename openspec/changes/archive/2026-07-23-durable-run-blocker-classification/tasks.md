# Tasks

## 1. Types & policy contract
- [ ] 1.1 Add `DurableBlockerClass` enum (eight classes) to `core/scripts/loop/types.ts`.
- [ ] 1.2 Add recovery-policy types: per-class `{ recipes[], retry_budget, backoff,
      terminal_outcome, run_fatal, repeated_evidence_limit }`; add per-attempt recovery-record and
      evidence-fingerprint fields to the ledger item and history types.
- [ ] 1.3 Extend `LoopStopRecord.reason` with `needs_human_classification` and
      `repeated_no_progress`; extend the outcome enum (recovered / exhausted /
      repeated-no-progress / needs-human / human-authority).

## 2. Policy compilation (fail-closed)
- [ ] 2.1 Compile the recovery policy into `LoopContract` at init; refuse a policy that omits any
      class, references a non-permitted recipe, or is malformed, as a validation failure with no
      run directory created.
- [ ] 2.2 Add a runtime test asserting the policy covers every `DurableBlockerClass` member (types
      are stripped, so back the invariant with a real test).

## 3. Classification on the blocked transition
- [ ] 3.1 Require a valid `DurableBlockerClass` on every transition into `blocked`; record it as
      the item's blocked theme; refuse a missing or out-of-enum class as validation.
- [ ] 3.2 Fail closed on unknown / ambiguous classification: record a terminal needs-human stop,
      emit a stop event, decrement no budget, attempt no recipe.

## 4. Evidence fingerprinting & repeat bounding
- [ ] 4.1 Add an exported pure fingerprint function over normalized evidence (unit-testable, no
      git/network).
- [ ] 4.2 Count consecutive same-fingerprint blocks per item; stop terminally at
      `repeated_evidence_limit` even with class budget remaining; reset the count on a differing
      fingerprint.

## 5. Budget re-keying & recovery execution
- [ ] 5.1 Re-key recovery-budget charging from the free-text theme to the typed classification
      (update the `durable-loop-engine` recovery-budget behavior).
- [ ] 5.2 On successful recovery, resume the same item `blocked`→`in_progress`, retaining history,
      class, and evidence records — never restart from pending or skip.
- [ ] 5.3 Gate independent-item continuation on the class's `run_fatal` flag while preserving the
      single-active-item and merge-barrier invariants.

## 6. Authority safety
- [ ] 6.1 Ensure no permitted recipe performs a merge, release, credential, or deploy action.
- [ ] 6.2 Route `missing-authority` and `specification-decision` to a terminal human-authority
      stop rather than a retry recipe.

## 7. Persistence & events
- [ ] 7.1 Persist per-attempt classification, attempted actions, evidence fingerprint, and outcome
      in the ledger via the durable store; verify they survive a resume.
- [ ] 7.2 Emit a Pipeline-native event for each recovery attempt.

## 8. Legacy import
- [ ] 8.1 Map an imported goal-loop `theme` onto its `DurableBlockerClass` in `loop/import.ts`.

## 9. Tests & gates
- [ ] 9.1 Fixture tests covering every blocker class, recovery-budget exhaustion, repeated
      evidence, successful same-item resume, and safe independent-item continuation — all via
      injected seams, no real network/git/subprocess.
- [ ] 9.2 Prove each regression test bites (fails without the change).
- [ ] 9.3 Regenerate the plugin mirror (`node scripts/build.mjs`) and run `npm run ci` green,
      including `openspec validate --all`.
