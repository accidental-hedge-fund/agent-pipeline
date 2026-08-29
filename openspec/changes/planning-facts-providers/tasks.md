## 1. Config and types

- [x] 1.1 Add `planning_facts` to `PipelineConfig`, `DEFAULT_CONFIG` (empty `providers`, pipeline-owned ceiling defaults from design.md), and `PartialConfigSchema` with `.describe()` on every key, and verify a unit test accepts a valid provider, defaults an absent block to empty providers, and rejects unknown keys, absolute/`..` executables, empty `facts`, duplicate provider ids, duplicate fact ids, and a ceiling above the pipeline max
- [x] 1.2 Restrict `facts` value types to `string`, `number`, `boolean`, `string[]`, `number[]`, `boolean[]`, and verify a unit test rejects `object`, `null`, and unknown type names
- [x] 1.3 Document `planning_facts` in the init/sync scaffold as empty-by-default and verify a freshly scaffolded file round-trips through `resolveConfig()` with zero providers

## 2. Observation module

- [x] 2.1 Add `planning-facts.ts` with an injectable `Deps` seam (trusted blob at SHA, integration-base SHA, porcelain/HEAD/tree, spawn, clock, worktree base update) and verify no unit test performs real network, git, or subprocess I/O
- [x] 2.2 Resolve provider config and executable bytes from the trusted integration-base SHA, write those bytes to a temp path outside the planning worktree, and verify a worktree rewrite of `.github/pipeline.yml` or of the provider script does not change the spawned file bytes or the provider list
- [x] 2.3 Spawn the trusted absolute path with `shell: false` and configured argv only, cwd = managed planning worktree, constructed env (`PATH=/usr/bin:/bin`, `LANG`/`LC_ALL`/`TZ`, dedicated `HOME`/`TMPDIR`), and verify a test that plants `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `PIPELINE_*`, and harness API keys on the parent env observes them absent from the child env
- [x] 2.4 Refuse to spawn when porcelain is non-empty; after spawn compare HEAD, tree, and porcelain; on mutation record typed `planning-facts-provider-contract` without reset/clean; and verify a mutating fake leaves dirt in place
- [x] 2.5 Parse versioned `{ schema_version: 1, facts }` JSON, reject undeclared keys, nested objects, type mismatches, extra top-level keys, timeout, non-zero exit, missing trusted executable, and ceiling breaches, and verify each case returns tag `planning-facts-provider-contract` with the design.md reason prefix
- [x] 2.6 Apply `min(repo, pipeline)` ceilings and verify a repo-lowered timeout fails between the repo value and the pipeline max, and that a repo value above the max is already rejected at config parse (1.1)
- [x] 2.7 Bind each bundle to `repo_id`, integration-base SHA, worktree HEAD/tree, providers digest, and `observed_at`, and verify two bundles that differ only in `observed_at` do not count as a required-fact change
- [x] 2.8 Treat required provider failure as a block-before-model outcome and optional failure as `unavailable` records with no reuse of a prior success, and verify both with injected fakes

## 3. Prompts and claims

- [x] 3.1 Single-source the claims JSON schema and inject it into planning, plan-revision, and plan-review templates, and verify a drift-guard test fails if the prompt schema block diverges
- [x] 3.2 Add `{{planning_facts}}` to `planning.md`, `planning_openspec.md`, `plan_revision.md`, and `plan_review.md`, render empty when there are no facts and no unavailable records, and verify prompt-builder tests for the omitted-block case stay section-free
- [x] 3.3 Render current values, unavailable records, and provenance plus the rules that observed facts supersede triage/memory and that unmatched prose is not engine-verified, and verify a stale-triage issue body still appears in the body slot while the facts section shows the fixture head
- [x] 3.4 Extract the claims artifact from planner/reviser stdout, persist it in the run directory, mark a claim engine-verified only on id+digest match, treat missing claims as none-verified, fail closed on malformed claims, and verify false prose "head verified at 0068" against fixture head `0074` is not engine-verified
- [x] 3.5 Update `implementing.md` (and the OpenSpec implement prompt) to require re-derivation of mutable repository state immediately before writing, do not inject the planning-time bundle as current, and verify a prompt-contract test fails if that instruction is removed

## 4. Planning phase runner

- [x] 4.1 Call `observePlanningFacts` from `runPlanningPhases` immediately before authoring, plan-review, and plan-revision on both freeform and OpenSpec paths, and verify a fake counter records three distinct observations across those steps
- [x] 4.2 Skip the matching harness invoke on required-provider failure, and verify both freeform and OpenSpec fakes record tag `planning-facts-provider-contract`, the same reason prefix, and zero harness calls for that step
- [x] 4.3 Immediately before plan-review, compare required fact identities to the plan's bound bundle; on add/remove/digest change skip review, enter revision, and inject previous vs current identities; and verify an Alembic fixture that advanced `0068` → `0074` never invokes plan-review on the stale plan
- [x] 4.4 When the trusted integration-base SHA advanced since the previous observation, update the planning worktree onto that base before spawn; on update failure do not inject the previous bundle; and verify a concurrent-base-advancement fake observes the new head
- [x] 4.5 Leave optional-only fact changes as non-invalidating, and verify plan-review still runs when every required identity is unchanged

## 5. Alembic fixture and locked-design regressions

- [x] 5.1 Add a repository fixture under `core/test/` with `alembic/versions/` files and a config-declared provider script fake, and verify production code does not import or hard-code Alembic
- [x] 5.2 Cover stale triage-time `0069`/`0068` in the issue body against fixture head `0074`, and verify the injected fact is `0074`
- [x] 5.3 Cover false verification prose that claims `ls alembic/versions` terminated at `0068` while the fixture contains later revisions, and verify the claim is not engine-verified and plan-review receives `0074`
- [x] 5.4 Cover plan revision after required-fact invalidation, and verify the revision prompt contains previous and current identities plus the current bundle
- [x] 5.5 Cover implementation-time revalidation: an implementer fake that would write the planned next revision without a fresh versions-directory read fails the regression; with a fresh read it writes the current next revision

## 6. Docs and packaging

- [x] 6.1 Regenerate `docs/config.md` from the schema after `planning_facts` descriptions land, and verify the docs freshness check is green
- [x] 6.2 After any `core/` edit, run `node scripts/build.mjs` and commit the regenerated `plugin/` in the same change, and verify `node scripts/build.mjs --check` passes
- [x] 6.3 Run `npm run ci` from the repo root and verify it passes, including `openspec validate --all`
