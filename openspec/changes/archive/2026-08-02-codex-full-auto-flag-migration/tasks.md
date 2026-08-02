## 1. Re-verify installed Codex CLI shapes

- [x] 1.1 Confirm on the implementer host that `codex --version` is recorded, that
      `codex exec --help` still documents `-s/--sandbox` (`workspace-write`) and
      `--dangerously-bypass-approvals-and-sandbox`, and that
      `-a/--ask-for-approval` is **not** accepted after `exec` (if version differs
      from design.md's `0.145.0`, update the design verification table)
- [x] 1.2 Spot-check that `codex exec --sandbox workspace-write` still reports
      session header `approval: never` + `sandbox: workspace-write` with no
      `--full-auto` deprecation warning (parity with `codex exec --full-auto`)
- [x] 1.3 Confirm `codex exec -a never` / `--ask-for-approval never` still fails
      with unexpected-argument (do not ship those tokens)

## 2. Adapter argv migration

- [x] 2.1 In `core/scripts/harness-adapters/codex.ts`, replace managed-path
      `"--full-auto"` with consecutive `"--sandbox", "workspace-write"`
- [x] 2.2 Do **not** emit `-a`, `--ask-for-approval`, or other approval-policy
      tokens on managed or bypass paths
- [x] 2.3 Leave the external-bypass path on
      `"--dangerously-bypass-approvals-and-sandbox"` and the `sandboxMode` /
      ambient `PIPELINE_CODEX_NO_SANDBOX` selection logic unchanged; selectors
      remain mutually exclusive
- [x] 2.4 Update adapter header comments that document `--full-auto` (including
      the `capabilities.sandbox` comment) and note verified never-ask equivalence
      for the `exec` path on the recorded CLI version

## 3. Related comments and operator docs

- [x] 3.1 Update `core/scripts/harness.ts` header / option comments that name
      `--full-auto` as the production codex shape
- [x] 3.2 Update `core/scripts/harness-adapters/types.ts` comments that name
      `--full-auto` if present
- [x] 3.3 Update high-traffic operator copy that teaches the production codex
      flags (at least `README.md` harness-sandbox section; config schema comments
      that say codex is sandboxed "via --full-auto") without changing behavior of
      `harness_sandbox` itself

## 4. Golden-argv and regression tests

- [x] 4.1 Grep `core/test/` (and any adapter tests) for `--full-auto` / `full-auto`
      pins; update all production-shape assertions
- [x] 4.2 Default managed path: expect consecutive `--sandbox` + `workspace-write`;
      forbid `--full-auto`, `-a`, `--ask-for-approval`, and the bypass flag
- [x] 4.3 Explicit `sandboxMode: "managed"` overrides ambient
      `PIPELINE_CODEX_NO_SANDBOX=1` → managed flags only
- [x] 4.4 Ambient bypass (env set, no explicit mode) and explicit
      `sandboxMode: "external-bypass"` → only
      `--dangerously-bypass-approvals-and-sandbox`; forbid managed sandbox pair,
      `--full-auto`, and approval-policy tokens
- [x] 4.5 Managed-vs-bypass "rest of argv identical" helper strips the multi-token
      managed sequence (`--sandbox`, `workspace-write`), not a single
      `--full-auto` token
- [x] 4.6 Reasoning-effort placement remains immediately before the stdin `-`
      sentinel on the managed path; still rejects `--full-auto`
- [x] 4.7 Prove at least one regression would fail if `--full-auto` were
      reintroduced (assertion absence of that token on managed path)

## 5. Spec deltas (approval + mutual exclusivity wording)

- [x] 5.1 Update `cli-harness-adapters` / `configurable-review-harness` /
      `plan-review-effort-controls` deltas so every managed example asserts the
      full managed sequence and that post-`exec` approval-policy flags are **not**
      emitted; bypass scenarios assert mutual exclusivity with sandbox **and**
      approval-policy arguments
- [x] 5.2 Replace any remaining unsupported claim that "approval is provided by
      exec" without the verified never-ask / rejected-flag constraints

## 6. Mirror, validate, CI

- [x] 6.1 Run `node scripts/build.mjs` and include regenerated `plugin/` in the
      same commit as core edits
- [x] 6.2 Run `openspec validate codex-full-auto-flag-migration` (and
      `openspec validate --all` if required by local gate)
- [x] 6.3 Run `npm run ci` from the repo root and fix failures
- [x] 6.4 Confirm every acceptance criterion in `proposal.md` is checkable against
      the diff and test output

## 7. Scope honesty / follow-up issue

- [x] 7.1 File a GitHub issue for deferred isolation-posture work (ambient
      `PIPELINE_CODEX_NO_SANDBOX` demotion, `capabilities.sandbox` honesty,
      least-privilege defaults) with a concrete title and problem statement
- [x] 7.2 Link that issue number from the PR description and replace the unnumbered
      residual in `design.md`
- [x] 7.3 Confirm this PR does **not** silently change ambient-env demotion or
      capability-bit semantics
