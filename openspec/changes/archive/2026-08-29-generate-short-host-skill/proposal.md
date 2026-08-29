## Why

`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and `hosts/opencode/SKILL.md` are 70–87KB orchestration essays. They drift from `OPERATION_SURFACE`, from each other, and from `docs/cli.md`. The product is the `pipeline` CLI plus a short host SKILL. #1047 locked that contract in docs. #1048 stopped generating per-verb slash and yaml command files. This slice generates the short SKILL and deletes the essays.

## What Changes

- Add `core/scripts/host-skill.ts` as the single deep rendering module. Its only public rendering seam, `renderHostSkill(options?)`, owns the one-pager while deriving the compact notify rows from injected manifests in tests or the existing outer-host loader by default. One exported issue-locked `SKILL_HOST_IDS` tuple (`claude`, `codex`, `grok`, `opencode`) owns host membership and target derivation; it contains no notify values or behavior dispatch.
- Generate one short, host-neutral SKILL per in-repo host that receives a SKILL: Claude, Codex, Grok, and OpenCode. Each committed file SHALL contain the same `OPERATION_SURFACE` verb table, shared host notify map, follow/notify contract, and durable links to `docs/packaging.md` and `docs/cli.md`.
- Make `scripts/build.mjs` the sole writer and freshness checker for all four host SKILLs and the transitional plugin SKILL. `core/scripts/docs-generate.ts` and `scripts/generate-docs.mjs` SHALL stop reading, rewriting, or requiring any host SKILL, including OMP.
- Put `train` and `ship` on `OPERATION_SURFACE` as explicit merge-capable verbs. The follow contract never escalates into them. They remain operator-authorized CLI verbs.
- Delete the handwritten 70–87KB host SKILL essays, including `hosts/omp/SKILL.md`. Tugboat/OMP SHALL NOT receive a SKILL. No Eve/Foreman host.
- Keep Grok's existing `symlink-claude` outer-host install lifecycle. Commit `hosts/grok/SKILL.md` as a generated conformance output, byte-identical to the generated Claude one-pager, so the installed Grok symlink consumes the same bytes without an install-mode change.
- Expose the shared one-pager source so #971 can consume it for the host-neutral supervisor pack. Do not add Hermes/OpenClaw install logic here.
- Tests SHALL prove generated SKILL bytes match committed output, rendered notify rows match the manifests, hosts share the same stage-free contract, generated-output accounting includes all four files, and the generator does not emit slash-command or yaml-agent packs.

**Not breaking** for the CLI verb surface, stage machine, install of the CLI tree, or merge authority.

## Capabilities

### New Capabilities

- `generated-short-host-skill`: Generate four byte-identical short host SKILLs through the small `renderHostSkill(options?)` interface from `OPERATION_SURFACE` and manifest-derived notify data. Derive the exact build targets from the issue-locked `SKILL_HOST_IDS` tuple. Delete the handwritten essays. Do not generate command files. Expose that rendering interface for #971.

### Modified Capabilities

- `generated-cli-reference`: Host SKILL tables SHALL come from `OPERATION_SURFACE` for Claude, Codex, Grok, and OpenCode. They SHALL NOT rewrite `hosts/omp/SKILL.md`. `docs/cli.md` remains the full documented CLI inventory.
- `grok-skill-path`: The repository SHALL contain generated `hosts/grok/SKILL.md`, but it is not a divergent fork or a new install overlay. Grok SHALL keep consuming the byte-identical shared one-pager through the existing Claude-managed symlink.
- `omp-host-install`: OMP/Tugboat install SHALL NOT require or write a host SKILL.md overlay.
- `stage-inventory-ssot`: Full stage inventory SHALL live in docs / living specs, not in the generated SKILL body.
- `native-goal-bootstrap`: Native `/goal` bootstrap essay SHALL leave the SKILL. Docs MAY keep the two-step sequence. The short SKILL SHALL NOT restate it.
- `pipeline-loop-facade`: Full selector and tutorial detail SHALL move to durable docs; the generated one-pager keeps the compact loop verb row and follow contract.
- `advance-skill-orchestration`: The ordered follow/re-attach/stop/summary contract SHALL live in the shared orchestration source. The generated SKILL SHALL carry the short form, not the 80KB bash essay.
- `loop-skill-orchestration`: Same shared-contract retarget for `pipeline loop` drive/resume.
- `host-neutral-progress-notify`: One compact notify table SHALL be rendered from outer-host manifests and appear unchanged in every generated SKILL. The installed host selects its row; the renderer does not fork prose per host or own a second notify map.
- `monitor-filter-guidance`: Primary loop follow SHALL be `pipeline loop logs <run-id> --events --follow` plus the shared material filter. The old issue-scoped stdout grep SHALL NOT be the SKILL follow contract.
- `core-mirror-sync`: Contributor `build.mjs` freshness instruction SHALL remain in `AGENTS.md` / `CLAUDE.md`. The pre-commit hook SHALL stage all four generated host SKILLs plus the plugin/catalog outputs. The generated SKILL SHALL NOT be required to repeat that essay.
- `cli-host-provision`: Build freshness SHALL cover the four generated host SKILLs rather than treating only `hosts/claude/SKILL.md` as the host source.
- `pre-commit-mirror-regen`: Pre-commit regeneration SHALL stage the four exact host SKILL outputs plus the plugin/catalog outputs without broad staging.
- `eval-fixture-contract`: Eval packaging boundaries SHALL recognize the four exact host SKILL outputs as generated artifacts.
- `eval-fixture-preflight`: Eval preflight SHALL require the host SKILL outputs when an allowed renderer, operation-surface, build, or manifest input can change them.
- `release-sub-command`: Release-plan row tutorials SHALL move from host essays to CLI help and durable docs.
- `human-curated-lessons-convention`: Lessons workflow tutorials SHALL move from host essays to README/durable docs.
- `cli-harness-adapters`: Five-adapter login and YAML setup tutorials SHALL move from host essays to durable docs.
- `engine-artifact-ignore-contract`: The complete artifact-path inventory SHALL move from host essays to durable docs.
- `installed-engine-freshness`: Engine update tutorials SHALL move from host essays to README/durable docs.
- `readme-user-clarity`: README SHALL distinguish the generated byte-identical Grok conformance output from the unchanged `symlink-claude` install path.

## Acceptance criteria

- [ ] `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` exist and are generated from one shared source plus `OPERATION_SURFACE`; their exact target paths are derived from `SKILL_HOST_IDS`, and a drift test binds tuple membership to target membership.
- [ ] Each of those four files contains the default numeric `pipeline <N>` drive, an `OPERATION_SURFACE` verb table, and a follow/notify contract that distinguishes `pipeline logs <advance-run-id> --events --follow` from `pipeline loop logs <loop-run-id> --events --follow`, with reattach and stop-on-terminal rules plus durable repository links to `docs/packaging.md` and `docs/cli.md` that still work from an installed skill tree.
- [ ] `OPERATION_SURFACE` includes `train` and `ship` as explicit verbs. Generated SKILL tables list them.
- [ ] The follow/notify contract states that the follower/observer never invokes a merge-capable command (`merge`, `merge-queue --apply`, `train --merge`, `ship`).
- [ ] Compact policy text preserves the living authority boundary: ordinary advance/loop is autonomous through `pipeline:ready-to-deploy` and never merges or deploys; per-PR merge, merge-queue apply (dry-run by default), train merge, and milestone ship are explicit operator-authorized surfaces; `Ship milestone vX.Y.Z` maps to `pipeline ship --milestone vX.Y.Z`.
- [ ] The four generated SKILL files do not contain the deleted engine-essay sections (state-machine walkthrough, per-repo config dump, evals manifesto, §4/§4b/§4c bash discovery scripts).
- [ ] The four generated SKILL files are byte-identical and contain no host-specific stage-machine logic. Every host executes the CLI as `pipeline <verb>`; the shared host notify table carries the compact surface differences.
- [ ] Notify rows in the generated one-pager are derived from `material_progress_notify.mapping` in the Claude, Codex, Grok, and OpenCode outer-host manifests. Defaults load through `loadOuterHostManifestsPreferHosts()`; tests inject manifests through `renderHostSkill(options?)`; missing or duplicate selected IDs fail closed. `host-skill.ts` does not hardcode a parallel host/surface/tool map, and parity tests fail on manifest/render or host-set/target drift.
- [ ] `hosts/omp/SKILL.md` is absent. No Eve/Foreman host SKILL is added.
- [ ] Both OMP manifest copies (`hosts/omp/outer-host.manifest.json` and `core/scripts/outer-hosts/builtins/omp.json`) remain byte-identical and declare `install.overlayFiles: []`.
- [ ] `scripts/build.mjs` and install do not emit `/pipeline:*` markdown command files or Codex `$pipeline:*` yaml agents.
- [ ] `scripts/build.mjs` is the sole writer/checker for the four host SKILLs and calls `renderHostSkill` directly for the plugin SKILL. The docs generator neither reads nor writes a SKILL and does not require `hosts/omp/SKILL.md`.
- [ ] `.githooks/pre-commit`, its staging tests, and eval generated-output accounting include all four host SKILL outputs without broadly staging unrelated `hosts/` or `plugin/` dirt. The hook treats the exact four repository outer-host manifests as generator inputs for triggering and unstaged/untracked guards.
- [ ] A unit test fails when a committed generated SKILL differs from a fresh generation.
- [ ] A unit test fails when the generator or install path writes a per-verb command file.
- [ ] `core/scripts/host-skill.ts` exports `renderHostSkill(options?)` so #971 can render the same one-pager without copying a host essay. Its optional `operationSurface` and `manifests` inputs support deterministic in-process tests without exposing rendering fragments. This change does not add Hermes/OpenClaw install logic.
- [ ] `npm run ci` is green.

## Impact

- **Hosts:** replace handwritten SKILL essays with generated one-pagers; add `hosts/grok/SKILL.md`; delete `hosts/omp/SKILL.md`.
- **Catalog:** `OPERATION_SURFACE` gains `train` and `ship`.
- **Generator:** `core/scripts/host-skill.ts` renders the whole one-pager from `OPERATION_SURFACE` and outer-host manifest notify mappings. `SKILL_HOST_IDS` owns the exact four-host membership, and `scripts/build.mjs` derives target paths from it. `scripts/build.mjs` is the only SKILL writer and calls the renderer directly for the four host outputs and transitional plugin output. `core/scripts/docs-generate.ts` / `scripts/generate-docs.mjs` drop all SKILL inputs, outputs, marker rewrites, and OMP existence checks.
- **Install:** Grok remains `symlink-claude`; because the generated Grok and Claude files are byte-identical, the symlink exposes the required one-pager without a lifecycle change. OMP overlay does not include SKILL.md.
- **Docs:** `README.md` and `docs/packaging.md` document the generated Grok repository conformance file while preserving the existing Claude-managed symlink install and update instructions. Generated SKILL doc pointers use absolute GitHub URLs.
- **Plugin overlay:** The shared renderer directly feeds the transitional `plugin/` SKILL overlay until #1050; plugin generation does not read a generated host file.
- **Tests:** new generation/freshness, manifest/render parity, pre-commit staging, eval-boundary, and no-command-file guards; retarget or drop SKILL-essay drift guards (stage inventory, `/goal` bootstrap, grep Monitor).
- **Out of scope:** MCP (#907), MessagingPort (#966), engine or outer-host install lifecycle, Hermes/OpenClaw install packs (#969/#970/#971), `plugin/` deletion (#1050).
- **Parent:** #1046. **Depends on:** closed #1047 (PR #1304) and #1048 (PR #1222). Program: v1.39.17.
