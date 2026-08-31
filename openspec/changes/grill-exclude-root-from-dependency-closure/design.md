## Context

See `proposal.md` for why.

Today `walkDeclaredDependencyClosure` in `core/scripts/grill-facts.ts` visits the root first, pushes it into `record.per_id`, and hashes the full root title and body. Preview in `runRefineSpecIssuePreview` walks `issue.body` before the Implementer returns, then signs that record. After apply, `realGrillReadySnapshot` walks the live full body, which now contains the Decisions fence, the rendered Decisions section, and later handoff provenance. `applied_body_sha256` already hashes `extractSpecCore`. The extra root-body hash inside the closure is the self-stale.

Existing modules already hold the pieces:

- `walkDeclaredDependencyClosure` — one bounded walker, one grammar (`parseDeclaredDependencyIds`)
- `extractSpecCore` — strips Decisions fence, rendered section, and related Pipeline-owned body text
- `buildGrillFingerprint` / `hashDependencyClosure` / `fingerprintStaleReasons` — ready still compares every field

This is class-level grill fingerprint law. The next Pipeline-owned body field must not need a new mole issue.

## Goals / Non-Goals

**Goals:**

- One walker, one specification-core edge source, at preview, apply, and ready.
- Root identity stays `title_sha256` plus `applied_body_sha256`.
- Closure hash covers reachable declared dependencies only.
- Pipeline-owned Decisions metadata is invisible to `dependency_closure_sha256`.
- Fail-closed dependency facts stay fail-closed.
- Ready fingerprint check stays in force.

**Non-Goals:**

- A second walker, a second parser, or a fingerprint schema bump.
- A ready-only exception that leaves preview and ready on different root-body representations.
- Weakening title, applied-body, base, CONTEXT, provider, or planning-treatment fingerprints.
- Extra operator re-attestation of #1305, #1344, or other live grill issues as a ship prerequisite.
- A new CLI verb or a new markdown file per command.
- Merge inside advance/loop, a merge stage, or an `auto_merge` config key.

## Decisions

### D1 — Stop at `walkDeclaredDependencyClosure` (reuse ladder rung 2)

The first holding rung after reading the touched code is: this walker already exists. Change it. Do not add a new closure type, a ready-side stripper, or a per-call-site guard.

Inside the walker:

- Keep visiting the root so edge discovery and cycle detection still start there.
- Do not append the root to `record.ids` or `record.per_id`.
- Do not hash the root title or the root body, full or core.
- Parse root edges from `rootTitle` plus `extractSpecCore(rootBody)`. Child issues keep today's full title-plus-body parse and hash.
- Keep `parseDeclaredDependencyIds`. Do not invent a second parser.
- Keep depth 8 and 32-issue bounds, typed facts, and no silent truncate.

Alternative considered: a ready-only strip of Decisions text before hashing the root. Rejected: that is the representation split. Preview would still hash the original body.

Alternative considered: hash `extractSpecCore(rootBody)` as the root `body_sha256`. Rejected: settled interface-contract says the closure SHALL NOT hash the root body, full or core. Root identity stays `applied_body_sha256`.

### D2 — Specification-core edge source at every snapshot

`extractSpecCore` is the specification-core stripper. Callers pass the proposed body at preview/sign and the live body after apply. The walker always strips the root body before parsing root edges, so a caller that passes a full applied body cannot re-introduce Decisions text as edges.

Timing:

- Preview MAY walk the current specification core once to feed Implementer facts.
- After the Implementer returns, preview SHALL walk the proposed specification core and SHALL sign that record. A proposed body that adds, removes, or changes a declared dependency updates the closure before signing.
- Apply SHALL walk the proposal specification core with the same walker before the GitHub body write. A mismatch against the signed `dependency_closure_sha256` SHALL fail closed with no write. Extend `GrillIssueApplyDeps` with the existing `fetchIssue` seam from preview. Do not add a new I/O style.
- Handoff materialize SHALL patch Decisions metadata only. It SHALL NOT rewrite `dependency_closure_sha256` from the full body.
- Ready SHALL walk the live body through the same walker (root edges from applied specification core) and SHALL compare fingerprints as today.

Alternative considered: keep the pre-Implementer walk as the signed fingerprint. Rejected: a proposed body can change declared dependencies.

Alternative considered: apply copies the envelope without walking. Rejected: snapshot-unity requires apply to call the same walker. The apply walk is the check that preview did not sign a pre-proposal closure.

### D3 — Keep `grill-fingerprint.v1` field names and the ready check

Do not bump `schema_version`. Field names stay. Hash contents of `dependency_closure_sha256` change because the record no longer includes the root.

`fingerprintStaleReasons` stays as-is. Ready still exits 2 on any field mismatch, including `dependency_closure_sha256`. Do not skip the check. Do not special-case Decisions metadata at the comparator.

Existing helper tests that put the root in `per_id` MUST change fixtures so `ids`/`per_id` contain declared dependencies only. Empty closure (no declared deps) is `{ ids: [], per_id: [], fact_codes: [] }`.

### D4 — Docs stay on existing surfaces

Write the contract where grill or ready fingerprints are already described: the living spec (this change) and `docs/adr/0002-decisions-live-in-the-issue-body.md`. Optional one-sentence glossary note under existing Grill or Decisions terms in `CONTEXT.md` is allowed. Do not add a required CONTEXT term. The issue's `specification-core` and `dependency-closure-fingerprint` proposals are advisory.

Do not add a new verb. Do not add a new markdown file per command. Do not hand-edit generated `docs/cli.md` unless `command-docs` already describes fingerprints; the refine-spec summary today does not.

### D5 — Class over site; #1305 and #1344 are evidence

Regression tests in `core/test/grill-then-ready.test.ts` replay preview → apply → answer every authority handoff → `triage --stage ready` with injected GitHub and handoff I/O. That sequence is the #1305/#1344 bug. Those live issues are not mutated by this PR. Extra operator re-attestation is not a ship prerequisite.

Artifacts signed before this change encode a root-inclusive `dependency_closure_sha256`. Ready after this change recomputes a root-exclusive hash. Recovery is an authenticated non-ready preview/apply: when the live body already has a Decisions artifact and the only stale fingerprint is `dependency_closure_sha256`, preview signs the current root-exclusive hash without calling Implementer or Reviewer, and apply writes that snapshot. Settled nodes and answered handoffs stay. Ready still compares the single current formula. A ready-only dual-formula compare is forbidden.

## Risks / Trade-offs

- **[Risk] Old signed artifacts remain stale after this lands** → Mitigation: `pipeline refine-spec --issue N` then `apply` is the authenticated refresh. When only `dependency_closure_sha256` is stale, preview does not re-grill, so extra handoff answers are not required. Ready does not dual-compare formulas.
- **[Risk] Apply gains a dependency fetch** → Mitigation: reuse the preview `fetchIssue` seam. Fail closed on mismatch, missing, inaccessible, cycle, malformed, or exhaustion, same as ready. No model call.
- **[Risk] Root title dependency phrases are dropped** → Mitigation: parse root edges from title plus specification core. Do not hash the title inside the closure.
- **[Risk] Child grilled issues still hash full bodies** → Mitigation: intended. A declared dependency body change is a bound input. Only the root's Pipeline-owned metadata is excluded.
- **[Risk] Empty-closure fixtures and cycle tests assume the root is in `per_id`** → Mitigation: update those tests in the same suite. Keep fail-closed coverage.

## Migration Plan

- Ship as an ordinary ready-to-deploy PR. Advance does not merge.
- After merge, operators run `pipeline refine-spec --issue N` then `pipeline refine-spec apply --issue N` on issues signed under the old walker. That refresh rewrites only the signed closure hash and re-persists the frontier. Then `pipeline triage N --stage ready` can succeed.
- No destructive git operation. No force-push. This PR does not mutate live GitHub bodies by itself.
- Rollback is a revert of this PR. Fingerprint field names do not change, so revert restores the previous hash formula.

## Open Questions

None. Settled Decisions already lock root exclusion, specification-core edges, snapshot unity, no ready-only exception, no extra attestation, and ordinary merge authority.
