## 1. Audit Tugboat vs checklist

- [x] 1.1 Diff `examples/supervisor/shell/tugboat.sh` against proposal acceptance criteria (#989/#996/#997, PR reuse, serial multi-milestone, thin markers) and list any real source gaps
- [x] 1.2 Confirm sibling helpers used by Tugboat (`train-status-complete.py`, `release-checks-green.py`, `ship-notify.sh`, `ship-stage-watch.sh`) remain the single shared install set
- [x] 1.3 Close only confirmed behavioral gaps in Tugboat with minimal edits (do not rewrite the composer)

Audit result: no source gaps — Tugboat already implements promote `:-all`, failure_detail, CI-wait bucket, PR reuse, serial multi-milestone, thin markers, train resume. No composer rewrite.

## 2. Docs and Hermes phrase map

- [x] 2.1 Update `examples/supervisor/README.md` to list Tugboat as the Option 1 primary ship composer and label playbook/ship-milestone as alternate/legacy or non-primary
- [x] 2.2 Update `docs/runbooks/ship-milestone.md` (and `docs/supervisor.md` ship section if needed) with Option 1 install: Tugboat + siblings into `~/.local/bin`, state dir, `--status`
- [x] 2.3 Update `examples/supervisor/hermes/SKILL.md` so `Ship milestone vX.Y.Z` / ship status map to Tugboat detach and `--status` (not playbook-as-primary or authorized ship-milestone as the Option 1 default)
- [x] 2.4 Document operator env requirements (`REPO_DIR`, `PIPELINE`, `ALLOW_MERGE=1`) and parked non-goals pointer (no grant factory / Option 2)

## 3. Install parity and doctor

- [x] 3.1 Add a pure helper that evaluates whether an installed Option 1 ship binary matches critical thin markers (promote `:-all`, failure_detail, CI wait / bucket, thin composer identity)
- [x] 3.2 Wire a doctor check (e.g. `supervisor:tugboat-install-parity`) that fails closed on divergent installed primary Tugboat/playbook-as-primary with refresh remediation, and skips when unused
- [x] 3.3 Keep existing `supervisor:ship-playbook-promote-host` for hosts that still install the legacy playbook
- [x] 3.4 Unit-test doctor/helper pass/fail/skip fixtures without real home mutation outside test temp dirs

## 4. Regression coverage

- [x] 4.1 Extend `core/test/tugboat.test.ts` for any checklist item not already covered (idempotent release PR reuse shape, status no-side-effect static assert, multi-milestone serial markers if missing)
- [x] 4.2 Prove each new assertion fails without the protected behavior (comment or temporary local proof while authoring)
- [x] 4.3 Ensure promote default, failure_detail, CI-wait bucket schema, and thinness tests remain green

## 5. Validate and ship the change

- [x] 5.1 Run `openspec validate tugboat-thin-ship-hardening` and fix structural errors
- [x] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [x] 5.3 Run targeted tests (`tugboat`, doctor as applicable) then `npm run ci` from repo root
- [x] 5.4 Note agent-box post-merge reinstall steps in the PR body (operator host action, not CI)

### Agent-box post-merge reinstall (operator host; not CI)

```bash
ROOT=/path/to/agent-pipeline   # post-merge checkout at the ship version
install -d -m 0755 "$HOME/.local/bin"
for f in tugboat ship-notify ship-stage-watch pipeline-launcher; do
  install -m 0755 "$ROOT/examples/supervisor/shell/${f}.sh" "$HOME/.local/bin/$f"
done
install -m 0755 "$ROOT/examples/supervisor/shell/train-status-complete.py" \
  "$HOME/.local/bin/train-status-complete.py"
install -m 0755 "$ROOT/examples/supervisor/shell/release-checks-green.py" \
  "$HOME/.local/bin/release-checks-green.py"
pipeline doctor   # expect supervisor:tugboat-install-parity pass when tugboat installed
```

Do not keep a divergent host fork as the primary Buzz ship path.
