## 1. Manifest and policy identity

- [ ] 1.1 Add durable hybrid v2 policy identity (`factory-gate-v1-hybrid-v2`) in the pack manifest and observation loader. Stop requiring `release_version === "1.33.0"` / replacement issue `#908` for current scoring
- [ ] 1.2 Keep the existing required-live lists (`clean-item-throughput`, `blocker-taxonomy`, `empty-depends-on-stack-honesty`, `openspec-bearing-item`) and the existing closed `layer_a_probes` matrix as the Layer A-allowed set. Every required scenario and composition id still has exactly one owner
- [ ] 1.3 Keep hybrid v1 (`factory-gate-v1-hybrid-v1` + `1.33.0`) readable for historical 1.33.0 evidence only. A v1 policy id on any other version fails closed

## 2. Collector and scorer

- [ ] 2.1 Unbind `collectFrgPackObservations` from “valid only for release 1.33.0”. Bind Layer A probes to the bundle candidate SHA, pack/manifest identity, and closed probe list
- [ ] 2.2 Update `hybridPilotProofValid` / `isReleaseEligibleFrgPass` so a non-1.33.0 version can pass under hybrid v2 when required-live is observed and every closed Layer A probe has a same-SHA TAP hash
- [ ] 2.3 Change the blanket `not_observed` rule: required-live `not_observed` fails overall pass; Layer A-allowed may prove from TAP hash; missing/skip/mismatch TAP still fails that probe
- [ ] 2.4 Refuse `source: layer_a` (or a probe id) for any id not on the closed Layer A-allowed set. Keep rejecting caller-authored pass, status, metric, and receipt fields

## 3. Tests

- [ ] 3.1 Required-live `not_observed` → overall `pass: false` even when all Layer A-allowed probes have valid fixture TAP hashes
- [ ] 3.2 Layer A-allowed proven by fixture TAP hash on the same candidate SHA → overall can be `pass: true` for a version other than `1.33.0` when required-live is observed and other existing criteria hold
- [ ] 3.3 Unknown id (or required-live id) claimed as `layer_a` → refuse; no release-eligible pass
- [ ] 3.4 Keep a historical lock: 1.33.1 (or any later version) cannot pass on hybrid v1 / 1.33.0-only policy identity. Prove the new tests fail without the production change

## 4. Docs and packaging

- [ ] 4.1 Replace the runbook hybrid-expiry paragraph in `docs/factory-reliability-gate-runbook.md` with durable hybrid v2. Keep v1.33.0 as historical. Do not describe Layer A probes as live injection
- [ ] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 4.3 Run `openspec validate frg-durable-hybrid-v2` and `npm run ci` from the repo root. Fix failures until green
