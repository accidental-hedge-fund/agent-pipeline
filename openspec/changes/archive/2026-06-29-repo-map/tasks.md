## 1. Config schema and defaults

- [ ] 1.1 Add the optional strict `repo_map` block to `PartialConfigSchema` in
      `core/scripts/config.ts`: `depends_on` and `depended_on_by`, each an
      `z.array(repoString).optional()` where `repoString` validates the `owner/repo` shape
      (`/^[^/\s]+\/[^/\s]+$/`); annotate both fields and the block with `.describe()` and mark
      the block `.strict()`.
- [ ] 1.2 Add `repo_map: { depends_on: string[]; depended_on_by: string[] }` to
      `PipelineConfig` and `DEFAULT_CONFIG` (both lists `[]`) in `core/scripts/types.ts`; ensure
      `resolveConfig()` always resolves `repo_map` to concrete arrays.
- [ ] 1.3 Add config-parsing tests in `core/test/`: valid block resolves; absent block defaults
      to empty lists; unknown sub-key rejected; malformed `owner/repo` entry rejected; a repo
      listed in both lists is preserved. Prove each test bites without the schema change.

## 2. config schema observability

- [ ] 2.1 Confirm `pipeline config schema` emits `repo_map` with `depends_on` /
      `depended_on_by` as array-of-string sub-properties carrying descriptions (follows from the
      `.describe()` annotations; no separate codegen step).
- [ ] 2.2 Add a test asserting the generated JSON Schema contains the `repo_map` property with
      typed, described sub-properties and that `repo_map` is not in the top-level `required`.

## 3. Init / config-sync scaffold

- [ ] 3.1 Add a commented-out, documented `repo_map` block to `scaffoldDefaultConfig` in
      `core/scripts/config.ts` (document `depends_on`, `depended_on_by`, the `owner/repo` entry
      format, and that the relationship is declared independently per repo).
- [ ] 3.2 Extend the init scaffold test to assert the block is present (commented) and that the
      scaffolded file round-trips through `resolveConfig()` with `repo_map` equal to the default
      empty lists.

## 4. Planning supplemental context

- [ ] 4.1 Add a `{{cross_repo_context}}` placeholder to the freeform and OpenSpec planning
      prompt templates in `core/scripts/prompts/`.
- [ ] 4.2 Implement a non-blocking, dependency-injected `gatherCrossRepoContext(cfg, deps)` in
      `core/scripts/stages/planning.ts` (mirroring the last30days carry-forward seam): dedupe
      `depends_on ∪ depended_on_by`, fetch each repo's open issues once via `getOpenIssues`, and
      render `#<n> <title> [labels]` lines (title + label set only, no body).
- [ ] 4.3 Wire the rendered context into `buildPlanningPrompt` and `buildPlanningOpenspecPrompt`
      via the new placeholder; render empty when `repo_map` is absent/empty (no `gh` call on the
      inert path).
- [ ] 4.4 Implement graceful degradation: a thrown `getOpenIssues` for a declared repo logs a
      named warning identifying that `owner/repo` and is skipped; reachable repos still
      contribute; the run never aborts.
- [ ] 4.5 Tests (injected fakes): declared repos summarized (title + labels, no body); both
      directions contribute; a repo in both lists fetched once; absent/empty `repo_map` makes no
      fetch and leaves the prompt unchanged; one unreachable repo warns and the run continues
      while other repos still contribute.

## 5. Roadmap cross-repo dependencies

- [ ] 5.1 Thread `repo_map` into the roadmap engine: extend the depgraph phase (and
      `roadmap-deps.ts` production wiring) to fetch declared repos' open issues via the injected
      `getOpenIssues` dep.
- [ ] 5.2 Identify cross-repo dependencies (local issue references a declared repo / its open
      issue, or the declared direction implies a sequencing hint) and record them in
      `plan.json.dependency_graph.cross_repo[]` as `{ local_issue, repo, direction, rationale }`;
      do NOT promote them into `must_precede`/`should_precede` or the local topo-sort.
- [ ] 5.3 Render a cross-repo dependencies section in `roadmap.md` when `cross_repo[]` is
      non-empty (local issue, declared `owner/repo`, direction, rationale); omit when empty.
- [ ] 5.4 Apply the same graceful-degradation warning for unreachable declared repos in the
      dependency phase.
- [ ] 5.5 Tests (injected fakes): cross-repo edge recorded in `plan.json`; cross-repo edges
      excluded from `must_precede`/local ordering; absent `repo_map` yields empty `cross_repo[]`
      and unchanged output; `roadmap.md` section rendered when entries exist and omitted when
      empty; unreachable declared repo warns and the plan still finalizes.

## 6. Build and CI

- [ ] 6.1 Regenerate the plugin mirror: `node scripts/build.mjs`, and commit the regenerated
      `plugin/` alongside the `core/` changes.
- [ ] 6.2 Run `npm run ci` from the repo root — confirm core tests pass, the mirror is in sync,
      and the install smoke test passes.
