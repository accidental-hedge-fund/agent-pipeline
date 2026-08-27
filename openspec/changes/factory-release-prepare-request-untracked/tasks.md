## 1. Request-path admission gate

- [x] 1.1 Add a pure path-containment helper that resolves `--request` (absolute, then realpath of the file or parent when it exists) and reports whether it is inside a checkout root. Verify with unit cases: descendant, checkout root, symlink into checkout, `$TMPDIR` outside, `..` escape that still lands inside
- [x] 1.2 Call that helper from `runFactoryReleasePrepare` against `repoDir` and the factory control checkout when distinct, before pack-loop dispatch. Verify an in-checkout path throws with token `request_inside_checkout`, names the path and checkout, and names `$TMPDIR` / state dir / Tugboat `$RUN_DIR` as remediation
- [x] 1.3 Verify gitignored descendants (for example `$REPO_DIR/.agent-pipeline/frg/request.json`) are still rejected
- [x] 1.4 Verify an absolute path under `$TMPDIR` or `AGENT_PIPELINE_STATE_HOME` is not rejected for location (schema and later pack rules still apply)

## 2. Ignore-contract for prepare checkpoints

- [x] 2.1 Add `.agent-pipeline/factory-release/` to `ARTIFACT_CONTRACT` with a comment that it holds prepare checkpoints and loop bindings. Verify the drift-guard test fails if that entry is removed
- [x] 2.2 Ensure this repo root `.gitignore` (and the managed ignore block) lists `.agent-pipeline/factory-release/`. Verify an uncommitted `checkpoint.json` under that tree is ignored
- [x] 2.3 Keep `.agent-pipeline/frg/` on the contract. Do not gitignore `request-*.json` at the `.agent-pipeline/` root as the product fix. Verify the pin file path `.agent-pipeline/production-engine-pin.json` is still not a contract ignore path

## 3. Tests

- [x] 3.1 Hermetic prepare test: `--request` inside the target checkout fails before any spawn / loop-dispatch dep is called. The test fails if that path is accepted
- [x] 3.2 Hermetic prepare test: off-repo `--request` plus in-memory checkpoint writes does not leave an unignored dest under `repoDir` (work dir is the contract `factory-release/` path). The test fails if prepare would write an unignored artifact
- [x] 3.3 Hermetic Tugboat / ship-adapter test: request dest is `$RUN_DIR/factory-release-prepare-request.json` or `AGENT_PIPELINE_STATE_HOME/...` and does not resolve inside `REPO_DIR`. The test fails if dest is `$REPO_DIR/.agent-pipeline/...`
- [x] 3.4 Ignore-contract / gitignore test: uncommitted `.agent-pipeline/factory-release/<fp>/checkpoint.json` is ignored; drift guard names `factory-release/`
- [x] 3.5 Tests inject I/O or inspect source/fixtures. No live pack, network, git, or subprocess ship

## 4. Docs

- [x] 4.1 Update `docs/factory-reliability-gate-runbook.md` so `--request` examples are off-repo (`$TMPDIR`, state dir, or Tugboat `$RUN_DIR`). Verify the runbook does not show `$REPO_DIR/.agent-pipeline/request.json` as the dest
- [x] 4.2 Update `FACTORY_RELEASE_PREPARE_HELP` (and CLI reference if it repeats the example) with the same off-repo rule. Verify `--help` text names the location gate
- [x] 4.3 Update README / host `SKILL.md` ignored-path lists to include `.agent-pipeline/factory-release/` wherever they enumerate the contract. Verify no listed subset omits the new entry
- [x] 4.4 Update `docs/runbooks/ship-milestone.md` if it shows a prepare `--request` dest so it matches the runbook

## 5. Packaging and gate

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.2 Run `openspec validate factory-release-prepare-request-untracked` and `npm run ci` from the repo root. Fix failures until green
