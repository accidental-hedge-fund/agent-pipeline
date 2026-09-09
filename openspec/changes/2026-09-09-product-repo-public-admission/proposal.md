## Why

`pipeline train --merge` (and the shared public-admission path used by `single`, `merge`, and `merge-queue`) refuses to start in an ordinary product repository when no factory-control checkout is configured. That gate blocked lyric-utils milestone `data-integrity` with `admission.approved_root_unavailable`. Factory-control identity exists for agent-pipeline dogfood and FRG unique-operation collection. It is not a prerequisite for running the CLI in the repository the operator is working on.

## What Changes

- Restore `repoDir` as the default public-admission persist root when live factory-control identity is unset.
- Keep an explicit empty/`null` persist overlay fail-closed (tests and injected refusals).
- Keep factory-control overlay behavior: when that identity is live or an overlay is supplied, persist there rather than in a candidate worktree.
- Do not require `AGENT_PIPELINE_FACTORY_CONTROL`, a factory-control checkout, or any setup outside `.github/pipeline.yml` for `pipeline single`, `train`, `ship`, or `merge` in a product repo.
- Leave FRG unique-operation collection dual-root resolution unchanged (factory-plane scoring still does not invent a generic root from a candidate worktree).

## Acceptance Criteria

- [ ] `resolvePublicAdmissionPersistRoot({ repoDir })` with no factory-control identity returns `repoDir`.
- [ ] `persistPublicEntrypointAdmission` without `factoryControlRoot` writes under `<repoDir>/.agent-pipeline/runs`.
- [ ] `pipeline train --merge` from a product `repoDir` admits and may merge; it does not stop with `approved factory-control root is unavailable`.
- [ ] Explicit `factoryControlRoot: null` still refuses admission before protected work.
- [ ] An explicit factory-control overlay still writes under that overlay, not the candidate `repoDir`.
- [ ] Network-free unit tests cover the product-repo persist path and the explicit-empty overlay refusal.
- [ ] `openspec validate` and the repository `npm run ci` gate pass.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `operation-reliability`: product-repo public admission persists in the working repository; factory-control is an optional overlay, not a product-repo gate.

## Impact

- **Class vs site:** class is public-command admission refused because factory-control identity is unset. Site is lyric-utils `pipeline train --milestone data-integrity --merge`.
- **Reuse first:** keep `persistPublicEntrypointAdmission`, the stamp, and overlay fail-closed. Restore the `repoDir` fallback that #1454 removed.
- **Out of scope:** removing two-track engine pinning, FRG, unique-operation SLOs, merge authority, or auto-merge.
