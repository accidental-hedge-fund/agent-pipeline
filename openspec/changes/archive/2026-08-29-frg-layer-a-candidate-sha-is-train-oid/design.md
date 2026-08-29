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

### 1. One identity resolver; ship-path never uses control HEAD

**Choice:** Export a pure helper (for example `resolvePackedCandidateIdentity`) that returns packed candidate `C` or fails closed. Normalize every SHA with `parseExactGitSha` from `core/scripts/ship-end-identity.ts` (trim, lowercase, exact 40-hex). Abbreviated SHAs are malformed.

**Inputs (two named sources, not “binding or request”):**

| Source | When it is in hand |
| --- | --- |
| Loop binding | `factory-release-binding.json` exists on the scored loop. Field is `candidate_git_sha` (durable copy of request `integrated_candidate.git_sha`, written by `persistFactoryReleaseLoopBinding` before pack spawn). |
| Request SHA | In-process scorer already holds `FactoryReleasePrepareRequest.integrated_candidate.git_sha` (`defaultScoreBoundPackLoop`). CLI `pipeline factory-gate --from-run` does not pass the request object. |

**Ship-path vs standalone:**

- **Ship-path** when the request SHA is provided **or** the loop binding file is present (even if unreadable).
- **Standalone** when the request SHA is not provided **and** the binding file is absent. Local operator `--from-run` of an unbound pack loop keeps today’s `gitHead(repoDir)` identity.

**Ship-path law (fail closed before probes or evidence write):**

1. A present source that does not parse as an exact 40-hex OID fails closed. Do not fall back to the other source. Do not fall back to `repoDir` HEAD. This matches `hmacPackedCandidateGitShaFromUnknown` in `core/scripts/stages/ship-adapter.ts`: a present invalid binding does not fall back to `pack_provenance`.
2. If the request SHA is provided, the binding file is required. A missing binding on that path fails closed (`Missing ship-path binding does not stamp control HEAD`).
3. If both parse, they MUST be equal. Conflict fails closed.
4. If only the binding is in hand (CLI `--from-run` on a bound loop), `C` is the binding SHA.
5. Request-bound ship-path collect MUST NOT call `gitHead(args.repoDir)` / `git rev-parse HEAD` in `repoDir` for identity. Injected `gitHead` that throws on `repoDir` MUST still let the bite test pass after the fix, and MUST fail today’s collector.

**Why:** `repoDir` is the evidence write root (control checkout `.agent-pipeline/frg/`). It is not packed-candidate identity. Binding is already persisted before pack spawn. Ensure-tag packed SHA is the same field. Using HEAD of “the right directory” still drifts when cwd is control.

**Alternatives considered:**

- Fast-forward `REPO_DIR` to `C` before collect → rejected: issue non-goal; next lag is another mole.
- `gitHead(candidateEngineDir)` instead of `gitHead(repoDir)` with no request/binding field → incomplete: identity still depends on which checkout cwd happens to be.
- Pass `--packed-candidate` on every Tugboat `factory-gate --from-run` only → site-local; in-engine ship and a later composer that forgets the flag recreate the mole.
- Prefer request over binding, or binding over request, when they differ → rejected: conflict is a defect. Fail closed.
- Use request alone when the binding file is missing on the in-process prepare path → rejected: prepare writes the binding before spawn; a missing file is a ship-path defect, not a reason to stamp HEAD or to skip the durable copy.

### 2. Probe cwd is an explicit candidate-engine path at `C`

**Choice:** After identity resolves to `C`, collect SHALL resolve a candidate engine checkout with existing `resolveCandidateEngine` from `core/scripts/ship-end-candidate.ts` (`repoDir`, `candidateSha: C`, `PIPELINE_CANDIDATE_ENGINE_ROOT`). First match stays: clean `REPO_DIR` HEAD == `C`, else `.worktrees/ship-candidate-<C>`, else `PIPELINE_CANDIDATE_ENGINE_ROOT`, else create that worktree when deps allow. Collect SHALL NOT reset operator `REPO_DIR` HEAD.

Pass the resolved `engine.engineRoot` into `runProbe` as an explicit `candidateEngineDir` (do not overload control `args.repoDir`). `defaultRunLayerAProbe` SHALL use `cwd: candidateEngineDir`. Every probe record `candidate_git_sha` SHALL equal provenance `C`.

If `resolveCandidateEngine` cannot prove a clean checkout whose HEAD is `C`, collect SHALL fail closed **before** any TAP run and **before** evidence write. Collect SHALL NOT hash pin-source TAP from control `repoDir` (HEAD `P`) and label it `C`.

**Why:** #1151 already launches ship-end CLI from the candidate engine, but Tugboat/in-engine spawn still uses control cwd (`execFile` `cwd: opts.repoDir` in `realShipCoordinatorDeps`). Launcher identity is not TAP cwd. Provenance must execute against sources for `C`, not relabel pin TAP.

**Alternatives considered:**

- Stamp `C` but keep probe `cwd = args.repoDir` (control at `P`) → rejected: SHA-only relabel.
- Require control HEAD === `C` before collect → rejected: that is fast-forward-as-fix.
- Skip Layer A probes when HEAD ≠ `C` and still pass → rejected: honest-pass needs candidate-SHA TAP hashes.
- Derive cwd only from the running launcher path and skip `resolveCandidateEngine` → rejected: tests and in-process `defaultScoreBoundPackLoop` must share the same #1151 resolver. Launcher path MAY be a future extra root; it is not this change.

### 3. Ensure-tag comparison stays fail-closed; producer is the fix

**Choice:** Do not change `hmacPackedCandidateGitShaFromUnknown` vs `--packed-candidate`. HMAC `P` vs packed `C` still throws `HMAC candidate_git_sha is not this ship's packed candidate`. HMAC `C` vs packed `C` succeeds even when control HEAD is `P`. The helper does not read control HEAD today; keep that. Do not rewrite `latest.json`. Do not skip HMAC.

**Why:** The tag helper is already correct. Loosening it to accept pin SHA would ship unbound evidence. The class fix is collect identity plus honest probe cwd.

**Testing seams (inject I/O; no real git, network, or subprocess):**

- Bite: `repoDir` HEAD `P`, binding and/or request `C`, `gitHead(repoDir)` throws if called. Provenance and every probe record equal `C`.
- Probe invocation: captured `runProbe` `candidateEngineDir` / cwd / argv is the engine root for `C`, not control `repoDir`.
- Missing or conflicting request/binding fails before probes and before `collectFrgPackObservations`.
- Standalone (no request, no binding file) still uses `gitHead(repoDir)`.
- `ensureAnnotatedReleaseTag`: HMAC `C` + packed `C` accepted (control HEAD `P` out of band). HMAC `P` + packed `C` still throws.

## Risks / Trade-offs

- **[Risk] Standalone `--from-run` without a binding file loses HEAD identity.** → Mitigation: `gitHead(repoDir)` remains only for standalone (no request SHA and no binding file). Ship-path never takes that fallback.
- **[Risk] SHA-only relabel of pin TAP as `C`.** → Mitigation: fail closed unless `resolveCandidateEngine` returns a clean checkout at `C`. Tests capture probe cwd/path/args. Do not pass by rewriting SHA after hashing `P`.
- **[Risk] Evidence write path moves off the control FRG directory.** → Mitigation: `args.repoDir` remains the persist root. Only identity and probe cwd change.
- **[Risk] Tests keep injecting `gitHead` and miss production binding load.** → Mitigation: request-bound bite injects `gitHead` that throws on `repoDir`. Collect must load binding/request and must not consult that seam for identity.
- **[Risk] Candidate engine worktree missing on the attestor host.** → Mitigation: fail closed with the existing `resolveCandidateEngine` error. Do not probe control HEAD. Do not skip HMAC.

## Migration Plan

- Ship on the next pin≠candidate factory release (v1.39.16 cluster; unblocks ensure-tag after attest).
- Rollback: revert collect identity; HMAC again stamps control HEAD; ensure-tag throws again when pin ≠ candidate.
- No data migration. Existing `latest.json` stamped with pin `P` remains invalid for packed `C`. Re-run `--from-run` on the candidate engine after this change. Do not rewrite the old artifact. Do not `--skip-frg`.

## Open Questions

None. Identity resolver (binding required on request-provided ship-path; equality when both parse; no HEAD fallback on ship-path), explicit `resolveCandidateEngine` probe cwd, standalone HEAD retained, no control ff, no HMAC skip, and ensure-tag fail-closed on `P` are settled.
