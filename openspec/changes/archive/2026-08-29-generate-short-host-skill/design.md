## Context

See `proposal.md` for why. Today:

- `hosts/claude/SKILL.md` is 87KB, `hosts/codex/SKILL.md` is 76KB, `hosts/opencode/SKILL.md` and `hosts/omp/SKILL.md` are 85KB. `hosts/grok/` has no SKILL; Grok install is `symlink-claude`.
- `scripts/build.mjs` copies the Claude essay into `plugin/pipeline/skills/pipeline/SKILL.md` and rewrites a marked command table.
- `core/scripts/docs-generate.ts` rewrites marked tables in Claude, Codex, OMP, and OpenCode from `COMMAND_REGISTRY` + `OPERATION_SURFACE`.
- `OPERATION_SURFACE` does not list `train` or `ship`. Those verbs live in `COMMAND_REGISTRY` / `command-docs.ts` and already appear in the current SKILL tables.
- #1047 and #1048 already shipped. This slice implements the short SKILL those docs describe.

Conflicts (do not average them):

1. Living `grok-skill-path` forbids a distinct `hosts/grok/SKILL.md` fork and pins `symlink-claude`. Grill lock for #1049 requires a generated Grok repository output but forbids lifecycle changes. This change MODIFIES the wording to permit a byte-identical generated conformance output while preserving `symlink-claude`.
2. Living `omp-host-install` and `generated-cli-reference` treat OMP as a SKILL host. Grill lock: Tugboat/OMP gets no SKILL. This change MODIFIES those specs and deletes `hosts/omp/SKILL.md`.
3. Living stage-inventory, `/goal` bootstrap, advance/loop orchestration, and Monitor-grep specs require SKILL essays. Grill lock: SKILL is verb table + follow contract + doc pointers. This change retargets those requirements to the shared contract and docs.
4. Current SKILL tables list the full documented CLI inventory. Grill lock: SKILL verb table is `OPERATION_SURFACE`. `docs/cli.md` stays the full inventory. `train` and `ship` join `OPERATION_SURFACE`.
5. Living loop-facade, release-plan, lessons, adapter-setup, artifact-ignore, engine-update, and README clarity requirements still mandate tutorial or inventory content in host essays. This change retargets that detailed material to CLI help, README, and durable docs while preserving each compact verb, follow, notify, and authority obligation in the generated one-pager.

## Goals / Non-Goals

**Goals:**

1. One shared follow/notify source that four hosts and later #971 all render.
2. Four committed generated SKILLs that match that source.
3. Delete the handwritten essays, including OMP.
4. Keep merge-capable `train` and `ship` visible as verbs without letting follow escalate into them.
5. Keep `build.mjs --check` and docs freshness as the gates for generated output.

**Non-Goals:**

- Hermes/OpenClaw install packs (#969/#970/#971).
- Deleting `plugin/` (#1050).
- MCP (#907) or MessagingPort (#966).
- Engine or outer-host install lifecycle changes. Grok remains `symlink-claude`.
- Changing CLI dispatch, stage handlers, or merge authority.
- Restoring `/pipeline:*` or Codex yaml command files.

## Decisions

### D1 — `core/scripts/host-skill.ts` is a deep renderer, not another host registry

**Choice:** Add `core/scripts/host-skill.ts` next to `operation-surface.ts`. Its single deep rendering interface is `renderHostSkill(options?): string`, where the optional object may inject `operationSurface` and `manifests` for deterministic in-process tests; production defaults are `OPERATION_SURFACE` and the existing `loadOuterHostManifestsPreferHosts()` seam (repository manifests first, byte-identical core builtins as installed fallback). The module also exports one issue-locked data tuple, `SKILL_HOST_IDS = ["claude", "codex", "grok", "opencode"] as const`, which is the authoritative membership set for both rendered notify rows and generated host target paths. The tuple contains no notify values or lifecycle behavior. The renderer selects those IDs in tuple order, requires exactly one manifest for each, fails closed on a missing or duplicate selected ID, and ignores non-selected manifests such as OMP. It owns frontmatter, verb-table formatting, follow/notify prose, and the exact installed-tree-safe links `https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/packaging.md` and `https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/cli.md`. It derives each displayed notify row only from the selected manifest's `material_progress_notify.mapping` (`surface`, `tools`, and `filter`). It does not export contract fragments, a host-profile table, or hardcoded notify values. #971 calls only `renderHostSkill`; callers do not assemble or copy contract fragments.

**Why:** Four handwritten essays are the drift, while outer-host manifests already own notify capabilities. One deep renderer hides both formatting and manifest projection behind one call without creating a second source of notify truth. The separate ID tuple records the issue-locked generated-host membership without duplicating notify behavior, and its exact order makes output deterministic across filesystem enumeration order.

**Alternatives considered:**

- Keep four handwritten short SKILLs — they will drift the same way.
- Export separate contract, host-profile, normalizer, and renderer modules — a shallow interface that makes callers understand the implementation.
- Hardcode a `claude`/`codex`/`grok`/`opencode` notify map in `host-skill.ts` — duplicates the manifest registry and can drift from install/runtime guidance.
- Infer generated-SKILL membership from `install.overlayFiles` or host mode — conflates install lifecycle with this issue's explicit conformance-output set and cannot express Grok and OMP correctly without special cases.
- Generate only the verb table inside leftover essays — leaves the 80KB problem.
- Put the contract only in `docs/packaging.md` and point SKILLs at it — grill lock requires the follow contract **in** the SKILL.

### D2 — `scripts/build.mjs` is the sole whole-SKILL writer

**Choice:** `scripts/build.mjs` derives each `hosts/<id>/SKILL.md` target from `SKILL_HOST_IDS` and writes the entire file (frontmatter, verb table, follow/notify, pointers). Its `--check` comparison derives the same four host paths from that tuple and also includes `plugin/pipeline/skills/pipeline/SKILL.md` and `.claude-plugin/marketplace.json`. A drift test fails if the authoritative ID set, rendered row set, write targets, and check targets differ. `core/scripts/docs-generate.ts` drops SKILL render/apply helpers and SKILL artifacts. `scripts/generate-docs.mjs` drops all SKILL reads, marker checks, OMP existence checks, and writes.

**Why:** Marked regions and two writers are how the essays and stale ownership survived. One writer gives hook, CI, eval fixtures, and contributors one deterministic regeneration command.

**Alternatives considered:**

- Keep `<!-- BEGIN GENERATED: cli-command-table -->` inside a short handwritten wrapper — extra surface for drift, and the follow contract would still be hand-copied.
- Let `generate-docs.mjs` keep reading SKILLs but stop writing them — retains an unnecessary OMP/file-existence dependency and obscures write ownership.

### D3 — SKILL verb table is `OPERATION_SURFACE`; `docs/cli.md` stays the full CLI inventory

**Choice:** Add `train` and `ship` to `OPERATION_SURFACE`. Render SKILL tables from `OPERATION_SURFACE` only. Keep `docs/cli.md` generated from `COMMAND_REGISTRY` plus `OPERATION_SURFACE` as today.

**Why:** Grill lock names the `OPERATION_SURFACE` table and still requires `train`/`ship` as explicit verbs. Dumping the full registry into the SKILL would keep the table long.

**Alternatives considered:**

- Render the full documented registry in every SKILL — not short.
- Leave `train`/`ship` only in `COMMAND_REGISTRY` — violates the grill lock.

### D4 — Follow contract is short and fail-closed on merge

**Choice:** The in-SKILL contract keeps the default numeric `pipeline <N>` issue/PR drive outside the verb table. CLI dispatch is a non-goal: `pipeline <N>` remains direct `runAdvance` and follows `pipeline logs <advance-run-id> --events --follow` from the advance handoff. `pipeline single` and `pipeline loop` remain the durable loop path (`runLoopEngine`), retain `loop_run_id`, follow `pipeline loop logs <loop-run-id> --events --follow`, and add linked-advance follow after `loop_item_advance_linked`. Advance `run_complete` stops only that advance follow; only `loop_run_complete`, `loop_run_stopped`, or supervisor exit tears down the loop-scoped set. The contract requires reattach after an interrupted follow, a terminal reason plus final summary, and never invokes `merge` / `merge-queue --apply` / `train --merge` / `ship`. A compact authority block preserves the living contract: default advance/loop autonomously stops at `pipeline:ready-to-deploy`; merge and deploy stay outside it; per-PR merge, merge-queue apply (dry-run by default), train merge, and milestone ship are explicit operator surfaces; `Ship milestone vX.Y.Z` maps to `pipeline ship --milestone vX.Y.Z`. Discovery frontmatter is host-neutral and includes operator-authorized train/ship. Every generated file contains the same table and prose. Detailed state-home discovery bash and dual-follow FIFO scripts leave the SKILL.

**Why:** Those scripts are the essay. The living obligation that matters is follow-until-terminal and no follower merge.

**Alternatives considered:**

- Keep the 4b bash in the shared source — the source would not be short, and #971 would inherit another essay.

### D5 — Grok gets a generated conformance output; install lifecycle stays unchanged

**Choice:** Generate `hosts/grok/SKILL.md` byte-for-byte identically to `hosts/claude/SKILL.md`. Keep `hosts/grok/outer-host.manifest.json` and its core builtin mirror on `mode: "symlink-claude"`, `overlayDir: "hosts/claude"`, and `overlayFiles: []`. Update `README.md`, `docs/packaging.md`, and Grok manifest prose to distinguish the generated repository conformance file from the installed path. The installed path remains the Claude-managed symlink before and after this change.

**Why:** Grill lock requires four generated in-repo files and separately excludes engine lifecycle changes. #1048 already made direct `pipeline <verb>` the durable host contract. Byte identity satisfies both requirements and makes the existing symlink semantically exact rather than a stale Claude essay.

**Alternatives considered:**

- Change Grok to tree mode — violates the explicit lifecycle non-goal and expands installer/shadow semantics.
- Generate host-specific bodies — makes the existing symlink wrong and recreates drift.
- Omit the Grok repository output — violates the four-file acceptance criterion and removes the #971 conformance target.

### D6 — Delete `hosts/omp/SKILL.md`; OMP remains a CLI install host

**Choice:** Remove the OMP SKILL overlay. Set `install.overlayFiles` to `[]` in both `hosts/omp/outer-host.manifest.json` and its byte-identical runtime mirror `core/scripts/outer-hosts/builtins/omp.json`. Keep OMP tree mode, its native command, core/launcher staging, and `--host omp`. Do not add Eve/Foreman.

**Why:** Grill lock: Tugboat/OMP gets no SKILL.

**Alternatives considered:**

- Generate a fifth OMP SKILL for symmetry — violates the grill lock.

### D7 — Retarget SKILL-essay living specs instead of keeping the essays

**Choice:** MODIFY stage-inventory, `/goal` bootstrap, advance/loop orchestration, loop facade, notify-map, Monitor-grep, release-plan, lessons, adapter setup, artifact-ignore, engine-update, README clarity, core-mirror-sync, host provisioning, pre-commit regeneration, and eval generated-output accounting so the generated SKILL is not required to carry those essays and every generator consumer recognizes the four new outputs. Move inventories and tutorials to CLI help, README, and durable docs. Keep compact verb, follow/notify, and merge-authority obligations on the shared rendered contract. Outer-host manifests remain the sole notify-map source; the renderer only formats their declarations and never dispatches notify behavior by host name.

**Why:** Implementing the grill lock without those MODIFIED deltas would contradict living specs at archive time and fail existing SKILL-essay tests.

**Alternatives considered:**

- Leave the living specs and keep essays to satisfy them — this issue would be a no-op.

### D8 — Plugin generation calls the renderer, not a generated host file

**Choice:** `scripts/build.mjs` calls `renderHostSkill` directly when it emits `plugin/pipeline/skills/pipeline/SKILL.md`; it does not read `hosts/claude/SKILL.md` or call a docs marked-region helper. Any transitional plugin-only path adaptation consumes the renderer return value and does not reintroduce setup/engine essays. `--check` still gates the plugin output. No `plugin/` copy of `core/scripts`.

**Why:** #1050 deletes the shell. This slice must not leave `--check` red.

### D9 — Tests are in-process generation diffs, not live install

**Choice:** Unit tests call the renderer with injected `operationSurface` and manifest fixtures through its options object. They assert a fixture mapping change changes only the derived row; missing or duplicate selected IDs fail closed; the `SKILL_HOST_IDS` set exactly matches rendered rows and build write/check targets; all four committed files match the same rendered bytes; every notify row equals the corresponding outer-host manifest mapping; host and core builtin manifests remain mirrored; `train`/`ship` are present; essays/headings are absent; absolute doc links are exact; Grok remains `symlink-claude`; both OMP manifests use `overlayFiles: []`; plugin generation calls the renderer directly; and no command-file paths are written. No real network, git, or subprocess.

**Why:** Repo test convention. A byte-diff is the freshness gate that would have caught essay drift.

### D10 — Every generated-output consumer follows the new ownership boundary

**Choice:** `.githooks/pre-commit` triggers for the renderer, operation surface, build entry point, shared plugin inputs, generated host SKILL paths, and the exact four repository outer-host manifests. Its unstaged/untracked-input guards cover those same manifest inputs. After `build.mjs`, it stages the four tuple-derived host SKILLs, plugin SKILL, and marketplace catalog by exact path; its fixture generator and staging assertions cover all four host files and manifest-trigger behavior. Eval fixture preflight adds those four exact host paths to generated-packaging output accounting and computes them as required when an allowed source can change the renderer, operation surface, or manifest inputs. Post-tag docs refresh removes host SKILLs from `generate-docs.mjs` ownership because that command no longer writes them. Release clean-precondition and rollback handling account for all four build-owned host outputs, so a release cannot silently discard or strand generator dirt.

**Why:** Moving the writer without updating hook, eval, and release bookkeeping creates false boundary failures or permits stale generated files. Exact path lists retain the existing no-broad-staging safety property.

## Risks / Trade-offs

- [Existing tests grep SKILL essays for stage inventory, `/goal`, factory-policy strings, or Monitor grep] → Mitigation: retarget those tests in the same implementation; MODIFIED specs name the new surface.
- [A generated Grok path can look like a new install overlay] → Mitigation: D5 makes it byte-identical to Claude and tests that the Grok manifest remains `symlink-claude`; it is a repository conformance output, not a lifecycle branch.
- [Manifest-derived notify prose can drift when only one manifest copy changes] → Mitigation: existing host/builtin mirror tests plus new manifest/render parity make both kinds of drift fail.
- [SKILL table shorter than today's full CLI table] → Mitigation: pointer to `docs/cli.md`; `train`/`ship` stay on `OPERATION_SURFACE`.
- [Follow contract loses race-safe discovery bash] → Mitigation: living loop/advance specs keep the obligation as capture `run_id` then follow-until-terminal; docs MAY keep extra detail. Do not put bash back in the SKILL.
- [#971 lands before this source exists] → Mitigation: this change commits the source first; #971 is a consumer, not a blocker.

## Migration Plan

1. Land the shared renderer, build-owned byte-identical four-file generation, OMP SKILL deletion, manifest changes, docs updates, and test/accounting retargets without changing any host install mode.
2. Run `node scripts/build.mjs` once to write all host and plugin SKILL outputs plus the catalog.
3. Run `node scripts/generate-docs.mjs` only for its remaining docs outputs if `docs/cli.md` sources change; it never touches a SKILL.
4. Rollback is revert of the change. `install --host grok` uses the same Claude symlink before, during, and after this change.

## Open Questions

None. Grill lock settles host set, SKILL contents, no command files, no Eve/Foreman, no OMP SKILL, and #971 consume-only.
