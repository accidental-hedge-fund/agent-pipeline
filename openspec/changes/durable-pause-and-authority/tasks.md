# Tasks

## 1. States & durable record types
- [ ] 1.1 Add `paused` and `waiting` to `LoopItemState` in `core/scripts/loop/types.ts`.
- [ ] 1.2 Add a `LoopHumanInputRequest` type (`request_id`, `item_id`, `kind:
      "decision"|"answer"|"authority-grant"`, `prompt`, `permitted_responses?: string[]`,
      `requested_by_engine`, `requested_at`) and persist an optional outstanding request on the
      ledger item.
- [ ] 1.3 Add `LoopAuthorityAmendment` (`gate: LoopAuthorityGate`, `scope_item_id?: string`,
      `actor`, `reason`, `time`) and a `LoopHandoff` decision shape (`from_engine`, `to_engine`,
      `reason`, `time`).

## 2. Transition graph (modified durable-loop-engine)
- [ ] 2.1 Admit `in_progress → paused`, `in_progress → waiting`, `paused → in_progress`,
      `waiting → in_progress`, `paused → abandoned`, `waiting → abandoned`; refuse every other edge
      touching a hold state as a validation failure naming both states.
- [ ] 2.2 Ensure entering `paused`/`waiting` charges no recovery budget, increments no
      consecutive-blocked count, and records no `DurableBlockerClass` theme.
- [ ] 2.3 Add a runtime test asserting the full accepted/refused edge matrix (types are stripped —
      back the invariant with a real test).

## 3. Precise human-input requests
- [ ] 3.1 Require a well-formed request on every `waiting` transition; refuse a missing request, an
      unknown kind, or a present-but-empty `permitted_responses` as validation, leaving state
      unchanged.
- [ ] 3.2 Assign a run-unique `request_id`; persist the request on the item so it survives restart.

## 4. Audited, fail-closed resume
- [ ] 4.1 Add an audited resume that appends an attributed decision (resuming engine, human actor,
      response, time) via `appendDecision` and transitions the hold back to `in_progress`.
- [ ] 4.2 Fail closed: refuse resume when there is no active hold, when the response names a
      different request, or when the response is outside a defined closed permitted set — without
      appending a decision.
- [ ] 4.3 Compose with the existing pipeline-mandate and native-goal-mandate checks for entering
      `in_progress`; clear the outstanding request only on a successful resume.

## 5. Scoped, audited authority amendments (modified durable-loop-engine)
- [ ] 5.1 Add an audited amendment recorder appending an attributed decision naming exactly one
      gate and an optional item scope; refuse an amendment with no gate, an unknown gate, or more
      than one gate as validation.
- [ ] 5.2 Extend the gated-transition check to authorize on a compile-time grant **or** a matching
      `(gate, scope)` amendment; keep default-deny otherwise and never widen to another gate/item.
- [ ] 5.3 Prove an amendment never bypasses the directly-verified-evidence requirement (a gated
      transition with no evidence is still refused).

## 6. Audited cross-engine handoff
- [ ] 6.1 Add an audited handoff appending an attributed decision (from-engine, to-engine, reason,
      time) and releasing the current lock via compare-and-delete without transferring its token.
- [ ] 6.2 Refuse a handoff while any item is `in_progress` (conflict-class); require the receiving
      engine to acquire a fresh lock and re-attest native-goal mode before resuming.

## 7. Status surface
- [ ] 7.1 Surface outstanding human-input requests and active authority amendments in the read-only
      status projection (no writes, no lock, no GitHub call).

## 8. Tests & gates
- [ ] 8.1 Fixture tests: hold admission and non-charging; request round-trip and fail-closed resume;
      scoped-amendment allow/deny matrix; evidence-still-required; audited handoff and
      re-attestation — all via injected seams, no real network/git/subprocess.
- [ ] 8.2 Prove each regression test bites (fails without the change).
- [ ] 8.3 Regenerate the plugin mirror (`node scripts/build.mjs`) and run `npm run ci` green,
      including `openspec validate --all`.
