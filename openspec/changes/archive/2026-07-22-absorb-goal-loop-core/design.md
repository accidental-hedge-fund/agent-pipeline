## Context

`pipeline:loop` today is a preflight-plus-print facade (`core/scripts/loop-preflight.ts`,
`runLoopCommand` in `core/scripts/pipeline.ts`). All durable behavior lives in the
standalone goal-loop repository: `state.py` (743 lines, v0.2.0 on `main`,
`goal-loop/contract@2` + `goal-loop/ledger@2`), installed into
`~/.{claude,codex}/skills/goal-loop` by its own `install.py` with a
`.goal-loop-manifest.json` ownership manifest.

Facts that shaped the decisions below, all verified against the goal-loop checkout:

- Pipeline learns goal-loop's schema ids by **regex-grepping a foreign repo's `state.py`**
  for `CONTRACT_SCHEMA = "..."` (`extractSchemaConstant`, `loop-preflight.ts`). This is
  brittle by construction and exists only because the two products are separate.
- goal-loop **v0.3.0 is unmerged** — it lives in commits `c64c2f3` + `b9e12d8`, not on any
  tag. It bumps `CONTRACT_SCHEMA` to `goal-loop/contract@3` and adds the native-`/goal`
  bootstrap self-attestation mandate (new exit code `8`, 300-second freshness window). It is
  the capability set #508 requires be completed in-repo.
- goal-loop's `reconcile` reads **nothing** from GitHub: it is a sink for caller-observed
  truth, detects exactly one drift class (item-state mismatch), and never auto-resolves it.
- goal-loop's canonical hash is Python `json.dumps(sort_keys=True, separators=(",",":"))`
  with the default `ensure_ascii=True`, i.e. non-ASCII is `\uXXXX`-escaped.
- `run_id` is caller-supplied and opaque; uniqueness is enforced only by `init` refusing an
  existing directory.
- Locking is `O_CREAT|O_EXCL` on `lock.json`; staleness is **liveness-based only** (no TTL),
  and a lock recorded from another hostname is never considered stale.

## Goals / Non-Goals

**Goals**

- One authoritative durable state engine, owned by Agent Pipeline, in TypeScript, in `core/`.
- `pipeline:loop` runs on a host with no goal-loop skill installed.
- In-flight goal-loop runs survive the cutover without hand-editing JSON.
- Behavioral parity with goal-loop v0.3.0's semantics, expressed as testable requirements
  rather than inherited by copying a script.

**Non-Goals**

- Deleting, archiving, or re-releasing the goal-loop repository (out of this repo's diff).
- Changing Pipeline's merge boundary. The loop still ends every item at
  `pipeline:ready-to-deploy`; a human owns the merge button.
- Introducing concurrency. `max_active_items` stays 1 and the exclusive lock stays exclusive.
- Reading GitHub from inside the engine. Reconciliation stays a caller-supplied-truth sink.

## Decision 1 — Port to TypeScript in-repo; do not wrap the Python CLI

**Chosen**: reimplement the semantics as a TypeScript module under `core/scripts/loop/`.

**Rejected — vendor `state.py` into this repo and shell out to it.** It keeps the runtime
Python dependency, keeps a second language and a second test harness in a repo whose entire
CI story is `node --test --experimental-strip-types`, and cannot be tested through the
existing `deps`-seam pattern (`AdvanceReviewDeps`, `ShaGateDeps`, `VerifyDeps`) that every
other stage uses. It also leaves the durable engine unreachable from Pipeline's own types —
the `pipeline/loop-execution@1` contract could not be type-checked against its producer.

**Rejected — keep the facade and vendor goal-loop as an npm/pip dependency.** #508's product
decision is explicitly that Pipeline *owns* the engine. A dependency is still a second
release cadence and a second version-skew check, which is the exact failure this change
retires.

The port is a **semantic** port, not a transliteration: each behavior lands as a requirement
with scenarios in the spec deltas, and the transition graph, gate table, and error taxonomy
are re-derived from those requirements. Where goal-loop's implementation has an accident
rather than an intent (see decision 6) the requirement states the intent.

## Decision 2 — Module boundary: `core/scripts/loop/`, not an advance-stage handler

The issue is explicit: "a dedicated module, not an advance-stage handler". The advance loop
(`core/scripts/stages/*.ts`) owns exactly one issue and one PR at a time; the durable
orchestrator owns a *run* of many items and must never be reachable from a stage. Enforced
structurally by the existing `pipeline/loop-execution@1` contract, which exposes no
per-stage verb: the orchestrator dispatches a whole item and receives one terminal outcome.

Layout:

```
core/scripts/loop/
  store.ts         state home, run dirs, atomic + append-only writes, status projection
  lock.ts          acquire / release / status / recover
  contract.ts      discovery normalization, dependency ordering, canonical hash, run identity
  ledger.ts        transition graph, gates, recovery budgets, stops, merge barrier
  evidence.ts      pipeline mandate + native-/goal evidence mandate validators
  reconcile.ts     caller-supplied-truth sink, drift report, barrier clearing
  import.ts        goal-loop run import (decision 5)
  errors.ts        the error taxonomy / exit-code mapping
```

All I/O flows through a single injected `LoopStoreDeps` seam (filesystem, clock, pid
liveness, hostname, uuid) so unit tests do no real filesystem-outside-tmp, network, git, or
subprocess work — matching the repo's established convention.

## Decision 3 — Native schema ids; imported runs keep their recorded canonical hash

New runs are written as `pipeline/loop-contract@1` and `pipeline/loop-ledger@1`. Keeping
`goal-loop/contract@2` would leave Pipeline's own store namespaced under a product it no
longer depends on, and would make "which engine wrote this?" undecidable.

Canonical hashing for **new** contracts is Pipeline-native: keys sorted, compact separators,
UTF-8 preserved (no `\uXXXX` escaping), `adapter` and `canonical_hash` excluded from the
hashed body. Because it is one TypeScript implementation used by both engines, the
cross-engine determinism requirement is satisfied by construction.

**Imported** runs keep the `canonical_hash` recorded by goal-loop **verbatim and are never
rehashed.** Reproducing Python's `ensure_ascii=True` escaping and float `repr` byte-for-byte
in TypeScript is a correctness trap with no upside: the hash's job is to detect that a run's
contract changed under it, and preserving the original value serves that job exactly. The
imported contract records the schema id it came from so the hash's provenance is explicit.

## Decision 4 — State home: Pipeline-owned, with legacy roots readable

New runs live under `$AGENT_PIPELINE_STATE_HOME` → `$XDG_STATE_HOME/agent-pipeline/loop` →
`~/.local/state/agent-pipeline/loop`, mirroring goal-loop's own resolution order so the
convention is familiar.

Legacy roots (`$GOAL_LOOP_STATE_HOME` → `$XDG_STATE_HOME/goal-loop` →
`~/.local/state/goal-loop`) are scanned **read-only**, and only when resolving a `--resume`
run id that is not present in the native store, or when reporting migration status.

**Rejected — adopt goal-loop's state home as Pipeline's own.** Two writers with different
schema versions in one directory tree is precisely the "second authoritative ledger" #508
forbids, and it would let the still-installed goal-loop CLI drive a run Pipeline believes it
owns.

## Decision 5 — Import is one-way, non-destructive, and refuses on a live lock

`pipeline:loop --resume <run-id>` resolves the native store first. On a miss, it looks in the
legacy roots and, on a hit, performs an import:

1. Validate the legacy `contract.schema` ∈ {`goal-loop/contract@2`, `@3`} and
   `ledger.schema` = `goal-loop/ledger@2`. Anything else refuses with both the found and the
   supported ids — a newer-than-supported id fails as loudly as an older one.
2. Refuse, with zero writes, if the legacy `lock.json` exists and its holder is live (same
   host, live pid) or unverifiable (different host). A run being actively driven by the old
   engine must not be forked.
3. Translate contract + ledger + events + decisions into the native schemas under a new
   native run directory using the **same run id**, preserving item states, per-item history,
   `blocked_theme`, `recovery_remaining`, `consecutive_blocked`, `merge_barrier`,
   `reconciled`, `stop`, and `last_native_goal_check`. Event `seq` numbering is preserved.
4. Write **one** marker into the legacy run directory recording that it was superseded, by
   which run and when. This is the only write the import makes to legacy state.

Step 4 is deliberate: without it, an operator with goal-loop still installed can resume the
legacy run in parallel and produce two divergent ledgers for one run id — the exact outcome
"no second durable ledger remains authoritative" forbids. A second import of the same run id
is refused by that marker.

**Rejected — resume legacy runs in place, writing the legacy schema.** That makes Pipeline a
writer of a schema it does not own and keeps two write paths alive indefinitely.

**Rejected — pure read-only import with no marker.** Cheaper, but leaves the divergence hole
above wide open.

## Decision 6 — Behaviors re-derived rather than inherited

Three goal-loop implementation details are accidents. The spec states the intended behavior;
the port implements the spec.

- **`TERMINAL_STATES` is declared and never referenced** in `state.py:80`. The in-repo engine
  makes terminality real: `deployed` and `abandoned` have no outgoing edges, and the
  transition graph is the single source of truth for that.
- **Event `seq` is computed by counting lines in `events.jsonl` on every append** — O(n) per
  event and only safe under the lock. The in-repo store tracks the next sequence number
  without re-reading the whole log, while preserving the dense 0-based sequence the format
  guarantees.
- **`stop` is re-emitted on every subsequent successful transition** because the emit guard is
  unconditional. The in-repo engine emits `stop` exactly once, at the transition that causes
  the stop.

Conversely, three behaviors that *look* like bugs are intentional and are specified as-is:
dangling dependencies outside the snapshot are dropped rather than erroring (the snapshot is
the world); `consecutive_blocked` does not reset on `→ in_progress` (only real forward
progress clears it); and a cross-host lock is never auto-recovered (liveness is unverifiable,
so fail closed).

## Decision 7 — Two distinct native-`/goal` concepts, kept distinct

Pipeline already has a **capability probe** (#506, `checkNativeGoalCapability`): can this
engine run native `/goal` at all? goal-loop v0.3.0 adds an **evidence mandate**: is a native
`/goal` session *currently active* for this engine and this run, attested within a freshness
window, at the moment an item enters `in_progress`?

They are not the same check and must not be merged. The probe is preflight, host-scoped, and
answered by version/attestation; the mandate is per-transition, run-scoped, and answered by
caller-supplied evidence. This change leaves the probe requirement untouched and adds the
mandate to the engine, with its own error class so a failure is never misdiagnosed as "your
CLI is too old".

Freshness window: 300 seconds, carried forward from goal-loop v0.3.0 and stated as a named
constant in the spec so it is reviewable rather than incidental.

## Decision 8 — Migration window with an explicit removal condition

Import support is **not** permanent. The window ends when both hold:

1. no legacy run directory under any legacy root is in a non-terminal state, as reported by
   `pipeline doctor`; and
2. at least one full release cycle has elapsed since this change ships.

Removal of `loop/import.ts` is a **separate approved change**, gated on that report — the same
evidence-gated pattern #451 used for its own consolidation decision. Until then `pipeline
doctor` reports the count of importable legacy runs so the condition is observable rather
than assumed.

## Decision 9 — Epic decomposition

#508 is an epic whose acceptance criteria reference "the mapped child issues". No child
issues exist on the tracker at authoring time, so this change enumerates the decomposition
itself; if children are filed they map 1:1 onto `tasks.md`'s numbered sections:

1. store + lock (`durable-loop-store`)
2. contract compilation + dependency ordering (`durable-loop-engine`)
3. ledger, transition graph, gates, recovery, stops, merge barrier (`durable-loop-engine`)
4. evidence mandates incl. native-`/goal` v0.3.0 parity (`durable-loop-engine`)
5. reconciliation (`durable-loop-engine`)
6. facade repoint + external-check retirement (`pipeline-loop-facade`)
7. legacy import + migration window (`goal-loop-run-import`)

## Risks / Trade-offs

- **Semantic drift during the port.** Mitigated by table-driven tests over the full
  state-pair matrix and the gate table, plus fixture runs captured from real goal-loop output
  and replayed through the import path.
- **Loss of the external-skew check.** Retiring `loop:contract-coherence` removes a real
  guard; it is replaced by an in-repo check of the run's own recorded schema id, which is
  strictly more reliable (the store states its schema; it is no longer inferred by grepping a
  foreign source file).
- **Operators with goal-loop still installed.** The superseded marker (decision 5) prevents
  divergence, but an operator can still start a *brand-new* goal-loop run outside Pipeline.
  That is out of Pipeline's control; the SKILL text states which surface is canonical.
- **Import fidelity for `@3` contracts.** goal-loop `@3` is unmerged and unreleased, so
  `@3` fixtures are derived from its commits rather than a tag. Accepted: refusing `@3` would
  strand any operator running the unmerged branch, and the delta over `@2` is one additive
  contract block plus one optional ledger field.
