## Context

See `proposal.md` for why. Today:

- `hosts/claude/SKILL.md` is 87KB, `hosts/codex/SKILL.md` is 76KB, `hosts/opencode/SKILL.md` and `hosts/omp/SKILL.md` are 85KB. `hosts/grok/` has no SKILL; Grok install is `symlink-claude`.
- `scripts/build.mjs` copies the Claude essay into `plugin/pipeline/skills/pipeline/SKILL.md` and rewrites a marked command table.
- `core/scripts/docs-generate.ts` rewrites marked tables in Claude, Codex, OMP, and OpenCode from `COMMAND_REGISTRY` + `OPERATION_SURFACE`.
- `OPERATION_SURFACE` does not list `train` or `ship`. Those verbs live in `COMMAND_REGISTRY` / `command-docs.ts` and already appear in the current SKILL tables.
- #1047 and #1048 already shipped. This slice implements the short SKILL those docs describe.

Conflicts (do not average them):

1. Living `grok-skill-path` forbids `hosts/grok/SKILL.md`. Grill lock for #1049 requires a generated Grok SKILL. This change MODIFIES `grok-skill-path`.
2. Living `omp-host-install` and `generated-cli-reference` treat OMP as a SKILL host. Grill lock: Tugboat/OMP gets no SKILL. This change MODIFIES those specs and deletes `hosts/omp/SKILL.md`.
3. Living stage-inventory, `/goal` bootstrap, advance/loop orchestration, and Monitor-grep specs require SKILL essays. Grill lock: SKILL is verb table + follow contract + doc pointers. This change retargets those requirements to the shared contract and docs.
4. Current SKILL tables list the full documented CLI inventory. Grill lock: SKILL verb table is `OPERATION_SURFACE`. `docs/cli.md` stays the full inventory. `train` and `ship` join `OPERATION_SURFACE`.

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
- Changing CLI dispatch, stage handlers, or merge authority.
- Restoring `/pipeline:*` or Codex yaml command files.

## Decisions

### D1 — Shared contract is one committed source; generator inlines a short rendering

**Choice:** Add one shared orchestration-contract source next to `OPERATION_SURFACE` (a TypeScript module that exports the follow/notify prose, or a markdown template the generator reads). The generator renders four SKILLs from that source plus the verb table. #971 imports the same source.

**Why:** Four handwritten essays are the drift. One source is the class fix. Issue #971 needs a consume path, not another copy.

**Alternatives considered:**

- Keep four handwritten short SKILLs — they will drift the same way.
- Generate only the verb table inside leftover essays — leaves the 80KB problem.
- Put the contract only in `docs/packaging.md` and point SKILLs at it — grill lock requires the follow contract **in** the SKILL.

### D2 — Generate the whole SKILL file, not a marked region in an essay

**Choice:** The generator writes the entire `hosts/<id>/SKILL.md` (frontmatter, verb table, follow/notify, pointers). There is no leftover handwritten body.

**Why:** Marked regions are how the essays survived #1048. A freshness test can only pin the committed file if the file is generated.

**Alternatives considered:**

- Keep `<!-- BEGIN GENERATED: cli-command-table -->` inside a short handwritten wrapper — extra surface for drift, and the follow contract would still be hand-copied.

### D3 — SKILL verb table is `OPERATION_SURFACE`; `docs/cli.md` stays the full CLI inventory

**Choice:** Add `train` and `ship` to `OPERATION_SURFACE`. Render SKILL tables from `OPERATION_SURFACE` only. Keep `docs/cli.md` generated from `COMMAND_REGISTRY` plus `OPERATION_SURFACE` as today.

**Why:** Grill lock names the `OPERATION_SURFACE` table and still requires `train`/`ship` as explicit verbs. Dumping the full registry into the SKILL would keep the table long.

**Alternatives considered:**

- Render the full documented registry in every SKILL — not short.
- Leave `train`/`ship` only in `COMMAND_REGISTRY` — violates the grill lock.

### D4 — Follow contract is short and fail-closed on merge

**Choice:** The in-SKILL contract is: capture `run_id`, follow `pipeline loop logs --events --follow` (or `pipeline logs <run-id> --events --follow`), stop on terminal, notify via the host map, never invoke `merge` / `merge-queue --apply` / `train --merge` / `ship`. Hosts differ only by notify-tool names. Detailed state-home discovery bash and dual-follow FIFO scripts leave the SKILL.

**Why:** Those scripts are the essay. The living obligation that matters is follow-until-terminal and no follower merge.

**Alternatives considered:**

- Keep the 4b bash in the shared source — the source would not be short, and #971 would inherit another essay.

### D5 — Grok gets `hosts/grok/SKILL.md`; install publishes it

**Choice:** Generate `hosts/grok/SKILL.md` with the Grok invocation token (`pipeline`) and Grok notify (`monitor`). `install --host grok` SHALL publish that overlay onto the Grok skill path. A whole-tree symlink to the Claude skill is not enough once the SKILL text differs.

**Why:** Grill lock lists Grok as a SKILL host. Claude uses `/pipeline` and `PushNotification`; Grok does not.

**Alternatives considered:**

- Keep Grok as symlink-to-Claude SKILL — Grok would load `/pipeline` and `PushNotification`.
- Generate Grok SKILL but never install it — dead file.

### D6 — Delete `hosts/omp/SKILL.md`; OMP remains a CLI install host

**Choice:** Remove the OMP SKILL overlay. Keep `hosts/omp/outer-host.manifest.json` and `--host omp` CLI install. Do not add Eve/Foreman.

**Why:** Grill lock: Tugboat/OMP gets no SKILL.

**Alternatives considered:**

- Generate a fifth OMP SKILL for symmetry — violates the grill lock.

### D7 — Retarget SKILL-essay living specs instead of keeping the essays

**Choice:** MODIFY stage-inventory, `/goal` bootstrap, advance/loop orchestration, notify-map, Monitor-grep, and core-mirror-sync so the generated SKILL is not required to carry those essays. Move inventory and `/goal` bootstrap to docs. Keep follow/notify on the shared contract.

**Why:** Implementing the grill lock without those MODIFIED deltas would contradict living specs at archive time and fail existing SKILL-essay tests.

**Alternatives considered:**

- Leave the living specs and keep essays to satisfy them — this issue would be a no-op.

### D8 — Plugin overlay still comes from the generated Claude SKILL

**Choice:** `scripts/build.mjs` continues to emit `plugin/pipeline/skills/pipeline/SKILL.md` from the generated Claude SKILL (path rewrite for the transitional marketplace overlay). `--check` still gates it. No `plugin/` copy of `core/scripts`.

**Why:** #1050 deletes the shell. This slice must not leave `--check` red.

### D9 — Tests are in-process generation diffs, not live install

**Choice:** Unit tests call the generator with injected `OPERATION_SURFACE` / contract fixtures. They assert committed files match, host bodies match after token/notify substitution, `train`/`ship` are present, merge-capable verbs are listed as operator-authorized, essays/headings are absent, and no command-file paths are written. No real network, git, or subprocess.

**Why:** Repo test convention. A byte-diff is the freshness gate that would have caught essay drift.

## Risks / Trade-offs

- [Existing tests grep SKILL essays for stage inventory, `/goal`, factory-policy strings, or Monitor grep] → Mitigation: retarget those tests in the same implementation; MODIFIED specs name the new surface.
- [Grok install today is whole-tree symlink-claude] → Mitigation: D5 publishes a Grok SKILL overlay; doctor symlink-coherence stays for any remaining symlink path.
- [SKILL table shorter than today's full CLI table] → Mitigation: pointer to `docs/cli.md`; `train`/`ship` stay on `OPERATION_SURFACE`.
- [Follow contract loses race-safe discovery bash] → Mitigation: living loop/advance specs keep the obligation as capture `run_id` then follow-until-terminal; docs MAY keep extra detail. Do not put bash back in the SKILL.
- [#971 lands before this source exists] → Mitigation: this change commits the source first; #971 is a consumer, not a blocker.

## Migration Plan

1. Land the shared source, generator, four SKILLs, OMP SKILL deletion, and test retargets on this branch.
2. Run `node scripts/build.mjs` so the plugin overlay matches the Claude one-pager.
3. Run `node scripts/generate-docs.mjs` if SKILL-table or `docs/cli.md` outputs change.
4. Rollback is revert of the change. Install `--host grok` after revert would again symlink Claude.

## Open Questions

None. Grill lock settles host set, SKILL contents, no command files, no Eve/Foreman, no OMP SKILL, and #971 consume-only.
