## Context

The pipeline resolves one repo's config (`.github/pipeline.yml`) and operates entirely
within that repo: planning reads the issue body + carry-forward + human comments; the roadmap
engine scores and orders that repo's open backlog. There is no representation of inter-repo
relationships. Operators running multi-repo systems (shared lib + consumers, platform +
services) have asked for the pipeline to be aware of related repos so a plan or roadmap does
not ignore in-flight work elsewhere (#312).

Two enabling facts make this cheap to build on existing seams:

- `getOpenIssues(repo, opts)` in `gh.ts` is already **repo-parameterized** (`gh api
  repos/<repo>/issues --paginate`), so fetching a declared repo's open issues needs no new gh
  plumbing.
- Planning already injects optional, non-blocking supplemental context via the `last30days`
  carry-forward seam and the `contextSnapshot` parameter threaded into
  `buildPlanningPrompt` / `buildPlanningOpenspecPrompt`. Cross-repo context follows the same
  shape.

Constraints:
- Strictly additive and opt-in. When `repo_map` is absent or empty, every path is byte-for-byte
  unchanged and makes **no** extra `gh` calls.
- Declaration only — no cross-repo writes, no PR/label/status propagation, no auto-discovery of
  edges, no advance loop across repos, no cross-repo CI gating (all explicit non-goals on #312).
- The never-auto-merge structural floor is untouched.
- Unit tests use injected `Deps` fakes; no real network/git/subprocess in tests.

## Goals / Non-Goals

**Goals:**
- A strictly-validated `repo_map` config block (`depends_on`, `depended_on_by`) with
  `owner/repo` shape checks, surfaced in `pipeline config schema` and scaffolded by `init`.
- Planning receives a bounded, non-blocking summary (title + label set) of declared repos'
  open issues.
- Graceful degradation: an unreachable declared repo logs a named warning and the run
  continues.
- The roadmap engine identifies cross-repo dependencies and surfaces them in `plan.json`
  (`dependency_graph.cross_repo[]`) and `roadmap.md`.

**Non-Goals:**
- Reverse-edge inference across repos (relationships are declared independently per repo).
- Fetching merged/closed PRs for planning context (open issues only).
- Merging another repo's issues into this repo's topological sort (the engine orders only the
  local backlog; cross-repo edges are advisory annotations).
- Any cross-repo write, PR orchestration, label/status sync, auto-discovery, or CI gating.

## Decisions

### Decision 1: Config shape — `repo_map` with two `owner/repo` string lists

**Chosen:**
```yaml
repo_map:
  depends_on:        # repos this repo consumes
    - acme/shared-lib
  depended_on_by:    # repos that consume this repo
    - acme/consumer-app
```
Schema: `z.object({ depends_on: z.array(repoString).optional(), depended_on_by:
z.array(repoString).optional() }).strict().optional()`, where `repoString` is
`z.string().regex(/^[^/\s]+\/[^/\s]+$/)` so a malformed entry fails fast. `DEFAULT_CONFIG`
resolves both lists to `[]`; the resolved `PipelineConfig.repo_map` is always present with
arrays (never undefined), mirroring how other blocks resolve to concrete defaults.

**Rationale:** Two explicit directional lists are the minimal expression of the two
relationship kinds on #312. `owner/repo` shape validation prevents silent downstream failures
— `repo.split("/")` and `repos/${repo}/issues` would 404 quietly on a malformed value
(golden rule: verify external shapes). `.strict()` matches every other feature block and gives
the required "unknown key rejected" behavior for free.

**Alternatives:**
- *Single list of `{repo, direction}` objects*: more flexible but more verbose and an odd fit
  for the two fixed directions; rejected for simplicity.
- *No shape validation*: rejected — a bad entry becomes a confusing runtime 404 far from the
  config error.

### Decision 2: Relationships declared independently per repo (no inference)

**Chosen:** Each repo's `pipeline.yml` is self-contained; the pipeline does not read another
repo's config to infer a reverse edge. This is the maintainer-confirmed default for open
question Q1.

**Rationale:** Inference would require reading and trusting a remote repo's config and a
graph-merge step. Independent declaration keeps config self-contained and avoids a trust/IO
dependency. Drift risk (the two repos disagreeing) is acceptable for human-maintained config,
and the unreachable-repo warning surfaces a repo named in one side that the operator cannot
read.

### Decision 3: Planning context via the existing supplemental-context seam, open issues only

**Chosen:** After config resolves, if `repo_map` has any declared repo, gather the **union**
of `depends_on ∪ depended_on_by` (deduped), fetch each repo's open issues once via
`getOpenIssues`, and render `#<n> <title> [label-a, label-b]` lines into a new
`{{cross_repo_context}}` placeholder in the freeform and OpenSpec planning prompts. Sourced
from **open issues only** (maintainer-confirmed default for Q2). The gather function is
non-blocking and dependency-injected, exactly like `gatherCarryForward` / last30days.

**Rationale:** Reuses a proven seam; keeps the addition out of the hot path when inert. Title +
label set (no body) is enough signal for the planner to flag coordination needs while keeping
the payload bounded. Open-issues-only avoids extra merged-PR API calls and latency.

**Alternatives:**
- *Fold into `contextSnapshot`*: rejected — `contextSnapshot` is human-comment context with its
  own untrusted-boundary handling; a distinct placeholder keeps provenance clear.
- *Include merged PRs*: deferred per Q2 default; can be added later without changing the config
  shape.

### Decision 4: Graceful degradation — named warning, never abort

**Chosen:** Wrap each declared-repo fetch so a thrown `getOpenIssues` (no access, 404,
transient gh failure) logs `[pipeline] #<n>: repo_map: <owner/repo> unreachable — continuing
without its context` and is skipped; other reachable repos still contribute. The same pattern
applies in the roadmap dependency phase. Mirrors the non-blocking posture of last30days.

**Rationale:** A declared repo the operator cannot read (private, renamed, typo) must not break
an otherwise-valid run. A named warning makes the gap visible without failing.

### Decision 5: Roadmap cross-repo edges are advisory annotations, not topo-sort nodes

**Chosen:** The depgraph phase, when `repo_map` is set, fetches declared repos' open issues and
records cross-repo relationships in a new `dependency_graph.cross_repo[]` array
(`{ local_issue, repo, direction, rationale }`). These are rendered as a section in
`roadmap.md`. They are **not** promoted into `must_precede`/`should_precede` and do not enter
the local topological sort.

**Rationale:** The engine scores and orders only this repo's backlog; cross-repo issues are not
in the candidate set, and running the advance loop across repos is an explicit non-goal.
Surfacing the relationship lets a human sequence work correctly across boundaries (the issue's
stated benefit) without overreaching into multi-repo orchestration. Keeping `cross_repo[]`
separate from the existing source-verified edge arrays preserves the "no unverified edge in
`must_precede`" invariant.

## Risks / Trade-offs

- **Cross-repo edge precision (roadmap):** identifying "a local issue relates to a declared
  repo" from issue text is heuristic. Mitigation: edges are advisory annotations with a
  rationale, never topo-sort participants, so a false positive misleads no ordering — it only
  adds a human-reviewed note.
- **Extra latency when configured:** one `getOpenIssues` paginated call per distinct declared
  repo. Mitigation: dedupe the union; only on the configured path; open issues only.
- **Config drift between repos:** independent declaration can disagree. Accepted per Decision 2;
  the unreachable-repo warning surfaces the most common symptom.

## Migration / Rollout

Purely additive and opt-in. No migration: existing repos without `repo_map` see byte-for-byte
unchanged planning and roadmap output and zero extra `gh` calls. `config sync` / `init` add the
commented-out block on next scaffold; existing config files are not clobbered.

## Open Questions

Both open questions on #312 are resolved by maintainer-confirmed defaults:
- Q1 (declare in one repo vs. both) → **independently in each repo** (Decision 2).
- Q2 (open issues only vs. also merged PRs) → **open issues only** (Decision 3).
