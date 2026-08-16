## Why

Post-1.33 Factory Reliability Gate (FRG) cannot honestly pass. Hybrid Layer A
provenance is refused for any version other than `1.33.0`, and `not_observed`
fails the entire gate. A real two-item pack loop cannot inject unsafe faults
(process death, forge 5xx). The 1.33 runner papered over that with hashed
Layer A probes; 1.34+ has no durable replacement.

Without a versioned two-set split, either we fabricate observations (banned),
`factory-gate` stays `pass: false` forever, or ship keeps `--skip-frg` (current,
#962). This is the first implementable v1.39.0 FRG-restore slice (#1036; parent
tracker #1035).

This is a **class** change to shared FRG scoring / pack-manifest / collector
law. It is not a path-local mole for one release. After this change, the next
identical "unsafe fault not injectable on a two-item pack" case uses the same
required-live vs Layer A-allowed split. It does not need a new one-version
waiver.

## What Changes

- **Durable hybrid v2 policy** in the FRG pack manifest and scorer. Replace the
  1.33.0-only `factory-gate-v1-hybrid-v1` expiry with a version-independent
  two-set split bound to **this candidate SHA**.
- **Required-live / ledger / derived** (must be observed on the **candidate**
  pack loop): `clean-item-throughput`, `blocker-taxonomy`,
  `empty-depends-on-stack-honesty`, and at least one OpenSpec-bearing
  composition item.
- **Layer A-allowed** (closed set only; named tests hashed to this candidate
  SHA; same class as 1.33 `pilot_probes`): `capacity-blocked-retain`,
  `resume-mid-flight`, `openspec-multi-change` residual, `implement-lockfile-dirt`,
  `local-docs-parity`, `pr-supersession`, `release-plan-row` / auto-tag guard.
  Existing mapped composition probes for those unsafe classes stay Layer A
  (fix→re-review, concurrency, worktree dirt, process-restart, forge 5xx, CI
  recovery, same-HEAD no-op, capacity coexistence, recovery-controller entry).
- **Scoring:** `not_observed` fails **required-live only**. Layer A-allowed may
  prove from a TAP hash on the same candidate commit. Missing, skip, or
  mismatch TAP still fails that probe.
- **Refuse** hybrid Layer A provenance for ids not on the closed set. No
  caller-authored pass, status, metric, or receipt.
- **Docs:** `docs/factory-reliability-gate-runbook.md` hybrid-expiry paragraph
  becomes this durable policy. v1.33.0 remains historical hybrid v1.
- **Tests:** required-live `not_observed` → overall fail; Layer A-allowed
  proven by fixture TAP hash → overall can pass; unknown id as `layer_a` →
  refuse.

**BREAKING** for release-eligibility validation after 1.33.0: hybrid Layer A
on the closed set is no longer refused solely because the version is not
`1.33.0`. Required-live `not_observed` still fails. Unknown `layer_a` ids still
fail closed.

## Acceptance Criteria

- [ ] Pack manifest and scorer encode two disjoint proof sets: required-live
      (`clean-item-throughput`, `blocker-taxonomy`,
      `empty-depends-on-stack-honesty`, ≥1 OpenSpec-bearing composition item)
      and a closed Layer A-allowed set. Every required scenario and composition
      id has exactly one owner.
- [ ] Hybrid v2 is not pinned to one SemVer. Evidence for a version other than
      `1.33.0` can be release-eligible when required-live is observed on the
      candidate pack loop and every Layer A-allowed probe has a matching TAP
      hash on that same candidate SHA.
- [ ] A required-live scenario with status `not_observed` yields overall
      `pass: false`, even when all Layer A-allowed probes have valid TAP hashes.
- [ ] Layer A-allowed scenarios proven only by a fixture TAP hash on the same
      candidate SHA can contribute to overall `pass: true` when required-live
      is observed and other existing numeric / composition / attestation
      criteria hold.
- [ ] An id not on the closed Layer A-allowed set that claims source `layer_a`
      is refused. The scorer does not treat that claim as proof.
- [ ] Missing, skipped, or SHA-mismatched TAP output for a Layer A-allowed
      probe fails that probe and overall pass. No caller-authored pass,
      status, metric, or receipt is accepted as authority.
- [ ] v1.33.0 hybrid v1 remains historical. The runbook hybrid-expiry
      paragraph states durable hybrid v2 as current policy.
- [ ] Unit tests bite the three cases above (required-live `not_observed`
      fails; Layer A TAP can pass; unknown `layer_a` refused) and fail without
      the production change.
- [ ] `plugin/` is regenerated after any `core/` edit. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This is a policy successor on the existing FRG gate. -->

### Modified Capabilities

- `factory-reliability-gate`: Replace the 1.33.0-only hybrid expiry with
  durable hybrid v2 (required-live vs closed Layer A-allowed hashed to the
  candidate SHA). `not_observed` fails required-live only. Unknown `layer_a`
  ids stay refused. Runbook hybrid paragraph becomes this policy.

## Impact

- **Specs:** delta on existing `factory-reliability-gate` living spec.
- **Code (implementation, not this proposal step):**
  `core/scripts/frg-pack-observations.ts`,
  `core/scripts/factory-reliability-gate.ts`,
  `core/scripts/frg-packs/factory-gate-v1/manifest.json`, tests under
  `core/test/` (`frg-pack-observations.test.ts`,
  `factory-reliability-gate.test.ts` and related). Regenerate `plugin/` after
  core edits.
- **Docs:** `docs/factory-reliability-gate-runbook.md` hybrid section
  (v1.33.0 remains historical).
- **Does not:** start a pack loop; change tugboat / `--skip-frg` / auto-tag /
  pin; accept fabricated `--observations` files; add live process-kill or
  forge-5xx injection; score a product milestone as FRG.
- **Siblings:** parent tracker #1035; historical hybrid v1 / #908 expiry;
  current skip path #962.
