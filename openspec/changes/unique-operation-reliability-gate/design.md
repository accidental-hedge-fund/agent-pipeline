## Context

See `proposal.md` for why.

ADR 0004 already names Logical Operation as the reliability denominator. `CONTEXT.md` already defines Logical operation, Execution attempt, Verified completion, Manual reinvocation, False-human projection, Ownerless terminal, Exact-candidate recovery, and Independent-sibling continuation.

Existing surfaces:

- `run.json` / `initRunDir` — written-once physical `run_id`, engine pin, `discovery_channel`.
- `events.jsonl` — additive fields, `schema_version` remains `1`.
- FRG `FrgEvidence` — `composition.false_human_authority_count`, HMAC attestation, `validateReleaseEligibleFrgEvidence`, release-prepare fail-closed.
- Factory scoreboard — attempt/run/PR rates plus additive sections (`outcomes`, stabilization).
- Train `train_loop_linked` / loop `onRunReady` handoff (#1301 must land before this gate can pass).
- Durable loop store — atomic contract/ledger, exclusive run publication.
- Versioned FRG pack manifest — required scenarios, composition ids, expected pack outcomes.

This change is class-level release law. It does not invent a scheduler, recovery owner, scoreboard verb, or evidence store.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: stamp identity on existing `run.json` / events / handoffs; add `operation_reliability` to existing FRG evidence; share one classifier with scoreboard and outcomes.
- Unique-operation SLOs gate FRG promotion and release preparation.
- Nested child work inherits the root admission identity. A new external admission without a valid resume binding mints a new identity.

**Non-Goals:**

- A new CLI verb, scheduler, or recovery owner.
- Replacing attempt-based scoreboard metrics that stay labeled as attempt metrics.
- Treating legitimate typed requests, external waits, or cancellations as reliability failures when the versioned manifest declares them.
- Reimplementing #1301 (live train linkage, collision-safe run ids, merge proof) or #1333 (fault matrix). This gate consumes those proofs.
- Provider-specific error strings in production routing.
- Changing merge authority, auto-merge, or advance-never-merges.

## Decisions

### D1 — Mint `logical_operation_id` at public-command admission onto existing `run.json`

Admission of numeric drive, `single`, `loop`, `train`, `merge`, merge queue, and `ship` mints an opaque immutable id and writes it once on `run.json` next to `run_id`. `run_id` stays the physical execution identity (`runIdFor` / `trainRunIdFor`). The logical id is not derived from `run_id`, issue number, or timestamp, so a later physical run can keep the same logical identity.

Nested child work (train → loop, ship → pack loop, recovery-controller `single` spawned by a parent) copies the parent id through the existing handoff (`onRunReady`, `train_loop_linked`, loop contract). It MUST NOT mint a second identity.

A new external shell admission without a resume/parent binding mints a new id. If that new admission continues unfinished work, it is Manual reinvocation.

Alternative considered: derive the logical id from `run_id`. Rejected: retries and fresh-process resumes already mint new physical run directories.

Alternative considered: a correlation store or sidecar JSONL. Rejected: `run.json` is already written-once identity.

### D2 — Resume binding is the existing identity, not a new protocol

Valid resume bindings, in order:

1. Re-entry of an existing run directory (`initRunDir` idempotent; reuse the written `logical_operation_id`).
2. Durable loop-store run id / contract that already carries the id.
3. Explicit parent handoff (`train_loop_linked`, loop `onRunReady`, ship pack-loop progress) that names the parent logical id.
4. Operator `--resume <run-id>` / equivalent that loads that run's written identity.

If none of these are present, mint a new logical id. Do not guess by issue number, latest run, or PATH candidate.

### D3 — `operation_reliability` is a section of existing FRG evidence

Extend `FrgEvidence` with a versioned `operation_reliability` object bound to candidate SHA, release identity, pack-manifest fingerprint, entrypoint coverage, numerators, denominators, stable exclusions, integrity counts, and per-operation evidence references. `computeFrgEvidence` writes it. `validateReleaseEligibleFrgEvidence` and factory-release prepare fail closed when SLOs or integrity counts fail.

Do not add `.agent-pipeline/operation-reliability/` or a new latest.json.

HMAC attestation (existing `hmac-sha256-v1`) MUST bind this section. Mutating counts after mint MUST fail verification.

### D4 — One shared classifier; scoreboard and outcomes consume it

Put the pure aggregator next to existing additive scoreboard sections (same pattern as `outcomes/scoreboard-section.ts` and `scoreboard-stabilization.ts`). FRG scoring, `pipeline scoreboard`, and production-outcome attribution call that function. They MUST NOT independently reclassify GitHub labels, comment prose, or `needs-human` text.

Existing attempt/run/PR metrics may remain if labeled as attempt metrics. Any rate that claims unique-operation success MUST use `logical_operation_id` as the denominator.

### D5 — Terminal outcomes are a closed set; process exit is not success

Every admitted supervised operation ends as exactly one of:

- verified success (authoritative exact-candidate postcondition proof)
- durable cooling / recovery
- external-condition wait
- typed decision / capability / authority request
- explicit authenticated operator cancellation

Anything else is an Ownerless terminal (integrity / SLO failure). `run_complete`, process zero-exit, and issue closure are evidence, not success.

False-human projection reuses the existing composition `false_human_authority_count` path and the existing blocker taxonomy / recovery-controller classification. Expand those counts to unique-operation grain. Do not add provider-string routing.

### D6 — Manifest-declared expected outcomes are the only clean-completion exclusions

The versioned FRG pack manifest is the exclusion list. A typed request, external wait, or cancellation is excluded from clean-completion only when that manifest declares it as the expected outcome for that operation/fixture. Those rows stay separately counted and contract-validated. Missing correlation and missing required entry-point coverage are never exclusions.

### D7 — #1301 and #1333 are required proofs, not this change's implementation

Release-eligible pass requires:

- #1301 live `train_loop_linked` identity (exact child loop run id + events path, collision-safe train run ids, merge proof disposition).
- #1333 mechanical fault-matrix coverage for required lifecycle classes, with zero false-human and zero ownerless terminals.

If those proofs are absent, FRG promotion and release preparation fail as integrity failures. This change MUST NOT reimplement train scheduling, fault-matrix fixtures, or a second recovery owner.

### D8 — No new public command

`pipeline factory-gate --json`, existing FRG `latest.json`, `pipeline scoreboard --json`, and release-prepare validation expose the section. Generated CLI/SKILL tables do not gain a new verb.

### D9 — Tests inject I/O; retries must bite

Hermetic tests with fake `run.json` / events / loop store / FRG pack MUST fail when:

- a retry or fresh-process resume double-counts a logical operation
- a completed side effect is replayed
- missing `logical_operation_id` is treated as an exclusion
- a mechanical fault is projected as human authority
- an ownerless terminal is scored as success

No real network, git, or subprocess in unit tests.

## Risks / Trade-offs

- **[Risk] Historical runs lack `logical_operation_id`.** → Mitigation: missing correlation is an integrity count, not an exclusion. Historical windows on the factory scoreboard report missing-correlation diagnostics; they MUST NOT invent ids. Release-eligible FRG for new versions requires the field.
- **[Risk] #1301 / #1333 are still open.** → Mitigation: this gate fails closed until those proofs exist. Sequencing is explicit in the issue and this design.
- **[Risk] Nested `pipeline single` looks like a new admission.** → Mitigation: parent-spawned children MUST carry the parent binding on the existing handoff. Operator-typed `single` without that binding is a new admission / possible Manual reinvocation.
- **[Risk] HMAC payload growth.** → Mitigation: bind the whole `operation_reliability` object (or its fingerprint) rather than a subset of counters, matching how composition is already bound.
- **[Trade-off] Attempt-based scoreboard metrics remain.** → They stay as attempt metrics. Unique-operation rates are additive and are the only rates that may claim SLO success.

## Migration Plan

1. Additive `logical_operation_id` on new admissions; readers ignore unknown fields on old artifacts.
2. FRG schema validation requires `operation_reliability` for release-eligible `pass: true` only. Offline `scoreInput` without live provenance remains non-release-eligible as today.
3. Scoreboard additive section; existing attempt metrics unchanged in name.
4. Runbook and generated docs update in the same change as `core/` edits.
5. No rollback of identity stamps: written-once fields stay. A bad scorer can fail closed without rewriting `run.json`.

## Open Questions

None. Remaining sequencing (#1301, #1333 integration) is a fail-closed prerequisite, not an open design choice.
