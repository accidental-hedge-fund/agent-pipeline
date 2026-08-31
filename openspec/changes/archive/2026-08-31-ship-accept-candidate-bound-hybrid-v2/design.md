## Context

See `proposal.md` for motivation. After `observeReleaseEligibleFrgEvidence` accepts HMAC-pass `latest.json`, `assertFrgCandidateProvenance` throws whenever `pack_provenance` is present and `intent.version !== "1.33.0"`. Honest `--from-run` always writes hybrid-v2 `pack_provenance` after the pilot (`hybridProvenanceRequired`). The version-index / `durableCandidateGitSha` fallback is therefore unreachable for actually-eligible post-pilot evidence: the `if (!provenance)` branch never runs after a successful shared-validator read.

The shared validator already distinguishes `factory-gate-v1-hybrid-v1` from `factory-gate-v1-hybrid-v2` and checks HMAC, policy, manifest, fingerprint, candidate SHA, and the closed proof matrix. Prepare observation already accepts HMAC-pass hybrid-v2 when `unsignedDigestBindingMismatch` is null. Leaf `pipeline release` / `release ensure-tag` never call this assertion.

Existing helpers to reuse (first holding rung):

- `observeReleaseEligibleFrgEvidence` / `validateReleaseEligibleFrgEvidence`
- `isFrgHybridV1PolicyId` / `isFrgHybridV2PolicyId`
- `defaultResolveShipPathFromRun` (version index + checkpoint store)
- `buildFactoryReleaseUnsignedDigestBinding` / `unsignedDigestBindingMismatch`

### Engine-dogfood bar (#1340)

1. **Class vs site.** Class: a ship-path consumer after the shared validator treats `pack_provenance != null` as historical hybrid-v1. Site: v1.39.16 and v1.40.0 `frg_pack` throws.
2. **Shared law.** Policy identity is `policy_id`. Checkpoint equality is `unsignedDigestBindingMismatch`. Do not add a ship-local hybrid decoder.
3. **Next identical fault.** Any later post-pilot ship with honest hybrid-v2 + matching checkpoint passes the same assertion.

## Goals / Non-Goals

**Goals:**

- Post-pilot `observeFrgEvidence` accepts real-shaped hybrid-v2 with HMAC, matching train candidate, and matching closed checkpoint.
- Fail-closed on hybrid-v1 after the pilot, unknown policy, missing / notes-only / mismatched binding, and identity defects.
- Remove the provenance-free / version-index fallback and `durableCandidateGitSha`.
- Keep `1.33.0` fixture acceptance.

**Non-Goals:**

- Changing shared FRG eligibility, HMAC canonical payload, or Layer A matrices.
- Restoring `--skip-frg` or stripping `pack_provenance`.
- Making leaf `release` / `ensure-tag` the product path.
- Merge inside advance/loop, `auto_merge`, or a grant file.
- A new binding schema or a second hybrid policy decoder.

## Decisions

### 1. Reuse the shared validator; ship owns only the cross-object bind

**Choice:** Keep `observeFrgEvidence` calling `observeReleaseEligibleFrgEvidence`. After a non-null eligible read, `assertFrgCandidateProvenance` binds that evidence to ship intent, train candidate, and closed checkpoint. Do not copy policy / manifest / fingerprint / proof-matrix / HMAC rules into `ship-adapter.ts`.

**Why:** Those checks already fail closed in the shared validator. Duplicating them is the next drift mole. The live defect is the extra assertion, not the validator.

**Alternatives considered:**

- Delete `assertFrgCandidateProvenance` and trust the shared validator alone → incomplete: validator does not bind this ship's intent / train / closed checkpoint.
- Call prepare `tryLoadAttestedEvidence` instead of observe + assert → re-runs HMAC/eligibility inside ship and still needs intent/train bind; extra coupling to prepare's accepted/absent/rejected triad that observe already mapped to `FrgEvidence | null`.
- Strip `pack_provenance` from `--from-run` so the current assertion is silent → rejected by the issue and by hybrid-v2 collect.

### 2. Select hybrid-v1 vs hybrid-v2 by `policy_id`, not presence

**Choice:** After an eligible read:

| Version | `policy_id` | Result |
| --- | --- | --- |
| `1.33.0` | hybrid-v1 or hybrid-v2 with matching `pack_provenance` candidate/repo/base | accept (current) |
| after `1.33.0` | `factory-gate-v1-hybrid-v2` plus matching checkpoint binding | accept |
| after `1.33.0` | `factory-gate-v1-hybrid-v1` or unknown | fail closed, name the policy id |
| after `1.33.0` | no `pack_provenance` | fail closed (no index fallback) |

Use `isFrgHybridV1PolicyId` / `isFrgHybridV2PolicyId`. Do not compare `intent.version !== "1.33.0"` merely because `pack_provenance` is present.

**Why:** Presence is the current bug. Policy ids already exist and are what the shared validator uses.

**Alternatives considered:**

- Keep the v1.33-only throw and special-case hybrid-v2 later → still presence-based; next policy id is another mole.
- Accept any `pack_provenance` after the pilot → weakens hybrid-v1 expiry.

### 3. Checkpoint match is `unsignedDigestBindingMismatch`; replace the SHA-only seam

**Choice:** Replace `opts.durableCandidateGitSha` with the closed unsigned digest binding (or the request + unsigned payload needed to build it). Production loads that checkpoint with `defaultResolveShipPathFromRun` (version index + `factoryReleaseCheckpointPath` unsigned payload) and `buildFactoryReleaseUnsignedDigestBinding`. Compare with `unsignedDigestBindingMismatch(expected, evidence.factory_release_binding)`. Surface the helper's field-name string in the throw. Ship-path resolution that returns standalone / fail after a post-pilot eligible read SHALL throw, not accept.

Also require `pack_provenance.candidate_git_sha`, `factory_release_binding.candidate_git_sha`, and `train.integrated_head_oid` to be the same exact SHA, and `pack_provenance.repository` / `base_branch` to match intent (existing 1.33.0 identity check, kept for v2).

**Why:** The helper already names `kind`, fingerprint, version, candidate, pack, loop, `frg_run_id`, and artifact digest mismatches. The version-index SHA-only path is the stale seam the issue removes. `hybridProvenanceRequired` already makes provenance-free post-pilot evidence ineligible at the shared validator.

**Alternatives considered:**

- Keep `durableCandidateGitSha` and also check `policy_id` → leaves the unreachable fallback and the test that accepts provenance-free post-pilot evidence.
- Re-read only `factory_release_binding.candidate_git_sha` against the train → weaker than "fully matches the closed checkpoint".
- Inline field-by-field comparison in `ship-adapter.ts` → second binding schema; drift vs prepare observe.

### 4. Tests invert the current rejection and bite the live throw string

**Choice:** Change `core/test/ship-adapter.test.ts`:

- Invert `"ship adapter never rebinds provenance-free FRG evidence to a candidate"` so post-pilot hybrid provenance with matching binding is accepted, provenance-free / index-only is refused, and hybrid-v1 after the pilot throws.
- Add `observeFrgEvidence` cases for real-shaped `1.40.0` hybrid-v2 (HMAC, `policy_id: factory-gate-v1-hybrid-v2`, matching candidate `C`, matching `factory_release_binding`). Reuse existing mint / `computeFrgEvidence` / `buildFactoryReleaseUnsignedDigestBinding` fixtures from FRG tests. Inject checkpoint files or the expected binding through deps. No real git/network/subprocess.
- Prove red: the current throw `/hybrid pack_provenance is valid only for v1\.33\.0/` must fail the new accept test before the assertion change.
- Keep existing `1.33.0` `mintHybridEvidence` accept / mismatch cases.

**Why:** The current test encodes the bug as required behavior. Without inverting it, the class returns.

**Alternatives considered:**

- Coordinator-only stub of `observeFrg` → missed the production assertion in #1271; do not repeat.

## Risks / Trade-offs

- **[Risk] Loading the closed checkpoint in observe adds I/O and a new fail-closed when index/checkpoint is missing after an eligible read.** → Mitigation: that is required (no SHA-only fallback). Tests inject the checkpoint; production uses `defaultResolveShipPathFromRun`, which already fail-closes on ship-path missing/conflict.
- **[Risk] Double HMAC: observe then binding compare.** → Mitigation: compare runs only after eligible read; HMAC is not reimplemented. Accept the extra read of persisted unsigned artifacts.
- **[Risk] `1.33.0` hybrid-v2 fixtures start requiring a binding.** → Mitigation: keep `1.33.0` on the current pack_provenance identity check; durable-binding requirement is after `1.33.0` only.
- **[Risk] Leaf `release` / `ensure-tag` are treated as the ship product path.** → Mitigation: they stay unchanged; this issue is in-engine `pipeline ship` observe. Do not finish a later ship by skipping FRG.

## Migration Plan

- Land the assertion + tests. Next `pipeline ship --milestone` for a post-pilot version reuses on-disk hybrid-v2 `latest.json` when the checkpoint matches.
- Rollback: revert the assertion; post-pilot ships with `pack_provenance` throw the v1.33-only message again.
- No data migration. No grant file. Do not strip `pack_provenance` from existing `1.39.16` / `1.40.0` artifacts.

## Open Questions

None. Policy-by-identity, reuse of `unsignedDigestBindingMismatch`, removal of `durableCandidateGitSha`, and preservation of `1.33.0` acceptance are settled by the issue and the two live ship throws.
