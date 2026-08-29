## Context

See proposal.md for motivation. Planning prompts today substitute a closed set of placeholders (`conventions`, issue fields, carry-forward, context snapshot, cross-repo context). None of them is engine-observed repository state. Models therefore derive mutable facts, and they copy triage-time values.

Worktrees already start from fetched `origin/<base_branch>`. The original Alembic failure was not a stale worktree at plan time. The model ignored the worktree. This design injects a fresh observation so derivation is unnecessary, and it binds claims so false verification is visible.

Class vs site: the Alembic head is the site. The class is any mutable repo fact a plan must be correct about. Shared surfaces are the config block, the trusted-base provider runner, prompt injection, the claims artifact, stale-plan invalidation, and the implementing re-derive instruction. Recovery classifiers, recipes, and the durable-loop controller do not change. The next repo with a different fact type declares a provider. It does not need a new mole issue.

## Goals / Non-Goals

**Goals:**

- One collector used by freeform and OpenSpec planning immediately before authoring, plan-review, and plan-revision.
- Trusted-base config and executable bytes, even if the planning worktree rewrites them.
- Argv-only spawn, sanitized env, clean-tree mutation detection.
- Typed claims so prose cannot become engine-verified.
- Default-off: no providers means no spawn and no new prompt section.

**Non-Goals:**

- Built-in Alembic or any other repository-specific parser.
- Using planning-time values as implementation write-time authority.
- Changing review of product code, merge authority, or recovery-ladder classes.
- Dogfooding a provider in this repository's `.github/pipeline.yml` (this repo has no such fact).
- Cross-host locks for observation. Observation is host-local to the managed worktree, same as other worktree work.

## Decisions

### Decision 1 — Config shape is a strict `planning_facts` block

```yaml
planning_facts:
  providers:
    - id: alembic-head
      executable: scripts/pipeline/planning-facts/alembic-head
      args: []
      required: true
      facts:
        alembic_head: string
  timeout_ms: 10000
  max_stdout_bytes: 32768
  max_stderr_bytes: 8192
  max_fact_count: 32
  max_key_chars: 64
  max_value_chars: 1024
  max_prompt_chars: 8192
```

Resolved default is `providers: []`. Ceiling keys are optional. Defaults equal the pipeline-owned hard ceilings below. Schema rejects unknown keys, duplicate provider ids, duplicate fact ids across providers, absolute/`..` executables, empty `facts` maps, and ceiling values above the pipeline maximum.

Allowed fact types: `string`, `number`, `boolean`, `string[]`, `number[]`, `boolean[]`. Arrays cap at 32 items. No nested objects. No `null`.

Alternative considered: auto-detect Alembic. Rejected. Breaks repository neutrality and encodes one site into the engine.

### Decision 2 — Pipeline-owned ceilings

| Ceiling | Pipeline max (and default) |
|---|---|
| runtime | 10_000 ms |
| stdout | 32_768 bytes |
| stderr | 8_192 bytes |
| fact count (all providers combined) | 32 |
| fact key | 64 chars |
| fact value (string or each array item) | 1_024 chars |
| total prompt contribution | 8_192 chars |

Repository config may only set a lower positive integer. Observation enforces `min(repo, pipeline)` for each ceiling. Combined fact count and prompt size are measured after all providers succeed.

Alternative considered: inherit `plan_review_timeout`. Rejected. A hung provider must not consume a 900s review budget.

### Decision 3 — Trusted-base bytes, worktree cwd

Resolve integration-base SHA the same way worktree create does: fetched `origin/<cfg.base_branch>` (or the run's recorded start-point SHA when that is already the trusted base). Read `.github/pipeline.yml` and each `executable` blob from that SHA.

Write trusted executable bytes to a temp file **outside** the planning worktree (engine temp dir). Spawn that absolute path. Cwd is the planning worktree so the script observes current files (`alembic/versions/` in the fixture).

If the worktree `pipeline.yml` or executable digest differs from the trusted blob, ignore the worktree copy. Do not fail solely because the files differ; the attack is substitution, and using trusted bytes already defeats it. Still fail if the trusted blob is missing.

When the trusted integration-base SHA has advanced since this run's previous observation, update the planning worktree onto that SHA before spawn (merge the new base; do not reset away planning commits). Conflict or update failure is typed `planning-facts-provider-contract`. Do not inject the previous bundle.

Alternative considered: run providers against a throwaway checkout of origin/base. Rejected. Locked design requires the managed planning worktree. OpenSpec planning files live there; the observation must see the tree the planner will write into, after the base update.

Alternative considered: `git show SHA:path | sh`. Rejected. No shell, and piping a script is not argv-only.

### Decision 4 — Argv-only spawn and sanitized env

Spawn via an injectable `spawnProvider` / `runCapped` seam: `spawn(absPath, args, { cwd, env, shell: false })`. `args` are the configured string array only.

Child env is constructed, not inherited:

- `PATH=/usr/bin:/bin`
- `LANG=C.UTF-8`
- `LC_ALL=C.UTF-8`
- `TZ=UTC`
- `HOME` and `TMPDIR` set to a dedicated empty temp directory for that spawn
- no other parent variables

A denylist is not sufficient. Tests plant `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `SSH_AUTH_SOCK`, `PIPELINE_*`, and harness API keys on `process.env` and assert they are absent from the spawn env.

### Decision 5 — Clean-tree snapshot and mutation evidence

Before spawn:

1. `git status --porcelain=v1` must be empty (including untracked).
2. Record `HEAD` and `HEAD^{tree}`.

After spawn, compare the same three. Any difference is contract failure. Do not `git reset --hard`, `git checkout --`, or `git clean`. Persist porcelain, diff, stdout/stderr (truncated to ceilings), exit, and duration in the typed diagnostic.

A pre-dirty tree does not spawn.

### Decision 6 — Provider JSON and bundle identity

Stdout must parse as JSON with:

```json
{
  "schema_version": 1,
  "facts": {
    "alembic_head": "0074"
  }
}
```

Unknown `schema_version`, missing `facts`, extra top-level keys, undeclared fact keys, type mismatches, and non-object `facts` are contract failures. Stderr is evidence only.

Value digest: SHA-256 of canonical JSON for that value (`JSON.stringify` of the parsed primitive/array). Fact ID is the config key.

Bundle records:

- `repo_id` — `cfg.repo` (`owner/name`)
- `integration_base_sha`
- `worktree_head_sha` and `worktree_tree_sha`
- `providers_digest` — SHA-256 of trusted executable bytes plus canonical provider config
- `observed_at` — ISO-8601 from an injectable clock
- per-fact: `id`, `value` or `unavailable`, `digest` when present, `provider_id`, `required`

Bundle identity for invalidation is the set of required facts that are not unavailable, each as `(id, digest)`. Observation time is not part of that comparison.

### Decision 7 — Required vs optional

Required failure: do not invoke the model; set blocked with tag `planning-facts-provider-contract`; engine-owned (not `needs-human` by itself). Durable classification, if the item is in a durable run, projects this diagnostic to `workflow-engine-defect`. Do not add a new `DurableBlockerClass` member in this change.

Optional failure: insert `unavailable` records for that provider's declared keys; continue; never copy a previous success.

No cross-invocation cache. Every invocation observes again.

### Decision 8 — Prompt slot and claims artifact

Add `{{planning_facts}}` to `planning.md`, `planning_openspec.md`, `plan_revision.md`, and `plan_review.md`. When there are no facts and no unavailable records, the section is `""` (same pattern as `carryForwardSection`).

When present, the section lists current facts (or unavailable), provenance, and these rules:

- Engine-observed values supersede issue-body, carry-forward, and memory for those keys.
- Do not claim independent verification unless the typed claims artifact matches the current digest.
- Plan-review must treat unmatched prose verification as untrusted.

Claims artifact (planner/reviser stdout), extracted by the engine:

```json
{
  "schema_version": 1,
  "claims": [
    { "fact_id": "alembic_head", "value_digest": "<hex>" }
  ]
}
```

Single-source the schema (same pattern as `review-schema.ts`) and drift-guard it. A matching claim is engine-verified. Missing claims are allowed and mean "no engine-verified facts". Malformed claims fail closed. Persist the extracted artifact next to the plan in the run directory; do not treat GitHub comment prose as the source of truth.

On required-fact identity change before plan-review: skip review, enter revision, inject previous vs current identities plus the current bundle.

### Decision 9 — Implementation re-derivation

`implementing.md` and the OpenSpec implement prompt gain an instruction: immediately before writing a mutable repository fact, re-read current worktree state. Do not inject the planning-time bundle as current. Tests assert the instruction is present and that the Alembic fixture's implement path would fail a regression that writes the planned revision without a fresh directory read (the test is prompt-contract plus a fixture-level implementer fake that records whether it re-read).

### Decision 10 — Module and test seams

New module under `core/scripts/` (name such as `planning-facts.ts`) with a `Deps` seam:

- read trusted blob at SHA
- resolve integration-base SHA
- porcelain / HEAD / tree
- spawn
- clock
- update worktree onto new base

`runPlanningPhases` calls one exported `observePlanningFacts` before each of the three invokes. Unit tests inject fakes. No real network, git, or subprocess in unit tests.

Alembic fixture lives under `core/test/` as a fake worktree layout (`alembic/versions/*.py` with `revision` / `down_revision`) plus a fake provider that lists that directory. Production code does not import the fixture.

Cover at least: no-op config; schema reject; trusted-base vs worktree rewrite; argv/shell; cwd; credential strip; dirty tree; mutation preserved; recompute per invoke; concurrent base advance; stale triage in issue body; required vs optional; malformed/oversized/timeout; claims match/mismatch/prose; invalidation; implementation instruction; freeform/OpenSpec blocker tag equivalence.

### Decision 11 — Diagnostic tag

Tag string: `planning-facts-provider-contract`. Reason prefix includes provider `id` when known, then the failure class (`timeout`, `exit`, `malformed-json`, `undeclared-key`, `type`, `ceiling`, `mutation`, `dirty-worktree`, `missing-executable`, `base-update`, `claims`). Same tag and prefix on freeform and OpenSpec.

## Risks / Trade-offs

- **Provider scripts are repository code running on the factory host.** → Mitigation: trusted-base bytes, argv-only, constructed env, 10s cap, mutation fail-closed, no credentials.
- **A required provider outage blocks planning.** → Mitigation: optional exists; required is explicit; failure is typed and retryable as engine-owned, not a human park.
- **Updating the worktree onto a moved base can conflict with OpenSpec commits.** → Mitigation: fail closed rather than inject stale facts; revision can retry after a clean rematerialize.
- **Models may still write stale numbers in prose.** → Mitigation: claims are the only engine-verified path; plan-review is told to distrust unmatched prose; implementer must re-derive.
- **Prompt size grows with facts.** → Mitigation: 8 KiB total cap; unused repos omit the section.
- **Two hosts advancing the same issue still have no cross-host lock.** → Mitigation: unchanged host-local worktree scope. Duplicate observations are acceptable. Duplicate GitHub artifacts are last-writer-wins, same as today.

## Migration Plan

1. Ship with default empty providers. Repositories that omit the block do not change behavior.
2. Do not add a provider to this repository's `.github/pipeline.yml`.
3. Consumer repositories that need Alembic (or any other fact) add a provider script at the integration-base revision and declare it in `planning_facts`.
4. Rollback is omit the block or empty the list; prompts lose the section and observation does not run.

## Open Questions

None. Ceiling values, JSON envelopes, and the diagnostic tag are chosen above. They can be tuned later without changing the requirement that pipeline owns the max and that prose is not engine-verified.
