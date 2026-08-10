## Why

`Ship milestone v1.34.0` cannot produce a genuine Factory Reliability Gate (FRG) pass. The v1.33.0 hybrid runner is hard-locked to that pilot version, and the durable #908 replacement — `pipeline factory-release prepare --request <absolute-request.json> --json` — was never implemented in the engine. Ship therefore falls back to a synthetic trivial pack that honest scoring rejects, so release preparation stops.

## What Changes

- Implement the engine-side durable FRG generation and release-prepare handoff for every release after v1.33.0: `pipeline factory-release prepare --request <absolute-request.json> --json` as an idempotent two-call protocol (unsigned pack → trusted attestation → shared `runRelease` prepare).
- Generate a **fresh candidate FRG pack** from the exact integrated base for each release version. Evidence, issues, or observations from an earlier release SHALL NOT satisfy the request.
- Keep the runner the sole author of probes, actions, statuses, metrics, and evidence receipts. Caller-authored pass claims are refused.
- Keep FRG a hard gate: missing, stale, failed, mismatched, skipped, or waived required evidence stops before release preparation.
- Wire `pipeline ship` / `pipeline-ship-frg` (ship adapter) to this real generation path for 1.34+. Remove the synthetic “trivial docs/fixture change” pack path as a release-eligible generator.
- Reuse existing `pipeline release` / shared `runRelease` for the release PR from the exact integrated base. Retain immutable FRG evidence and attestation on that PR.
- Make crash/timeout recovery re-observe pack, run, attestation, branch, PR, and head state before any retry. Duplicate ticks SHALL NOT create a second pack, branch, or release PR.
- Replace the v1.33.0-only hybrid exception for all later releases. Do not carry the temporary hybrid rule forward.
- Resolve the living-spec tension: ship still reuses the shared release prepare implementation; `factory-release prepare` is the durable FRG+attestation orchestration around that shared entry, not a second release builder or state machine.

## Acceptance Criteria

- [ ] `pipeline factory-release prepare --request <absolute-request.json> --json` exists on the engine CLI and is documented; `--help` describes the two-call protocol and request binding fields.
- [ ] First call for a bound 1.34+ request with no verified production attestation returns JSON `status: "awaiting_frg_attestation"` with closed unsigned artifact identities and digests, and does **not** open a release PR.
- [ ] After a valid production-owned attestation for those exact artifacts, a second call with the **unchanged** request returns `status: "complete"` with one release PR identity, head, base, FRG run id, and restart checkpoint.
- [ ] Repeated calls at either checkpoint return the same proved state and do **not** create a second pack, attestation, branch, or release PR.
- [ ] A fresh pack is instantiated for the target version from the exact integrated candidate; pack issues/observations bound to an earlier version, manifest hash, or run are refused for the current request.
- [ ] The generator constructs every probe/action itself and rejects caller-authored pass, status, metric, or evidence-receipt fields as input for scoring.
- [ ] Missing, stale, failed, mismatched, skipped, or waived required scenario evidence yields non-zero exit and blocks release preparation (hard gate).
- [ ] For target versions `> 1.33.0`, ship / `pipeline-ship-frg` uses this durable path and does **not** use a synthetic trivial-docs pack as release-eligible FRG generation.
- [ ] Release preparation reuses the shared `runRelease` / `pipeline release` prepare path; the release PR records FRG run identity and attestation immutably.
- [ ] After simulated crash/timeout at pack, attestation, and post-prepare checkpoints, restart re-observes live state and continues without duplicate pack/branch/PR mutations.
- [ ] The v1.33.0 hybrid pilot rule remains valid only for exactly `1.33.0`; later releases fail closed on hybrid reuse and require the durable path.
- [ ] Unit tests cover protocol states, freshness refusal, caller-authored pass rejection, and idempotent re-entry with injected deps (no live network/git required for those cases).
- [ ] `npm run ci` green; `plugin/` regenerated when `core/` changes land (implementation phase).
- [ ] No merge, tag, pin promote, or install authority is added to `factory-release prepare`.

## Capabilities

### New Capabilities

_(none — extends existing FRG, release, and ship surfaces)_

### Modified Capabilities

- `factory-reliability-gate`: Durable 1.34+ FRG generation from the exact integrated candidate; fresh pack per release; runner-owned evidence only; hybrid rule remains v1.33.0-only and is replaced for later releases by the durable prepare path.
- `release-sub-command`: Add the candidate-native `pipeline factory-release prepare --request <json> --json` two-call interface; clarify that ship/factory-release reuses shared `runRelease` and does not invent a second release builder.
- `ship-coordinator`: Wire the ship FRG/release-prepare phase for versions after v1.33.0 to the durable engine path; stop using synthetic trivial packs as release-eligible generation.

## Impact

- Engine CLI: new `factory-release prepare` surface under `core/scripts/` (command registry, help, JSON output).
- FRG pack instantiation, collection, scoring, and attestation handoff for post-pilot releases.
- Ship coordinator and host ship adapters (`pipeline-ship-frg` / playbook) generation path selection.
- Living specs and FRG runbook alignment with the durable interface (already named in the runbook).
- Tests under `core/test/` with dependency injection; mirror regeneration via `node scripts/build.mjs`.
- Out of scope: reintroducing `ops/hermes-factory`, merge/tag authority on prepare, synthetic all-pass fabrication, carrying the hybrid exception past v1.33.0.
