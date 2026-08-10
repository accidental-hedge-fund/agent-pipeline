## Context

See `proposal.md` for motivation. Current product state:

- **Living FRG** still requires a recorded pass for every release and keeps the v1.33.0 hybrid as a temporary exception that **fails closed** for any other version.
- **Living release-sub-command** currently says ship coordination SHALL NOT add a `factory-release` command, because ship must reuse shared `runRelease` and not invent a second release state machine.
- **Runbook + #908 + #953** still name the exact durable interface: `pipeline factory-release prepare --request <absolute-request.json> --json` as an idempotent two-call protocol.
- The **hermes-factory `frg-runner`** (pilot-locked to 1.33.0) is **not** in the product tree. Living `scoped-autonomous-factory-operations` forbids shipping that control plane. The durable generator therefore belongs **in the agent-pipeline engine**, not as a resurrected hermes package.
- Host ship playbooks call `pipeline-ship-frg` when `latest.json` is missing. Honest scoring already rejects fabricated all-pass packs; the gap is genuine generation for 1.34+.

This design resolves the living “no factory-release command” wording against #908 by treating `factory-release prepare` as **FRG generation + attestation checkpoint + shared prepare**, not as an alternate release builder.

## Goals / Non-Goals

**Goals:**

- One engine-owned durable path that produces genuine FRG evidence for every release after v1.33.0 from the exact integrated candidate.
- Stable request/JSON contract so installed production wrappers and ship adapters one release behind can invoke the candidate checkout.
- Idempotent restart: re-observe before mutate; never double-create pack, branch, or release PR.
- Preserve production-owned attestation (no FRG key in candidate env/fds/request/result).
- Keep release prepare prepare-only via shared `runRelease`.

**Non-Goals:**

- Restoring `ops/hermes-factory` or a second durable scheduler in-repo.
- Live production fault-injection product surfaces beyond what the current fixed pack and Layer A/B policy already require (full live seams may still use documented pack recipes; this change does not invent unsafe public kill switches solely for FRG).
- Granting merge, tag, pin, install, or rollback to `factory-release prepare`.
- Changing numeric FRG thresholds (K, capacity N, max engine-class rate).
- Auto-merge or advance-path merge authority.

## Decisions

### 1. Engine CLI surface: `pipeline factory-release prepare`

**Choice:** Implement the #908 command name and two-call protocol in the engine CLI.

**Why:** Issue #953, the FRG runbook, and the archived #908 contract already freeze this interface for stable wrappers. Renaming now would break the documented handoff and force host rewrites without benefit.

**Alternatives considered:**

| Alternative | Rejected because |
|-------------|------------------|
| Only unlock external `frg-runner` past 1.33.0 | Runner lives outside the product tree; living policy forbids hermes-factory as product surface; issue says the gap is **engine-side**. |
| Fold generation only into `pipeline ship` internals with no public prepare command | Breaks one-release-behind wrapper invocation from the exact candidate checkout; runbook and #908 require a candidate-native command. |
| Make `pipeline factory-gate` create the pack + release PR | Gate remains scorer/driver; mixing release PR mutation into scoring blurs authority and reopens dual release builders. |

### 2. Two-call protocol and checkpoint model

**Choice:** First call produces or reconciles unsigned FRG artifacts and returns `awaiting_frg_attestation`. Trusted wrapper-local attestor (existing production-owned boundary) signs. Second call with **unchanged request** verifies attestation, then invokes shared `runRelease`, returns `complete`.

Checkpoint state (local, keyed by request fingerprint: repo + version + candidate commit + grant/action identity as present) records:

- request digest and bound identities
- pack identity / issue set / loop run id when known
- unsigned artifact paths and digests
- attestation identity when known
- release PR / head / base when known
- phase: `frg_running` | `awaiting_frg_attestation` | `release_preparing` | `complete` | `failed`

On every entry: re-read GitHub/git/FRG artifacts before any create. Same proved phase returns same JSON without mutation.

### 3. Fresh pack from exact integrated base

**Choice:** For each request, instantiate the versioned representative pack (`factory-gate-v1` or current fixed pack) at the **exact integrated candidate commit** named by the request. Bind every issue and observation to release version, manifest hash, template ids, and run id. Refuse earlier-version or foreign-run evidence.

**Why:** Already required by living FRG (“old pack item cannot satisfy a new release”); ship failures for 1.34+ show the synthetic trivial pack does not exercise required scenarios.

### 4. Runner-owned evidence only

**Choice:** The prepare path and pack runner construct commands/probes from the manifest and durable loop evidence. Request schema allows only versioned identity fields, closed data paths under allowed roots, and expected digests — never pass claims, statuses, metrics, or receipts.

Scoring remains `pipeline factory-gate` / existing scorer. Attestation remains production-owned (living FRG attestation requirement unchanged in spirit; later releases use production signer).

### 5. Wire ship without a second release machine

**Choice:** MODIFY the living “SHALL NOT add factory-release” ship-coordination requirement to:

- Allow `factory-release prepare` as the durable FRG + attestation handoff.
- Still require shared `runRelease` for release PR create/reconcile.
- Still forbid a second release builder, wrapper-local PR discovery protocol, or alternate state machine that diverges from prepare-only release semantics.

Ship coordinator / `pipeline-ship-frg` for `version > 1.33.0`:

1. Build secret-free request bound to pin, base, candidate, version.
2. Call prepare until `awaiting_frg_attestation` or `complete`.
3. If awaiting: run trusted attestor; store attestation; call again.
4. On `complete`: continue ship finalization gates with the returned typed identity.

For exactly `1.33.0`, existing hybrid path may remain for historical/repro; no new hybrid for later versions.

### 6. Failure and hard-gate policy

**Choice:** Any required scenario missing/stale/fail/skip/mismatch/waiver without explicit release-policy support → non-zero exit, no release PR, no `complete`. Do not invent synthetic observations. Do not extend hybrid.

### 7. Implementation placement

**Choice:** Core under `core/scripts/` (CLI registration, prepare orchestration, checkpoint store, request schema). Reuse existing FRG pack modules, `factory-gate` scoring, and `runRelease`. Tests inject deps. Regenerate `plugin/` in the same change set as core edits.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Living “no factory-release” vs #908 name | Explicit MODIFIED requirement: orchestration allowed; second release builder forbidden. |
| Live pack FRG is long-running / flaky | Checkpoint + re-observe; fail closed on ambiguity; unit tests cover orchestration with fakes; live soak remains operator/ship path. |
| Unsafe fault classes still lack production injection seams | Do not revive silent hybrid. Use current fixed-pack policy: live proof where safe; Layer A only where living FRG already allows for non-hybrid paths; document residual gaps as hard fail or tracked follow-ups — never fabricated pass. |
| Candidate one release ahead of installed pin | Command runs from candidate checkout; attestor and signer stay production-owned. |
| Host `pipeline-ship-frg` still points at synthetic pack | Spec + tasks require adapter wire-up; engine refuses synthetic trivial packs as release-eligible when invoked for 1.34+. |
| Partial hermes-factory leftovers on hosts | Product tree remains free of hermes-factory; host cleanup is out of band. |

## Migration Plan

1. Land OpenSpec change (this planning step) and implement engine command + tests.
2. Update FRG runbook wording only where behavior deltas need precision (interface already named).
3. Wire ship coordinator and document host `pipeline-ship-frg` selection for `> 1.33.0`.
4. First real consumer: Ship milestone v1.34.0 generates genuine FRG, then `pipeline release` / finish / promote as today.
5. Rollback: remove or feature-gate the command and restore fail-closed on missing durable path; do **not** re-enable synthetic all-pass or hybrid-for-all-versions.

## Open Questions

None that block specs or tasks. Residual live fault-seam completeness is bounded by the existing fixed-pack policy; this change does not reopen the v1.33.0 hybrid for later releases.
