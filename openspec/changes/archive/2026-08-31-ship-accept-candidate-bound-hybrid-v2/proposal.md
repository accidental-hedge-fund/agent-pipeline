## Why

Post-v1.33 ship runs write release-eligible, HMAC-authenticated hybrid-v2 Factory Reliability Gate (FRG) evidence, then the ship-specific candidate assertion rejects every present `pack_provenance` unless the release is exactly `1.33.0`. That throw stopped the v1.39.16 and v1.40.0 ships in `frg_pack`:

```text
ship FRG: hybrid pack_provenance is valid only for v1.33.0; got 1.40.0
```

The shared FRG validator already distinguishes hybrid-v1 from hybrid-v2 and checks policy identity, HMAC, release version, manifest identity, provenance fingerprint, candidate SHA, and the closed proof matrix. The remaining defect is `assertFrgCandidateProvenance` in `core/scripts/stages/ship-adapter.ts`, which treats mere presence of `pack_provenance` as historical hybrid-v1. Honest `factory-gate --from-run` still writes hybrid-v2. `pipeline release` and `release ensure-tag` do not use this assertion, so those leaf verbs can finish while in-engine `pipeline ship` cannot. This is the v1.40.1 product fix. Do not strip `pack_provenance`. Do not restore `--skip-frg`.

## What Changes

- Ship FRG observation SHALL reuse the shared FRG validator. It SHALL NOT duplicate policy, manifest, fingerprint, proof-matrix, or HMAC checks.
- After that validator accepts the artifact, ship SHALL add only the cross-object bind it owns: ship intent, integrated train candidate, and closed factory-release checkpoint.
- For releases after `1.33.0`, ship SHALL accept only hybrid-v2 evidence (`policy_id: factory-gate-v1-hybrid-v2`) whose HMAC-covered `factory_release_binding` fully matches the closed checkpoint through the existing binding-comparison helper.
- Historical `1.33.0` behavior SHALL stay unchanged. Hybrid-v1 remains valid only for exactly `1.33.0`. The durable-binding requirement applies after `1.33.0`.
- Ship SHALL remove the unreachable post-pilot provenance-free / version-index fallback and the stale `durableCandidateGitSha` test seam. Current strict release eligibility already requires hybrid provenance for these releases.
- Fail-closed diagnostics SHALL name the mismatched policy id or binding field. They SHALL NOT weaken rejection.

## Acceptance criteria

- [ ] A real-shaped `1.40.0` hybrid-v2 `latest.json` with valid HMAC, matching train candidate, and matching closed checkpoint passes `observeFrgEvidence` and ship proceeds to the next phase after `frg_pack`.
- [ ] The observed v1.39.16 and v1.40.0 rejection shape (`hybrid pack_provenance is valid only for v1.33.0; got <version>`) fails the new unit test before the assertion change and passes after it.
- [ ] Hybrid-v2 with missing, unauthenticated, or checkpoint-mismatched `factory_release_binding` fails closed during ship observe.
- [ ] Hybrid-v1 (`factory-gate-v1-hybrid-v1`) on any release after `1.33.0` fails closed.
- [ ] Unknown policy identities, release / candidate / repository / base / manifest mismatches, and invalid HMAC continue to fail closed.
- [ ] Existing historical `1.33.0` fixtures keep their current acceptance semantics.
- [ ] The provenance-free / version-index fallback and `durableCandidateGitSha` seam are gone. Tests that encoded that path fail if the seam returns.
- [ ] The fail-closed message names the mismatched `policy_id` or `factory_release_binding` field. It does not accept the artifact.
- [ ] Unit tests inject I/O. They do not use real network, git, or subprocess. After any `core/` edit, `node scripts/build.mjs` keeps generated host SKILL fresh. `npm run ci` is green.
- [ ] The change does not restore `--skip-frg`, does not add merge inside advance/loop, and does not change merge authorization.

## Capabilities

### New Capabilities

<!-- None. This corrects ship observation of existing hybrid-v2 evidence. -->

### Modified Capabilities

- `ship-coordinator`: After the shared FRG validator accepts release-eligible evidence, ship observation SHALL accept candidate-bound hybrid-v2 for releases after `1.33.0` when HMAC-covered `factory_release_binding` matches the closed checkpoint and the ship intent / train candidate. It SHALL NOT reject solely because `pack_provenance` is present. Hybrid-v1 remains `1.33.0`-only. The provenance-free / version-index fallback SHALL be removed.
- `factory-reliability-gate`: A ship-path consumer of already-validated release-eligible evidence SHALL distinguish hybrid-v1 from hybrid-v2 by `pack_provenance.policy_id`. It SHALL NOT treat mere presence of `pack_provenance` as the historical `1.33.0` hybrid-v1 pin. It SHALL reuse the shared validator and the existing unsigned-digest binding comparison. It SHALL NOT invent a second policy, HMAC, manifest, fingerprint, or proof-matrix checker.

## Impact

- `core/scripts/stages/ship-adapter.ts` — `assertFrgCandidateProvenance` and `observeFrgEvidence`. Remove `durableCandidateGitSha` and the version-index fallback.
- Existing helpers reused in place: `observeReleaseEligibleFrgEvidence` / `validateReleaseEligibleFrgEvidence`, `isFrgHybridV1PolicyId` / `isFrgHybridV2PolicyId`, `unsignedDigestBindingMismatch` / `buildFactoryReleaseUnsignedDigestBinding` in `factory-release-prepare.ts`.
- `core/test/ship-adapter.test.ts` — invert the post-pilot hybrid-provenance rejection; add `1.40.0` hybrid-v2 accept; keep `1.33.0` fixtures; bite missing / unauthenticated / mismatched binding and hybrid-v1 after the pilot.
- Shared FRG validator tests in `core/test/factory-reliability-gate.test.ts` stay fail-closed. Do not retune HMAC, policy, or proof-matrix rules.
- Host SKILL freshness via `node scripts/build.mjs` after any `core/` edit. Do not recreate `plugin/`.
- No `auto_merge` config. No merge inside advance/loop. No `--skip-frg` restore. No stripping of `pack_provenance` from honest from-run evidence.

### Engine-dogfood bar (#1340)

1. **Class vs site.** Class: a ship-path consumer after the shared FRG validator treats `pack_provenance != null` as historical hybrid-v1 and pins it to `1.33.0`. Site: v1.39.16 (`ship-b1ee2e8856f723b4f13e2184`) and v1.40.0 (`ship-b014ee47a50a7f315b551523`, candidate `385bf89f3cfb220e2e3a40abc333496fb3fca091`) with honest hybrid-v2 `latest.json`.
2. **Shared law.** Ship observe reuses the shared validator and `unsignedDigestBindingMismatch`. Policy identity is `policy_id`, not presence of `pack_provenance`. The next post-pilot ship does not need a new mole.
3. **Next identical fault.** A later release (`1.41.0`, …) with HMAC-pass hybrid-v2, matching train candidate, and matching closed checkpoint passes the same assertion without a new issue.
