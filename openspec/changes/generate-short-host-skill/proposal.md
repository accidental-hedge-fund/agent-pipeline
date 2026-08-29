## Why

`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and `hosts/opencode/SKILL.md` are 70–87KB orchestration essays. They drift from `OPERATION_SURFACE`, from each other, and from `docs/cli.md`. The product is the `pipeline` CLI plus a short host SKILL. #1047 locked that contract in docs. #1048 stopped generating per-verb slash and yaml command files. This slice generates the short SKILL and deletes the essays.

## What Changes

- Add one shared orchestration-contract source (module or doc) that states the follow/notify rules: capture `run_id`, follow `pipeline loop logs --events --follow` (or the equivalent `pipeline logs` path), stop on terminal, and never let the follower invoke a merge-capable command.
- Generate one short SKILL per in-repo host that receives a SKILL: Claude, Codex, Grok, and OpenCode. Each SKILL SHALL contain the `OPERATION_SURFACE` verb table, that follow/notify contract, and pointers to `docs/packaging.md` and `docs/cli.md`.
- Put `train` and `ship` on `OPERATION_SURFACE` as explicit merge-capable verbs. The follow contract never escalates into them. They remain operator-authorized CLI verbs.
- Delete the handwritten 70–87KB host SKILL essays, including `hosts/omp/SKILL.md`. Tugboat/OMP SHALL NOT receive a SKILL. No Eve/Foreman host.
- Stop treating Grok as a Claude-SKILL symlink consumer for skill text. Grok SHALL get the same generated one-pager with its host invocation token.
- Expose the shared one-pager source so #971 can consume it for the host-neutral supervisor pack. Do not add Hermes/OpenClaw install logic here.
- Tests SHALL prove generated SKILL bytes match committed output, hosts share the same stage-free contract, and the generator does not emit slash-command or yaml-agent packs.

**Not breaking** for the CLI verb surface, stage machine, install of the CLI tree, or merge authority.

## Capabilities

### New Capabilities

- `generated-short-host-skill`: Generate four short host SKILLs from `OPERATION_SURFACE` plus one shared follow/notify contract. Delete the handwritten essays. Do not generate command files. Expose the one-pager source for #971.

### Modified Capabilities

- `generated-cli-reference`: Host SKILL tables SHALL come from `OPERATION_SURFACE` for Claude, Codex, Grok, and OpenCode. They SHALL NOT rewrite `hosts/omp/SKILL.md`. `docs/cli.md` remains the full documented CLI inventory.
- `grok-skill-path`: Grok SHALL receive a generated `hosts/grok/SKILL.md` from the shared one-pager. The “no Grok SKILL fork” rule SHALL end for this overlay.
- `omp-host-install`: OMP/Tugboat install SHALL NOT require or write a host SKILL.md overlay.
- `stage-inventory-ssot`: Full stage inventory SHALL live in docs / living specs, not in the generated SKILL body.
- `native-goal-bootstrap`: Native `/goal` bootstrap essay SHALL leave the SKILL. Docs MAY keep the two-step sequence. The short SKILL SHALL NOT restate it.
- `advance-skill-orchestration`: The ordered follow/re-attach/stop/summary contract SHALL live in the shared orchestration source. The generated SKILL SHALL carry the short form, not the 80KB bash essay.
- `loop-skill-orchestration`: Same shared-contract retarget for `pipeline loop` drive/resume.
- `host-neutral-progress-notify`: Host notify map SHALL live in the shared contract. Generated SKILLs MAY substitute only host notify tool names.
- `monitor-filter-guidance`: Primary follow SHALL be `pipeline logs` / `pipeline loop logs --events --follow` plus the shared material filter. The old issue-scoped stdout grep SHALL NOT be the SKILL follow contract.
- `core-mirror-sync`: Contributor `build.mjs` freshness instruction SHALL remain in `AGENTS.md` / `CLAUDE.md`. The generated SKILL SHALL NOT be required to repeat that essay.

## Acceptance criteria

- [ ] `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` exist and are generated from one shared source plus `OPERATION_SURFACE`.
- [ ] Each of those four files contains an `OPERATION_SURFACE` verb table, a follow/notify contract that names `run_id` and `pipeline loop logs --events --follow` (or the equivalent logs follow) and stop-on-terminal, and working pointers to `docs/packaging.md` and `docs/cli.md`.
- [ ] `OPERATION_SURFACE` includes `train` and `ship` as explicit verbs. Generated SKILL tables list them.
- [ ] The follow/notify contract states that the follower/observer never invokes a merge-capable command (`merge`, `merge-queue --apply`, `train --merge`, `ship`).
- [ ] The four generated SKILL files do not contain the deleted engine-essay sections (state-machine walkthrough, per-repo config dump, evals manifesto, §4/§4b/§4c bash discovery scripts).
- [ ] The four generated SKILL files contain no host-specific stage-machine logic. Hosts differ only by invocation token and notify-tool names.
- [ ] `hosts/omp/SKILL.md` is absent. No Eve/Foreman host SKILL is added.
- [ ] `scripts/build.mjs` and install do not emit `/pipeline:*` markdown command files or Codex `$pipeline:*` yaml agents.
- [ ] A unit test fails when a committed generated SKILL differs from a fresh generation.
- [ ] A unit test fails when the generator or install path writes a per-verb command file.
- [ ] The shared one-pager source is a committed module or doc that #971 can import without copying a host essay. This change does not add Hermes/OpenClaw install logic.
- [ ] `npm run ci` is green.

## Impact

- **Hosts:** replace handwritten SKILL essays with generated one-pagers; add `hosts/grok/SKILL.md`; delete `hosts/omp/SKILL.md`.
- **Catalog:** `OPERATION_SURFACE` gains `train` and `ship`.
- **Generator:** `scripts/build.mjs` / `core/scripts/docs-generate.ts` (or a sibling) emit whole short SKILLs, not a marked table region inside an 80KB essay.
- **Install:** Grok overlay includes the generated SKILL. OMP overlay does not include SKILL.md.
- **Plugin overlay:** Claude generated SKILL still feeds the transitional `plugin/` SKILL overlay until #1050.
- **Tests:** new generation/freshness and no-command-file guards; retarget or drop SKILL-essay drift guards (stage inventory, `/goal` bootstrap, grep Monitor).
- **Out of scope:** MCP (#907), MessagingPort (#966), engine lifecycle, Hermes/OpenClaw install packs (#969/#970/#971), `plugin/` deletion (#1050).
- **Parent:** #1046. **Depends on:** closed #1047 (PR #1304) and #1048 (PR #1222). Program: v1.39.17.
