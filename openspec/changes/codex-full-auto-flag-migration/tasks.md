## 1. Re-verify installed Codex CLI shapes

- [ ] 1.1 Confirm on the implementer host that `codex exec --help` still documents
      `-s/--sandbox` (`workspace-write`) and `--dangerously-bypass-approvals-and-sandbox`,
      and that `-a/--ask-for-approval` is **not** accepted after `exec` (record version in the
      PR if different from design.md's `0.145.0`)
- [ ] 1.2 Spot-check that `codex exec --sandbox workspace-write` still reports
      `approval: never` + `sandbox: workspace-write` with no `--full-auto` deprecation warning

## 2. Adapter argv migration

- [ ] 2.1 In `core/scripts/harness-adapters/codex.ts`, replace managed-path `"--full-auto"`
      with consecutive `"--sandbox", "workspace-write"`
- [ ] 2.2 Leave the external-bypass path on
      `"--dangerously-bypass-approvals-and-sandbox"` and the `sandboxMode` /
      ambient `PIPELINE_CODEX_NO_SANDBOX` selection logic unchanged
- [ ] 2.3 Update adapter header comments that document `--full-auto` (including the
      `capabilities.sandbox` comment if it names the old flag)

## 3. Related comments and operator docs

- [ ] 3.1 Update `core/scripts/harness.ts` header / option comments that name
      `--full-auto` as the production codex shape
- [ ] 3.2 Update `core/scripts/harness-adapters/types.ts` comments that name
      `--full-auto` if present
- [ ] 3.3 Update high-traffic operator copy that teaches the production codex flags
      (at least `README.md` harness-sandbox section; config schema comments that say
      codex is sandboxed "via --full-auto") without changing behavior of
      `harness_sandbox` itself

## 4. Golden-argv and regression tests

- [ ] 4.1 Grep `core/test/` (and any adapter tests) for `--full-auto` / `full-auto` pins
- [ ] 4.2 Update managed-sandbox assertions to expect `--sandbox` + `workspace-write` and
      to forbid `--full-auto`
- [ ] 4.3 Update managed-vs-bypass "rest of argv identical" helpers to strip the
      multi-token managed sequence (not a single `--full-auto` token)
- [ ] 4.4 Keep external-bypass and ambient-env precedence tests; only the managed-side
      token(s) change
- [ ] 4.5 Prove at least one regression would fail if `--full-auto` were reintroduced
      (assertion absence of that token on managed path)

## 5. Mirror, validate, CI

- [ ] 5.1 Run `node scripts/build.mjs` and include regenerated `plugin/` in the same
      commit as core edits
- [ ] 5.2 Run `openspec validate codex-full-auto-flag-migration` (and `openspec validate
      --all` if required by local gate)
- [ ] 5.3 Run `npm run ci` from the repo root and fix failures
- [ ] 5.4 Confirm every acceptance criterion in `proposal.md` is checkable against the
      diff and test output

## 6. Scope honesty / follow-up

- [ ] 6.1 In the PR description, restate that ambient-env demotion,
      `capabilities.sandbox` honesty, and least-privilege product posture are **not**
      solved by this flag migration
- [ ] 6.2 Link or file a follow-up issue for that isolation-posture work if one is not
      already open
