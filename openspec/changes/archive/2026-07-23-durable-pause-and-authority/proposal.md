## Why

The in-repo durable loop engine (#508) and its typed blocker classification (#509) model
*failure* holds precisely: a `blocked` item carries a typed `DurableBlockerClass`, consumes a
recovery budget, counts toward the consecutive-blocked stop limit, and is recovered by an
automated recipe. What the integrated engine still lacks is a first-class notion of a
*deliberate, non-failure* hold — a run or item that is paused for, or waiting on, specific human
input, and that resumes only under audited human authority.

Today the only way to hand a durable run to a human is a terminal stop (`needs_human_classification`,
`human_authority`), which ends the run: there is no durable, resumable "waiting for a precise
answer" state, no structured record of *what* input is needed, no audited way to grant a scoped
authority the compiled contract withheld, and no audited way to hand a paused run from one engine
(Claude) to the other (Codex). goal-loop#2 solved these on the standalone core; this change ports
them onto the integrated durable-orchestration ledger while preserving the engine's fail-closed
scope checks.

## What Changes

- Add two durable, non-terminal item states — **`paused`** and **`waiting`** — distinct from
  `blocked`. Entering either does **not** carry a `DurableBlockerClass`, does **not** charge a
  recovery budget, and does **not** increment the consecutive-blocked count. They persist in the
  ledger so a resuming engine reads the same hold, and they exit only via an audited resume (or to
  `abandoned`).
- Attach a **precise human-input request** to every `waiting` transition: a structured record
  naming the item, the request kind (`decision`, `answer`, or `authority-grant`), the prompt, an
  optional closed set of permitted responses, and the requesting engine and time. The request is
  durable and is the thing a resume must satisfy.
- Make **resume audited and fail-closed**: resuming a `paused`/`waiting` item SHALL record an
  attributed decision in the run's decision log carrying the resuming engine, the human actor
  reference, and the supplied response, and SHALL be refused unless the response satisfies the
  outstanding request (correct request id; a permitted option when the request defines a closed
  set). Resume still composes with — never bypasses — the engine's existing pipeline-mandate and
  native-goal-mandate evidence checks for entering `in_progress`.
- Add **scoped, audited authority amendments**: a human MAY grant a single authority gate
  (`push_pr`, `merge`, `release`, or `deploy`), optionally narrowed to one item, through a
  dedicated audited decision. The amendment is durable and honored on later gated transitions, but
  it widens authority **only** for the exact `(gate, scope)` it names — never another gate, never
  another item, never the whole run — and it never bypasses the engine's directly-verified-evidence
  requirement for a gated transition. Default-deny stands for every gate no compile-time grant and
  no matching amendment covers.
- Add **audited cross-engine handoff**: a `paused`/`waiting` run MAY be handed from the current
  engine to the other via an audited decision recording from-engine, to-engine, reason, and time.
  The handoff releases the current lock without transferring its token, so the receiving engine
  MUST acquire a fresh lock and re-attest its native goal mode before resuming. A handoff is
  refused while any item is `in_progress`, preserving single-engine advance.
- **Preserve fail-closed scope checks throughout**: pauses, requests, amendments, resumes, and
  handoffs are all additive audited surfaces; none relaxes an existing gate, and every malformed
  or unauthorized attempt is refused under the engine's existing failure taxonomy, leaving durable
  state unchanged.

## Acceptance Criteria

- [ ] The item transition graph admits `in_progress → paused`, `in_progress → waiting`,
  `paused → in_progress`, `waiting → in_progress`, `paused → abandoned`, and `waiting → abandoned`;
  every other edge touching `paused`/`waiting` is refused as a validation failure naming both
  states.
- [ ] Entering `paused` or `waiting` charges no recovery budget and does not increment the
  consecutive-blocked count, and neither state carries a `DurableBlockerClass` theme.
- [ ] `paused` and `waiting` state, and any outstanding human-input request, survive a process
  restart: a resuming engine reads the same hold and request from the durable store.
- [ ] Every `waiting` transition records a structured human-input request naming the item, a
  request kind drawn from a closed set (`decision`, `answer`, `authority-grant`), the prompt, an
  optional closed set of permitted responses, and the requesting engine and time; a `waiting`
  transition with no request is refused as a validation failure.
- [ ] Resuming a `paused`/`waiting` item records an attributed decision in the decision log and is
  refused (leaving state unchanged) when there is no active hold, when the response names a
  different request, or when the request defines a closed response set and the response is outside
  it.
- [ ] Resume into `in_progress` still requires the existing pipeline-preflight and native-goal
  evidence; an audited resume with a satisfying response but absent/stale mandate evidence is still
  refused under the existing mandate failure classes.
- [ ] A scoped authority amendment recorded through the audited decision surface permits exactly
  the `(gate, scope)` it names on a later gated transition; the same gate on a different item, a
  different gate on the same item, and a broad/un-scoped amendment are each refused with an
  authority-class failure.
- [ ] An authority amendment never bypasses the directly-verified-evidence requirement: a gated
  transition covered by an amendment but supplying no evidence is still refused.
- [ ] No objective text, selector, or ambient later input widens a grant; only a compile-time
  grant or a matching audited scoped amendment authorizes a gated transition.
- [ ] A cross-engine handoff records an attributed decision (from-engine, to-engine, reason, time),
  releases the current lock without transferring its token, and is refused while any item is
  `in_progress`; after a handoff the receiving engine must acquire a fresh lock and re-attest its
  native goal mode before it can resume.
- [ ] Fixture tests cover paused/waiting admission and non-charging, request round-trip and
  fail-closed resume, scoped-amendment allow/deny matrix, evidence-still-required, and audited
  handoff — all via injected seams with no real network, git, or subprocess calls.

## Capabilities

### New Capabilities
- `durable-pause-and-authority`: durable `paused`/`waiting` item states distinct from `blocked`;
  precise human-input request records; audited, fail-closed resume; scoped, audited authority
  amendments; and audited cross-engine handoff — all persisted in the durable ledger / decision
  log and composed with the engine's existing mandates and failure taxonomy.

### Modified Capabilities
- `durable-loop-engine`: the item transition graph is extended with the `paused`/`waiting` states
  and their edges; the authority-gate requirement is extended so a gated transition is authorized
  by a compile-time grant **or** a matching audited scoped amendment — and by nothing else.

## Impact

- **Specs:** new `durable-pause-and-authority` capability; two modified requirements in
  `durable-loop-engine` (transition graph; authority gate).
- **Code (implementation step only, not this change):** `core/scripts/loop/types.ts`
  (`LoopItemState` gains `paused`/`waiting`; human-input-request, authority-amendment, resume, and
  handoff record types), the durable transition engine (`core/scripts/loop/store.ts` /
  `core/scripts/loop/recovery.ts` — pause/wait transitions that skip budget and block-counting,
  amendment-aware gate check, audited resume and handoff via `appendDecision`), and the read-only
  status projection surfacing outstanding requests and active amendments.
- **Interoperability:** additive to the ledger and decision log; a pre-#510 run with no
  paused/waiting items, no requests, and no amendments behaves exactly as today. Legacy goal-loop
  import is unaffected (no imported run carries these Pipeline-native records).
