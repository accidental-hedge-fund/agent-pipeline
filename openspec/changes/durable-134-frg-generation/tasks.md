## 1. Spec and contract lock-in

- [x] 1.1 Confirm living-spec deltas match #953 acceptance criteria and the runbook’s `factory-release prepare` interface (no hermes-factory resurrection).
- [x] 1.2 Document the request JSON schema fields (version, pin, base, candidate commit, action identity, closed paths/digests) and two-call status enum in code comments / CLI help once implemented.
- [x] 1.3 Update FRG runbook only where implementation naming (checkpoint paths, error classes) needs precision beyond the existing interface text.

## 2. Request schema, checkpoint store, and CLI surface

- [x] 2.1 Add `pipeline factory-release prepare --request <absolute-request.json> --json` to the command registry with `--help` covering the two-call protocol.
- [x] 2.2 Implement secret-free request validation: reject credentials, executables, pass claims, and schema violations fail closed.
- [x] 2.3 Implement restart checkpoint store keyed by request fingerprint (repo, version, candidate, action identity); re-observe pack/run/attestation/PR/head before any create mutation.
- [x] 2.4 Implement idempotent status returns for `awaiting_frg_attestation` and `complete` without duplicate pack/branch/PR.

## 3. Durable FRG generation for versions after 1.33.0

- [x] 3.1 Instantiate a fresh fixed-pack instance bound to target version + exact integrated candidate; refuse earlier-version / foreign-run evidence.
- [x] 3.2 Drive pack loop / probes / collector so the runner constructs all observations; reject caller-authored pass/status/metric/receipt inputs.
- [x] 3.3 Score via existing `factory-gate` / FRG scorer; hard-fail on missing, stale, fail, skip, mismatch, or unsupported waiver.
- [x] 3.4 Keep hybrid Layer A pilot valid only for exactly `1.33.0`; later versions fail closed on hybrid reuse and do not use synthetic trivial packs as release-eligible generation.
- [x] 3.5 Emit unsigned artifact identities and digests for attestation; never place FRG key or path in candidate env, fds, request, or result.

## 4. Attestation handoff and shared release prepare

- [x] 4.1 On valid production-owned attestation for the exact artifacts, second call invokes shared `runRelease` prepare-only path from the exact integrated base.
- [x] 4.2 Return `complete` with FRG run id, release PR, head, base, and checkpoint; attach/retain FRG identity on the release PR surface per existing release requirements.
- [x] 4.3 Ensure prepare grants no merge, tag, publish, pin, install, or rollback authority.

## 5. Ship coordinator and adapter wiring

- [x] 5.1 Wire `pipeline ship` FRG/release-prepare phase for versions `> 1.33.0` to the durable prepare protocol (or in-process equivalent).
- [x] 5.2 Update host/ship adapter guidance (`pipeline-ship-frg` / playbook) so auto-generation uses the durable path and drops synthetic trivial-pack generation for 1.34+.
- [x] 5.3 Ensure ship restart after pack, attestation, and complete-prepare checkpoints re-observes and does not duplicate artifacts.

## 6. Tests and CI

- [x] 6.1 Unit tests: first-call `awaiting_frg_attestation` without release PR; second-call `complete` via shared prepare after attestation.
- [x] 6.2 Unit tests: idempotent re-entry (no second pack/PR); stale/foreign evidence refusal; caller-authored pass rejection; hard-gate on failed/missing scenarios.
- [x] 6.3 Unit tests: hybrid not accepted for versions other than `1.33.0`; synthetic trivial pack not release-eligible for 1.34+.
- [x] 6.4 Inject all I/O via deps seams (no real network/git/subprocess in unit tests).
- [x] 6.5 Run `node scripts/build.mjs` after core edits; include regenerated `plugin/` in the same commit set.
- [x] 6.6 Run `npm run ci` from repo root and fix failures until green.
