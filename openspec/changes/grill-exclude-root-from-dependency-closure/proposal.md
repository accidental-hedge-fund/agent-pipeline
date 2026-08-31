## Why

A successful authenticated grill cannot be promoted with `pipeline triage N --stage ready` after Pipeline writes Decisions metadata. The command reports `stale fingerprints: dependency_closure_sha256` even when no declared dependency changed. The same deterministic result occurred on #1305 and #1344. Those issues are regression evidence. They are not authority for this change.

Root cause: `walkDeclaredDependencyClosure` includes the root issue in `record.per_id` and hashes the full root body. Preview hashes the original body. After apply, the root body contains the Decisions fence, the rendered Decisions section, and answered provenance. Ready hashes that new full body. `title_sha256` and `applied_body_sha256` already bind root identity. Hashing the root body again in the dependency closure makes Pipeline-owned metadata look like a dependency change.

This is engine-dogfood grill fingerprint law. It is not a path-local fix for #1305 or #1344.

## What Changes

- Exclude the root issue from the dependency-closure record `per_id` and from `ids`.
- Stop hashing the root title or the root body, full or core, inside `dependency_closure_sha256`.
- Parse root declared-dependency edges from the proposed specification core at preview and sign time, and from the applied specification core after apply.
- Do not parse root edges from the pre-proposal body when a proposed or applied specification exists.
- Do not parse root edges from the Pipeline-owned Decisions fence, the rendered Decisions section, or handoff provenance.
- Preview, apply, and ready call the same existing walker with that specification-core edge source. Do not add a second walker. Do not add a ready-only exception.
- Keep `title_sha256` and `applied_body_sha256` as the only root identity binding.
- Keep hashing every reachable declared-dependency title and body.
- Keep fail-closed behavior for cycles, missing or inaccessible dependencies, malformed declarations, depth exhaustion, and count exhaustion.
- Keep the ready fingerprint check in force. Do not skip it. Do not weaken title, applied-body, base, CONTEXT, provider, or planning-treatment fingerprints.
- Document the fingerprint contract in existing grill or ready fingerprint docs. Do not add a new verb. Do not add a new markdown file per command.
- Ship as an ordinary ready-to-deploy PR. Advance still does not merge. Do not add a merge stage or an `auto_merge` config key.

## Capabilities

### New Capabilities

None. This change tightens existing grill fingerprint law. It does not add a command, schema, or walker.

### Modified Capabilities

- `grill-then-ready-refinement`: Root identity stays `title_sha256` plus `applied_body_sha256`. The dependency-closure record hashes reachable declared dependencies only. Pipeline-owned Decisions metadata is not a bound input. Preview, apply, and ready use one walker and the specification-core edge source.

## Impact

- **Engine:** `core/scripts/grill-facts.ts` (`walkDeclaredDependencyClosure`), call sites in `core/scripts/grill-issue.ts` (preview, apply, ready snapshot). Reuse `extractSpecCore` and `parseDeclaredDependencyIds`. Do not add a second parser or walker.
- **Ready gate:** `core/scripts/grill-ready.ts` and `core/scripts/stages/triage.ts` keep the fingerprint check. The snapshot formula changes. The check stays in force.
- **Tests:** `core/test/grill-then-ready.test.ts` replay of preview → apply → answer every authority handoff → `triage --stage ready` with injected GitHub and handoff I/O.
- **Docs:** existing grill or ready fingerprint text (living spec plus `docs/adr/0002-decisions-live-in-the-issue-body.md`). Advisory CONTEXT terms only. No new CLI verb. No new per-command markdown file.
- **Out of scope:** ignoring real declared-dependency changes; weakening authenticated frontier or handoff provenance; treating comments as specification; bypassing `pipeline triage --stage ready`; extra operator re-attestation of #1305, #1344, or other live grill issues; any destructive git, merge, delete, or force-push operation.

## Acceptance Criteria

- [ ] Preview → apply → answer every authority handoff → `pipeline triage N --stage ready` succeeds when no bound input changed and no declared dependency changed.
- [ ] Adding the Decisions fence or section and updating handoff provenance does not change `dependency_closure_sha256`.
- [ ] A proposed body that adds, removes, or changes a declared dependency computes the closure from that proposed specification core before signing.
- [ ] A dependency issue title or body change after preview still produces `stale fingerprints: dependency_closure_sha256`.
- [ ] A root title change still stales `title_sha256`.
- [ ] A specification-core change still stales `applied_body_sha256`.
- [ ] The dependency-closure record does not include the root issue.
- [ ] `dependency_closure_sha256` does not hash the root title or the root body, full or core.
- [ ] Preview, apply, and ready use the same walker and the same specification-core edge source.
- [ ] Regression tests replay the #1305/#1344 sequence with injected GitHub and handoff I/O.
- [ ] Existing fail-closed behavior remains for dependency cycles, missing dependencies, inaccessible dependencies, malformed declarations, depth exhaustion, and count exhaustion.
- [ ] Operator-facing grill or ready fingerprint docs state: root identity is title plus applied specification core; dependency closure covers declared dependencies only; Pipeline-owned Decisions metadata is not a bound input. Do not add a new verb. Do not add a new markdown file per command.
- [ ] Ship as an ordinary ready-to-deploy PR. Advance still does not merge. Do not add a merge stage or an `auto_merge` config key.
- [ ] `npm run ci` passes.
