## Why

The pipeline is single-repo aware: when it plans and implements an issue, it has no
knowledge of other repos that depend on this one or that this one depends on. In
multi-repo setups — shared libraries, microservices, platform/consumer splits — a change
in one repo can silently break or duplicate work in another. Operators have no way to tell
the pipeline "this repo relates to those repos," so planning and roadmap generation stay
blind to in-flight work across repo boundaries. This change lets operators **declare**
inter-repo relationships in `.github/pipeline.yml` so the pipeline can surface relevant
cross-repo context during planning and identify cross-repo dependencies during roadmap
generation.

## What Changes

- Add a new optional `repo_map` config block to `.github/pipeline.yml` with two relationship
  lists: `depends_on` (repos this repo consumes) and `depended_on_by` (repos that consume
  this repo), each a list of `owner/repo` strings. The block is strictly validated: unknown
  sub-keys and malformed `owner/repo` entries are rejected at config-parse time.
- The `pipeline config schema` output (derived from `PartialConfigSchema`) gains the
  `repo_map` schema block with accurate, described types.
- When `repo_map` is configured, the planning stage receives a bounded, **non-blocking**
  supplemental-context summary of the declared repos' open issues (title + label set), so the
  planner can flag cross-repo coordination needs.
- When `pipeline roadmap` runs with `repo_map` configured, the engine identifies cross-repo
  dependencies — local issues whose work relates to a declared repo — and surfaces them in
  both `plan.json` (a `dependency_graph.cross_repo[]` array) and `roadmap.md` (a cross-repo
  section), so a human can sequence work correctly across repo boundaries.
- Missing read access to a declared repo at runtime logs a **named warning** and the run
  continues without that repo's context — it never aborts.
- `pipeline --init` scaffolds the `repo_map` keys (commented out, with inline documentation)
  in the generated `.github/pipeline.yml`.

Per the maintainer-confirmed defaults on the issue's open questions: relationships are
declared **independently in each repo** (no reverse-edge inference, no graph-merge step), and
planning context is sourced from **open issues only** (not recently merged PRs).

## Acceptance Criteria

- [ ] A `repo_map` block is a valid key in `.github/pipeline.yml` and is parsed without error;
      an unknown key within the block causes `resolveConfig()` to throw a strict-schema parse
      error identifying the offending key.
- [ ] `repo_map` accepts `depends_on` and `depended_on_by`, each as a list of `owner/repo`
      strings; a malformed entry that is not `owner/repo`-shaped is rejected at config-parse
      time.
- [ ] `pipeline config schema` output includes a `repo_map` property whose `depends_on` and
      `depended_on_by` sub-properties are typed as arrays of strings and carry descriptions.
- [ ] When `repo_map` is configured, the planning prompt includes a summary of the declared
      repos' open issues (each line is title + label set) as supplemental context.
- [ ] When `repo_map` is absent or empty, the planning prompt is byte-for-byte unchanged from
      current behavior (no extra `gh` calls).
- [ ] When `pipeline roadmap` runs with `repo_map` configured, `plan.json` contains a
      `dependency_graph.cross_repo[]` array identifying local issues related to a declared repo,
      and `roadmap.md` contains a cross-repo dependencies section reflecting those entries.
- [ ] If the pipeline lacks read access to a declared repo at runtime, it logs a named warning
      (e.g. `repo_map: <owner/repo> unreachable — continuing without its context`) and completes
      the run without that repo's context — it does not abort.
- [ ] `pipeline --init` scaffolds the `repo_map` keys commented out with documentation, and the
      scaffolded file still round-trips through `resolveConfig()` to `DEFAULT_CONFIG` for the
      keys present.

## Capabilities

### New Capabilities

- `cross-repo-context`: Declared inter-repo relationships (`repo_map`) feed the planning stage
  a bounded, non-blocking summary of declared repos' open issues, and degrade gracefully (named
  warning, no abort) when a declared repo is unreachable.

### Modified Capabilities

- `pipeline-configuration`: Add the optional strict `repo_map` config block (`depends_on`,
  `depended_on_by`) with `owner/repo` shape validation; its presence is observable in the
  `pipeline config schema` output.
- `init-command`: The scaffolded `.github/pipeline.yml` includes a commented-out, documented
  `repo_map` block.
- `backlog-roadmap-engine`: When `repo_map` is configured, the engine identifies and surfaces
  cross-repo dependencies in `plan.json` and `roadmap.md`.

## Impact

- `core/scripts/config.ts`: add the `repo_map` block to `PartialConfigSchema` (with
  `.describe()` annotations and `.strict()`), and add the scaffold lines in
  `scaffoldDefaultConfig`.
- `core/scripts/types.ts`: add `repo_map` to `PipelineConfig` and `DEFAULT_CONFIG`.
- `core/scripts/stages/planning.ts`: gather and inject the cross-repo supplemental context
  (new, opt-in, non-blocking — mirrors the `last30days` carry-forward seam).
- `core/scripts/prompts/*planning*.md`: add a `{{cross_repo_context}}` placeholder to the
  freeform and OpenSpec planning prompts.
- `core/scripts/roadmap/index.ts` + `core/scripts/stages/roadmap-deps.ts`: thread `repo_map`
  into the depgraph phase and emit `dependency_graph.cross_repo[]`; render the section in
  `roadmap.md`.
- `core/scripts/gh.ts`: reuse the existing `getOpenIssues(repo, opts)` wrapper (already
  repo-parameterized) for declared repos.
- `core/test/`: new tests for config parsing, planning context injection, graceful degradation,
  and roadmap cross-repo emission.
- Out of scope: cross-repo PR orchestration, label/status sync, auto-discovery of edges,
  running the advance loop against multiple repos, and cross-repo CI gating.
- References issue #312.
