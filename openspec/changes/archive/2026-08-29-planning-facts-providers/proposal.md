## Why

Planning prompts currently inject no engine-observed repository state. A plan that must be correct about a mutable fact (the Alembic migration head was the site that exposed this) has to derive it, and it often copies triage-time or issue-body values instead. Six consecutive plans in one `train --merge` wave named the same stale revision; two of them claimed they had verified it. The implementing stage re-derived the number before writing, so no broken migration reached `develop` — but the plan is a reviewed artifact, false verification trains reviewers to skim, and nothing requires the implementer to re-derive.

This is a class gap, not an Alembic mole. The class is: any repo fact a plan must be correct about, that the engine can compute, is derived by a model instead of injected. The next identical fault is a different mutable fact in a different repo. A path-local Alembic special case would not close that class.

## What Changes

- Repositories declare named `planning_facts` providers in `.github/pipeline.yml`. Agent Pipeline stays repository-neutral. Alembic is a test fixture, not built-in engine behavior.
- The engine resolves provider configuration and executable content from the trusted integration-base revision. Planning-worktree edits cannot replace either during the run.
- Providers are argv-only repository scripts. The engine does not invoke a shell and does not resolve the provider executable through `PATH`.
- Providers run in the managed planning worktree with a sanitized environment (no Pipeline, GitHub, signing, or harness credentials). A clean worktree is required. `HEAD` plus porcelain are compared before and after. Mutation is a typed `planning-facts-provider-contract` failure; evidence is preserved.
- Facts are recomputed immediately before every planning, plan-revision, and plan-review invocation. The same current bundle and provenance go to all three.
- Each bundle is bound to repository identity, integration-base SHA, planning-worktree state identity, provider content digest, and observation time.
- Providers return bounded versioned JSON. Trusted configuration declares allowed fact keys and primitive or array types. Undeclared fields and nested objects are rejected.
- The pipeline owns hard ceilings (runtime, stdout, stderr, fact count, key/value size, total prompt contribution). Repository configuration may only tighten them.
- Each provider is required or optional. Required failure blocks before the model runs, with typed evidence. Optional failure emits an explicit unavailable record. Old values are never silently reused.
- Planner output includes a typed fact-claims artifact. An engine-verified claim MUST reference a supplied fact ID and value digest. Prose alone cannot become an engine-verified fact.
- If a required fact changes before plan review, the stale plan is invalidated and returned for revision with the previous and current fact identities.
- Planning facts do not replace implementation-time validation. Implementers still re-derive mutable repository state immediately before writing.

No **BREAKING** change for repositories that omit `planning_facts`. Absent or empty providers leave current planning behavior in place.

## Capabilities

### New Capabilities

- `planning-facts`: Engine-owned observation, binding, injection, claim verification, stale-plan invalidation, and implementation-time revalidation of repository-declared planning facts. Alembic is a conformance fixture only.

### Modified Capabilities

- `pipeline-configuration`: Accept a `planning_facts` block that names providers, allowed fact keys and types, required/optional, and optional tighter ceilings. Unknown keys fail strict schema validation. Absent block equals no providers.
- `unified-planning-phase-runner`: Recompute and inject facts immediately before planning, plan-revision, and plan-review on both freeform and OpenSpec paths. The new provider-contract failure mode uses the same blocker tag and reason prefix on both paths.

## Impact

- **Config:** `core/scripts/config.ts` and `core/scripts/types.ts` gain `planning_facts`. Schema `.describe()` text feeds generated `docs/config.md`. Init/sync scaffold documents the block as empty by default.
- **Planning lifecycle:** A shared collector runs inside `runPlanningPhases` immediately before each of the three model invocations. Freeform and OpenSpec hooks share it.
- **Prompts:** `planning.md`, `planning_openspec.md`, `plan_revision.md`, and `plan_review.md` gain a `{{planning_facts}}` slot. `implementing.md` (and the OpenSpec implement path) instruct re-derivation of mutable facts at write time.
- **Security:** Trusted-base executable bytes; argv-only spawn; sanitized env; mutation detection; no credential inheritance.
- **Tests:** Injected spawn, git, config, and prompt-builder fakes. Alembic is a repository fixture. No real network. Coverage listed in acceptance criteria.
- **Packaging:** After any `core/` edit, `node scripts/build.mjs` regenerates `plugin/` in the same commit.

## Acceptance criteria

- [ ] A repository with no `planning_facts` block, or with an empty providers list, keeps current planning, plan-revision, and plan-review prompts (no fact section, no provider spawn, no new model-blocking failure).
- [ ] `.github/pipeline.yml` accepts a `planning_facts` providers list. Each provider has an id, a repo-relative executable, optional argv, required/optional, and a map of allowed fact keys to primitive or array types. Unknown keys fail strict schema validation.
- [ ] Agent Pipeline has no built-in Alembic or migration-head logic. An Alembic-style provider is a test fixture driven only by repository config plus a repository script.
- [ ] Provider configuration and executable bytes come from the trusted integration-base revision. A planning-worktree rewrite of `.github/pipeline.yml` or of the provider script does not change what the run executes.
- [ ] The engine spawns the trusted executable by absolute path with an argv array. It does not use a shell and does not look up the executable on `PATH`.
- [ ] Providers run with cwd equal to the managed planning worktree. The child environment does not contain Pipeline, GitHub, signing, or harness credentials. A test that plants those variables in the parent env proves they are absent from the child.
- [ ] The engine refuses to run a provider against a dirty worktree. After a successful run, `HEAD` and porcelain match the pre-run snapshot. A mutating provider fails as typed `planning-facts-provider-contract`, leaves the dirt in place, and does not silently reset it.
- [ ] Facts are recomputed immediately before planning, plan-revision, and plan-review. All three prompts receive the same current bundle and provenance for that invocation.
- [ ] Each bundle records repository identity, integration-base SHA, planning-worktree state identity, provider content digest, and observation time.
- [ ] Provider stdout is bounded versioned JSON. Undeclared keys, nested objects, oversized output, too many facts, and values that fail the declared primitive/array type are rejected. Pipeline ceilings apply; repository config may only lower them.
- [ ] A required provider failure (timeout, non-zero exit, malformed JSON, mutation, ceiling breach, missing executable) blocks before the model is invoked and records typed evidence. An optional provider failure records an explicit unavailable fact and continues. Neither case reuses a previous successful value.
- [ ] A planner claim is engine-verified only when it names a supplied fact ID and the current value digest. Prose such as "Alembic head verified at 0068" is not engine-verified. Plan-review is told to treat unmatched prose verification as untrusted.
- [ ] When a required fact's identity (id + value digest) differs between the plan's bound bundle and the bundle computed immediately before plan-review, the engine does not send the stale plan to review. It returns the plan for revision and supplies previous and current fact identities.
- [ ] The implementing prompt still instructs the implementer to re-derive mutable repository state immediately before writing. Injected planning facts are not treated as write-time source of truth.
- [ ] Unit tests with injected I/O cover: Alembic fixture; stale triage-time values in the issue body; concurrent integration-base advancement; plan revision; false verification prose; required and optional failures; malformed and oversized output; timeout; provider mutation; credential stripping; candidate replacement of provider code or config; implementation-time revalidation instruction.
- [ ] Generated plugin files and config docs stay in sync. `node scripts/build.mjs --check` and `npm run ci` pass.
