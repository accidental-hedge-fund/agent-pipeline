## Context

See `proposal.md` for motivation. Live v1.39.15: uncredentialed prepare closed unsigned `frg_run_id=A`. Credentialed `factory-gate --from-run` called `newFrgRunId()` (timestamp + random), wrote `pack_provenance`, and did not attach `factory_release_binding` before HMAC. `tryLoadAttestedEvidence` returns early on `run_id === A`; the next line is `if (evidence.pack_provenance != null) return null`. Prepare then also refuses `attestation.frg_run_id !== unsigned.frg_run_id`. `runFrgPack` on `"attest"` spawns factory-gate and `continue`s. `classifyFrgPackWaitDecision` returns `"continue"` for every tick that is not `"retry"`.

#1298 / #1308 is a hard prerequisite: candidate SHA in this handoff is the integrated candidate, not control HEAD.

### Engine-dogfood bar (#1295)

1. **Class vs site.** Class: the two-call unsigned→attest handoff treats distinct attestor identity `B` as a miss, rejects `pack_provenance` as if it were a substitute for typed binding, and leaves `"attest"` uncapped. Site: v1.39.15 `runFrgPack` hang (`A=frg-cede01998b2bc2f0ef510840`, `B=frg-2026-08-29T13-15-12-562Z-90e766aa`).
2. **Shared law.** Credentialed `--from-run` writes HMAC-covered `factory_release_binding` joining `B` to `A` before sign. Observe is typed accepted/absent/rejected. `pack_provenance` presence is not a miss. Notes are not a binding carrier. Composers attest an unchanged checkpoint once, then fail closed.
3. **Next identical fault.** The next pin≠candidate `pipeline ship` signs bound `B` for unchanged `A`, observe accepts, prepare returns `complete`, and `"attest"` cannot hang. A later composer that forgets the cap still fails the shared wait-decision test.

## Goals / Non-Goals

**Goals:**

- Production attestor writes distinct deterministic `B` joined to `A` by HMAC `factory_release_binding`.
- Observe accepts that HMAC-pass `latest.json` even when `pack_provenance` is present and `run_id` is not `A`.
- Prepare proceeds to `complete` on that accepted observe.
- `runFrgPack` terminates after one attestor spawn plus one prepare re-invoke when observe is still absent or rejected.
- Tests drive a real-shaped `--from-run` payload (success, mismatch, bound, restart idempotency).

**Non-Goals:**

- Collapsing production `A` and `B` into one `run_id`.
- Overlaying `factory_release_binding` after HMAC (still fail-closed per #1149).
- Using notes or `pack_provenance` as the binding carrier.
- Skipping FRG, restoring `--skip-frg`, or making leaf `release` / `finish` / `ensure-tag` the product path.
- Changing the closed recovery-recipe catalogue.
- Re-opening #1298 collect identity.
- Tugboat-only argv. Tugboat already fail-closes after one attestor spawn; it consumes the same `latest.json`.

## Decisions

### 1. Distinct identities; HMAC binding is the join; attestor writes it before sign

**Choice:** Keep unsigned checkpoint identity `A` and attestor evidence identity `B` distinct. Credentialed `factory-gate --from-run` (and in-process `runFactoryGate`) SHALL load the closed unsigned checkpoint for that version + loop, build `factory_release_binding` with `buildFactoryReleaseUnsignedDigestBinding` (existing shape: schema 1, kind `factory_release_unsigned_digest_binding`, request fingerprint, target version, integrated candidate SHA, pack id, pack run id, loop run id, `frg_run_id=A`, every unsigned artifact digest), set `run_id=B`, attach the binding on the evidence object, **then** compute HMAC. Unsigned prepare and ship SHALL NOT add or overlay the field after sign.

`B` SHALL be a domain-separated SHA-256 of the canonical complete checkpoint binding of `A` (the same object the HMAC covers), not `newFrgRunId()` timestamp+random. Prefix SHALL keep `B` distinct from `A` (`A` is `frg-${sha256(action_id:candidate:version).slice(0,24)}`). Reprocessing unchanged `A` SHALL yield the same `B`.

Unsigned checkpoint source, in order, all fail-closed if missing or conflicting on this ship-path:

1. Prepare checkpoint store (`factoryReleaseCheckpointPath`) `unsigned` payload for the request fingerprint recorded in the version index.
2. Version index (`factoryReleaseVersionIndexPath`) MUST agree on `frg_run_id`, `loop_run_id`, `pack_run_id`, candidate SHA, and fingerprint.
3. Loop `factory-release-binding.json` candidate SHA MUST equal request `integrated_candidate.git_sha` (#1298).

Standalone unbound `--from-run` (no version index / no checkpoint) MAY keep today's mint of a new `run_id` and MAY omit `factory_release_binding`. Ship-path `--from-run` (version index or checkpoint present, or request SHA in hand) SHALL fail closed rather than write HMAC-pass `latest.json` without the binding.

**Why:** The locked 2026-08-29 design forbids collapsing `A` and `B`. Overlay after sign already fails HMAC (#1149). Random `B` on every spawn is why restart and the attest loop mint `B2`, `B3`. The unsigned payload already has the digests; factory-gate just never loaded them.

**Alternatives considered:**

- Re-sign with `run_id=A` (original AC1 option) → rejected by locked design: distinct audit identities.
- Ship or prepare overlay `factory_release_binding` onto already-signed `B` → rejected: HMAC fail; also teaches the wrong writer.
- Pass extra CLI flags from ship only → site-local; Tugboat and in-process score recreate the mole.
- Encode the binding only in `notes` → rejected: notes are not an authoritative carrier; today's fallback is the smell.
- Keep `newFrgRunId()` and accept any `B` with a matching binding → incomplete: each attest tick still mints `B2`; idempotency fails.

### 2. Typed observe: accepted / absent / rejected; pack_provenance is not a miss

**Choice:** Replace boolean-null observe with a typed result:

| Result | When |
| --- | --- |
| **accepted** | HMAC-pass evidence, binding matches unsigned checkpoint, version/loop/pack match, `honestLatestJsonBindsRequest` holds. `run_id` MAY be `B ≠ A`. `pack_provenance` MAY be present and MUST still pass its normal validation. |
| **absent** | `latest.json` / evidence path missing or unreadable / unparsable. |
| **rejected** | File present but HMAC fail, binding missing, binding mismatch, notes-only binding, `pack_provenance` fails its own validation, candidate/version/loop mismatch. Stable reason code plus expected `A` and observed `B` when known. |

Delete the `if (evidence.pack_provenance != null) return null` short-circuit. Delete notes `factory_release_binding:<json>` as an observe carrier. A present invalid top-level binding SHALL NOT fall back to notes or `pack_provenance`.

Prepare on **accepted** SHALL proceed toward `complete` / `runRelease`. It SHALL NOT require `attestation.frg_run_id === unsigned.frg_run_id`. The join is `factory_release_binding.frg_run_id === unsigned.frg_run_id` plus the rest of `unsignedDigestBindingMismatch`. Complete JSON MAY record attested `run_id=B`.

Prepare on **absent** SHALL return `awaiting_frg_attestation` as today.

Prepare on **rejected** SHALL still return `awaiting_frg_attestation` (prepare stays uncredentialed and does not become the attestor) **and** SHALL include the observe miss on the awaiting payload (`reason`, unsigned `A`, observed `B` when present). Ship uses that miss after the attest allowance is spent. Prepare SHALL NOT overlay a binding to convert rejected into accepted.

**Why:** Today's null fuses absent and rejected, so ship can only `continue`. The pack_provenance short-circuit is the live miss. Notes fallback contradicts #1149 and the locked design.

**Alternatives considered:**

- Keep `null` and teach ship to guess from `latest.json` → rejected: miss reason stays untyped; next formatter/shape change is another mole.
- Prepare returns `failed` on rejected → too sharp for the first observe-before-attest tick (rejected unbound `B` from a prior hang must not poison the unsigned checkpoint before the fixed attestor runs). After one attest spawn, **ship** fail-closes on still-rejected.
- Accept HMAC-pass `B` from `pack_provenance` + loop id without typed binding → rejected: provenance is not the join; #1118 already required provenance and this still hung.

### 3. Attest allowance is one spawn per unchanged complete checkpoint binding

**Choice:** `classifyFrgPackWaitDecision` (and Tugboat's shared composer law) SHALL treat `"attest"` as `"continue"` only while this complete checkpoint binding has received **zero** attestor spawns in this pack phase. After one successful attestor child (exit 0) plus one prepare re-invoke, `"attest"` is `"fail"`.

Unchanged checkpoint key: canonical complete checkpoint binding of unsigned `A` (request fingerprint + `A` + loop + pack run + artifact digests). If prepare returns a new unsigned `A'` (changed binding), the allowance resets and `B'` is a new deterministic identity.

`runFrgPack` fail-closed error SHALL name unsigned `A`, observed `B` when `latest.json` is present, and the observe miss reason. It SHALL NOT spawn a second factory-gate for that binding. `"retry"` / live-loop wait (#1150) is unchanged.

The existing test that sets `gated=true` then returns prepare `complete` SHALL instead: (1) persist a real-shaped HMAC `--from-run` payload (`run_id=B`, `pack_provenance`, top-level `factory_release_binding` matching unsigned `A`), (2) drive observe/prepare against that payload, (3) assert one gate spawn. A sibling test SHALL persist `B` + provenance and no binding, assert observe rejected and `runFrgPack` throws.

**Why:** Locked design is at-most-once, not a generic N-cap. Uncapped `"attest"` is the hang. Magical complete after a no-op gate hid the observe contract.

**Alternatives considered:**

- Cap `"attest"` at N>1 like `"retry"` → rejected: extra spawns mint confusion and the class is “one observation of the attestor result,” not “keep asking.”
- Fail on the first awaiting without spawning gate → rejected: the two-call handoff still needs one credentialed `--from-run`.
- Let live `"attest"` outlive the cap the way live `"retry"` does → rejected: attest is not a running pack loop; the attestor already exited 0.

## Risks / Trade-offs

- **[Risk] Ship-path `--from-run` cannot find the unsigned checkpoint.** → Mitigation: fail closed before HMAC write; do not persist unbound `B`. Tests inject missing checkpoint. Version index + checkpoint store already exist from the two-call handoff.
- **[Risk] Prepare `complete.frg.run_id` becomes `B` and a later consumer required `A`.** → Mitigation: complete records attested `run_id` (today it already copies `attestation.frg_run_id`). Unsigned `A` stays on the checkpoint `unsigned.frg_run_id`. Consumers that need the join read `factory_release_binding.frg_run_id`.
- **[Risk] Existing tests attach binding via notes and `run_id=A`.** → Mitigation: rewrite those fixtures to top-level HMAC binding; keep a test that notes-only is rejected.
- **[Risk] Deterministic `B` collides with `A`.** → Mitigation: domain-separated prefix/hash input distinct from the unsigned `A` formula.
- **[Risk] A leftover unbound `B` from v1.39.15 hangs the next ship.** → Mitigation: observe rejects it (no binding). One attest spawn rewrites `latest.json` to bound deterministic `B` for unchanged `A`. If rewrite cannot proceed, ship fail-closes with both ids instead of looping.
- **[Risk] `classifyFrgPackWaitDecision` change breaks `"done"`/`"fail"` ticks.** → Mitigation: only `"attest"` gains a spent-allowance input; `"retry"` live-loop law stays.

## Migration Plan

- Land on the next pin≠candidate factory release (v1.39.16 cluster). Unblocks `pipeline ship --milestone` FRG pack without a human killing the process.
- Rollback: revert attestor binding + observe + attest cap; the hang returns.
- No grant file. No data migration. Leftover unbound `latest.json` is not rewritten by prepare. Re-run credentialed `--from-run` after this change. Do not `--skip-frg`. Do not collapse `A` into `B`.

## Open Questions

None. Distinct `A`/`B`, attestor-writes-binding-before-HMAC, deterministic `B`, typed observe, notes-not-carrier, pack_provenance-not-miss, and one attest spawn per unchanged checkpoint are settled by the 2026-08-29 locked design.
