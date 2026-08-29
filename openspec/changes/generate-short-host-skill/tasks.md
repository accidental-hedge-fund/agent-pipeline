## 1. Catalog and shared contract

- [ ] 1.1 Add `train` and `ship` to `OPERATION_SURFACE` as explicit operator-authorized verbs (same summaries as today's `command-docs.ts`) and verify they appear when the catalog is enumerated.
- [ ] 1.2 Add one shared orchestration-contract source that names `run_id`, `pipeline loop logs --events --follow` (or equivalent logs follow), stop-on-terminal, host notify-map substitution, and a forbid-list of merge-capable commands (`merge`, `merge-queue --apply`, `train --merge`, `ship`). Verify the source is a single committed module or doc, not four host copies.
- [ ] 1.3 Export that source so #971 can import or render it without copying a host essay. Verify there is no Hermes/OpenClaw install path in this change (`git diff` does not add `examples/supervisor` install logic).

## 2. Generator

- [ ] 2.1 Implement a deterministic generator that writes whole SKILL files for Claude, Codex, Grok, and OpenCode from `OPERATION_SURFACE` plus the shared contract (host token and notify-tool names only). Verify a fixture `OPERATION_SURFACE` produces four bodies that match after token/notify substitution.
- [ ] 2.2 Wire the generator into `scripts/build.mjs` and/or `scripts/generate-docs.mjs` so `--check` fails on a stale committed SKILL. Verify `--check` exits non-zero after a one-byte edit to a generated SKILL.
- [ ] 2.3 Stop rewriting `hosts/omp/SKILL.md` as a command-table target. Verify the generator host list is Claude, Codex, Grok, OpenCode only.
- [ ] 2.4 Assert the generator writes no `/pipeline:*` markdown command files and no Codex `pipeline-<verb>.yaml` agents. Verify the existing #1048 command-pack test still fails if those paths are written.

## 3. Host artifacts

- [ ] 3.1 Generate and commit `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md`. Verify each file contains the verb table, follow/notify contract, and pointers to `docs/packaging.md` and `docs/cli.md`.
- [ ] 3.2 Delete `hosts/omp/SKILL.md` and drop it from OMP overlay files. Verify `test -f hosts/omp/SKILL.md` is false and `hosts/omp/outer-host.manifest.json` still exists.
- [ ] 3.3 Point the Grok outer-host overlay at the generated Grok SKILL and publish it on `install --host grok`. Verify a dry-run or overlay unit test names `hosts/grok/SKILL.md` and does not claim “no separate Grok SKILL.md”.
- [ ] 3.4 Run `node scripts/build.mjs` so the plugin SKILL overlay matches the generated Claude one-pager. Verify `node scripts/build.mjs --check` is green.

## 4. Tests and living-spec retargets

- [ ] 4.1 Add a freshness test that fails when a committed generated SKILL differs from a fresh generation. Prove it bites by mutating one SKILL without regenerating.
- [ ] 4.2 Add a host-parity test that fails if generated SKILLs encode different stage-machine logic. Prove it bites by injecting a host-only stage heading in a fixture.
- [ ] 4.3 Retarget stage-inventory, native-`/goal`, factory-policy, and Monitor-grep tests off the deleted essays and onto docs / the shared contract as specified. Verify those tests pass against the short SKILLs and still fail on their named drifts.
- [ ] 4.4 Move stage-inventory and `/goal` bootstrap coverage into `docs/cli.md` or `docs/concepts.md` if those docs do not already carry it. Verify the modified `stage-inventory-ssot` and `native-goal-bootstrap` scenarios can be checked by reading those docs.

## 5. Validation

- [ ] 5.1 Run `openspec validate generate-short-host-skill` and fix structural errors until it passes.
- [ ] 5.2 Run `npm run ci` from the repo root and verify it is green (core tests, `build.mjs --check`, install smoke, OpenSpec, docs freshness, scripts).
- [ ] 5.3 Check `proposal.md` acceptance criteria against the tree (four short SKILLs, OMP SKILL gone, no command pack, shared contract, `train`/`ship` on the surface, `npm run ci` green) and record any miss before calling the change done.
