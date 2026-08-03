## 1. Public contract and runtime registry API

- [ ] 1.1 Expand the public adapter contract (`harness-adapters/types.ts` or co-located declaration module) with required declaration fields: role capabilities, executable resolution, prompt delivery/limits, model/effort discovery and validation policy, sandbox/tool policy, cwd/worktree behavior, output envelope, telemetry, auth probe, version probe, runtime smoke hook
- [ ] 1.2 Implement `registerAdapter` (or equivalent) with idempotent same-identity registration, fail-closed ID collision, `resolveAdapter` / `registeredAdapterNames` / `allAdapters`, and a test-only registry reset/inject seam
- [ ] 1.3 Re-register built-in adapters (`claude`, `codex`, `grok`, `opencode`, `pi`) solely through the public registration API at engine boot; remove reliance on a private frozen map as the production source of truth
- [ ] 1.4 Add unit tests for registration, collision, resolution, and registry enumeration

## 2. Declarative extension path

- [ ] 2.1 Choose and document the primary end-user registration path (manifest / package metadata field / config entry-point list) and implement loader that only loads explicitly configured or built-in entry points
- [ ] 2.2 Wire config (or install docs) so a synthetic third-party package can register without editing `core/scripts/harness-adapters/*` implementation files
- [ ] 2.3 Add a synthetic extension fixture package (or in-repo fixture path) used by tests that declares both implementer and reviewer roles

## 3. Role resolution and custom-reviewer migration

- [ ] 3.1 Resolve `harnesses.implementer` / `harnesses.reviewer` against the runtime registry + declared role capabilities; reject missing role capability with a message naming adapter and role
- [ ] 3.2 Materialize unregistered custom-reviewer names through a compatibility adapter on the public contract (preserve `review_harness` string/object, `prompt_delivery`, model/effort behavior)
- [ ] 3.3 Ensure a full package registration for the same ID wins over the compatibility adapter
- [ ] 3.4 Narrow or remove the permanent raw-spawn special case in `invoke()` once compatibility adapter golden tests pass
- [ ] 3.5 Add regression tests for existing `review_harness` configs and for extension adapter as implementer and as reviewer

## 4. Consumer migration off hardcoded names

- [ ] 4.1 Update config validation error strings and schema descriptions to list adapters from the runtime registry (include extensions)
- [ ] 4.2 Update doctor assigned-adapter readiness checks to iterate registry + config assignment (not a hardcoded built-in name list)
- [ ] 4.3 Update discovery/help/docs generation paths that enumerate local-CLI adapters to use the registry
- [ ] 4.4 Update eval local-CLI / stage-adapter selection that lists adapters to use the registry (or injectable registry double)
- [ ] 4.5 Replace tests that assert completeness against exactly `{claude,codex,grok,opencode,pi}` with registry-driven assertions plus a separate built-in golden suite

## 5. Identity separation and unknown metadata

- [ ] 5.1 Enforce independent host vs adapter vs provider vs model vs effort fields for extension adapters in treatment/accounting paths
- [ ] 5.2 Ensure unknown provider/model stays unknown/null; add regression that core does not invent a vendor-global model catalog entry or silent default for extension adapters
- [ ] 5.3 Document identity separation for operators (host skill / config reference)

## 6. Shared conformance kit

- [ ] 6.1 Implement shared conformance kit covering: required declarations, supported invocation treatment, unsupported refusal (no silent drop), output normalization, telemetry non-throw/nulls, failure classification vocabulary
- [ ] 6.2 Run built-ins through the kit in CI; keep golden-argv regression for claude/codex (and other established shapes) green
- [ ] 6.3 Run synthetic extension fixture through the kit; prove incomplete fixture fails the kit

## 7. Docs, schema, mirror, and CI gate

- [ ] 7.1 Document end-user extension registration, capability declarations, and custom-reviewer compatibility migration in host skills / config reference
- [ ] 7.2 Update generated config schema/docs if adapter registration or harness role descriptions change
- [ ] 7.3 Regenerate `plugin/` via `node scripts/build.mjs` when `core/` changes; commit mirror with source
- [ ] 7.4 Run `npm run ci` and fix all failures until green
