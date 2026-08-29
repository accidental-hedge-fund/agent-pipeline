## Context

See `proposal.md` for motivation. `defaultCollectHybridV2FromRun` sets `candidate_git_sha` from `git rev-parse HEAD` in `repoDir`. `pipeline factory-gate --from-run` sets `repoDir` from cwd / `--repo-path` (`findGitRoot`). Tugboat attestor (`invoke_frg_pack_attestor`) runs candidate `SHIP_END_CLI` with no `--repo-path`, so cwd is the factory control checkout. Control HEAD can remain the production pin while the request packed candidate is the train head.

Loop `factory-release-binding.json` already records `candidate_git_sha` from `integrated_candidate.git_sha`. `release ensure-tag` already compares HMAC `candidate_git_sha` to `--packed-candidate` and throws when they differ. The mole is the HMAC producer identity, not the tag helper comparison.

### Engine-dogfood bar (#1298)

1. **Class vs site.** Class: hybrid-v2 from-run collect binds Layer A / `pack_provenance.candidate_git_sha` to control-checkout HEAD instead of the request packed candidate. Site: v1.39.15 attest `latest.json` stamped pin `a884d1ed…` while request candidate was `6670cee…`.
2. **Shared law.** From-run collect (and any equivalent in-process collector) takes candidate identity from the request-bound packed candidate. Probe records use that same OID. Probes execute against that candidate's engine sources. Ensure-tag keeps fail-closed on HMAC ≠ packed `C`.
3. **Next identical fault.** The next pin≠candidate ship whose control checkout lags `origin/main` stamps HMAC `C`, and `release ensure-tag --packed-candidate C` accepts it. It does not need a human `git fetch`/`ff` of `REPO_DIR`, a HMAC skip, or a new mole issue.

## Goals / Non-Goals

**Goals:**

- Collect stamps request packed candidate `C` when control HEAD is pin `P`.
- Every Layer A probe record uses `C`. Probes run on engine sources for `C`.
- Ensure-tag accepts HMAC bound to `C` when packed is `C`. It still rejects HMAC `P`.
- The regression test fails on today's `gitHead(repoDir)` stamp of `P`.

**Non-Goals:**

- Fast-forwarding the operator control checkout as the product fix.
- Skipping HMAC or rewriting `latest.json` so the SHA equals the merge commit.
- Loosening ensure-tag to treat pin `P` as packed candidate `C`.
- Changing Layer A TAP pass criteria, required-live vs Layer A split, or pack composition.
- `--skip-frg` restore, `auto_merge`, or merge inside advance/loop.

## Decisions

### 1. Identity comes from the request-bound packed candidate, not `repoDir` HEAD

**Choice:** `factory-gate --from-run` hybrid-v2 collect SHALL set `pack_provenance.candidate_git_sha` from the request-bound packed candidate: loop `factory-release-binding.json` `candidate_git_sha` (copy of factory-release request `integrated_candidate.git_sha`), or an equivalent injected collect argument in tests. When that 40-hex OID is present, collect SHALL NOT use `git rev-parse HEAD` of `repoDir`.

**Why:** `repoDir` is the evidence write root (control checkout `.agent-pipeline/frg/`). It is not the packed-candidate identity. Binding is already persisted before pack spawn. Ensure-tag's packed SHA is the same field. Using HEAD of the "right" directory would still drift if cwd is control.

**Alternatives considered:**

- Fast-forward `REPO_DIR` to `C` before collect → rejected: issue non-goal; next lag is another mole.
- `gitHead(candidateEngineDir)` instead of `gitHead(repoDir)` with no request field → incomplete: identity still depends on which checkout cwd happens to be. Request/binding is the ship source of truth.
- Pass `--packed-candidate` on every `factory-gate --from-run` from Tugboat only → site-local; in-engine ship and a later composer that forgets the flag recreate the mole. Binding on the scored loop is already shared.
- Stamp `C` from binding but keep `gitHead(repoDir)` as a fallback when binding is missing → allowed only for unbound standalone `--from-run` (no factory-release binding). Ship-path attest is request-bound and MUST have the binding. A missing binding on that path SHALL fail closed rather than stamp control HEAD.

### 2. Probe records and probe execution share OID `C`

**Choice:** Every Layer A probe record SHALL set `candidate_git_sha` to the same packed candidate `C` as `pack_provenance`. Probe execution SHALL use candidate engine sources for `C` (the ship-end candidate engine checkout already resolved by #1151 / `SHIP_END_CLI`), not control HEAD `P`. Collect SHALL fail closed if it cannot run those probes against `C` sources (for example the executing candidate engine HEAD is not `C`). It SHALL NOT bind pin-source TAP hashes to `C`.

**Why:** Acceptance requires HMAC bound to `C` "when the score ran on candidate engine sources for `C`". Stamping `C` while hashing pin tests is a dishonest rebind. Evidence persist MAY still write `latest.json` under control `repoDir` (gitignored FRG tree). Identity and TAP cwd are the candidate, not the write root.

**Alternatives considered:**

- Stamp `C` but keep probe `cwd = repoDir` (control at `P`) → rejected: TAP is pin sources labeled as `C`.
- Require control HEAD === `C` before collect → rejected: that is fast-forward-as-fix.
- Skip Layer A probes when HEAD ≠ `C` and still pass → rejected: honest-pass requires candidate-SHA TAP hashes.

### 3. Ensure-tag comparison stays fail-closed; producer is the fix

**Choice:** Do not change `hmacPackedCandidateGitShaFromUnknown` vs `--packed-candidate`. HMAC `P` vs packed `C` still throws `HMAC candidate_git_sha is not this ship's packed candidate`. HMAC `C` vs packed `C` succeeds even when control HEAD is `P`. Do not rewrite `latest.json`. Do not skip HMAC.

**Why:** The tag helper is already correct. Loosening it to accept pin SHA would ship unbound evidence. The class fix is collect identity.

**Testing seam:** Inject `gitHead` → `P`, request/binding candidate → `C`, assert collected `pack_provenance.candidate_git_sha === C` and every probe SHA === `C`. A second test (or existing ensure-tag case) keeps fail-closed when HMAC is `P` and packed is `C`. No real git, network, or subprocess.

## Risks / Trade-offs

- **[Risk] Unbound standalone `--from-run` without `factory-release-binding.json` loses HEAD identity.** → Mitigation: last-resort `repoDir` HEAD only when no request binding exists. Ship-path attest MUST load the binding and MUST NOT take that fallback.
- **[Risk] Stamping `C` over pin TAP hashes.** → Mitigation: fail closed unless probe execution is the candidate engine sources for `C`. The regression asserts probe records equal `C`; implementation MUST NOT pass by rewriting SHA after hashing `P`.
- **[Risk] Evidence write path moves off the control FRG directory.** → Mitigation: `repoDir` remains the persist root. Only identity and probe cwd change.
- **[Risk] Tests keep injecting `gitHead` and miss production binding load.** → Mitigation: the bite test MUST fail when collect still calls `gitHead(repoDir)` for identity while binding/request `C` is present.

## Migration Plan

- Ship on the next pin≠candidate factory release (v1.39.16 cluster; unblocks ensure-tag after attest).
- Rollback: revert collect identity; HMAC again stamps control HEAD; ensure-tag throws again when pin ≠ candidate.
- No data migration. Existing `latest.json` stamped with pin `P` remains invalid for packed `C`. Re-run `--from-run` on the candidate engine after this change. Do not rewrite the old artifact. Do not `--skip-frg`.

## Open Questions

None. Identity source (request/binding `C`), probe/provenance same OID, no control ff, no HMAC skip, and ensure-tag fail-closed on `P` are settled by the v1.39.15 incident and the issue non-goals.
