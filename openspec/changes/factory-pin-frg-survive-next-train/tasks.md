## 1. Ignore FRG artifacts

- [ ] 1.1 Add `.agent-pipeline/frg/` to the exported artifact ignore contract with a comment that it is local FRG evidence (including `latest.json`)
- [ ] 1.2 Ensure this repo root `.gitignore` (and the managed ignore block) lists `.agent-pipeline/frg/`
- [ ] 1.3 Untrack any already-committed `.agent-pipeline/frg/` paths if they would remain modified tracked dirt after ignore
- [ ] 1.4 Update the drift-guard test so a missing `frg/` contract entry fails

## 2. Shared factory pin path

- [ ] 2.1 Make Tugboat export `AGENT_PIPELINE_PRODUCTION_PIN` at start when unset; default to the factory control checkout `.agent-pipeline/production-engine-pin.json`; do not overwrite an operator value
- [ ] 2.2 Make the host `pipeline` launcher export the same default on the factory control plane when unset
- [ ] 2.3 Confirm non-skip `engine-promote` writes the exported path (not only a worktree `repoDir` pin) and reuses `isProductionQualityPin`

## 3. Doctor and composer guards

- [ ] 3.1 Add or extend doctor so an installed Tugboat or `pipeline-ship-playbook` that hard-codes default `--skip-frg` fails with refresh remediation; skip when no composer is installed
- [ ] 3.2 Confirm factory `install:engine-track` loads the exported pin path and passes after a production-quality promote of N on a clean factory control checkout

## 4. Tests

- [ ] 4.1 Hermetic test: Tugboat / launcher export sets the factory pin when unset and preserves an operator override
- [ ] 4.2 Hermetic test: non-skip promote with exported pin path and a different worktree `repoDir` writes the exported pin as `frg-…` and does not leave only the worktree pin updated
- [ ] 4.3 Hermetic test: default promote with a real FRG pass does not write `no-frg-*`; the test fails if that write is reintroduced
- [ ] 4.4 Doctor / fixture test: old skip-frg playbook or Tugboat body fails; current repo example (no default `--skip-frg`) passes
- [ ] 4.5 Ignore-contract / gitignore test: uncommitted `.agent-pipeline/frg/<ver>/latest.json` is ignored; drift guard names `frg/`
- [ ] 4.6 Tests inject I/O or inspect source/fixtures. No live pack, network, git, or subprocess ship

## 5. Docs

- [ ] 5.1 Update `docs/factory-reliability-gate-runbook.md` so `.agent-pipeline/frg/` is gitignored on the factory control checkout; remove the "must commit leftover latest.json onto the protected checkout" bar
- [ ] 5.2 Keep auto-tag / release attachment: release MAY `git add -f` that version's evidence; local `latest.json` remains the ship-host lookup
- [ ] 5.3 Update ship-milestone / supervisor docs so Tugboat and the host launcher export `AGENT_PIPELINE_PRODUCTION_PIN`
- [ ] 5.4 Update README / host SKILL ignored-path lists to include `.agent-pipeline/frg/`

## 6. Packaging and gate

- [ ] 6.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 6.2 Run `openspec validate factory-pin-frg-survive-next-train` and `npm run ci` from the repo root. Fix failures until green
