## Why

Every non-bypass Codex harness invocation still passes the deprecated
`--full-auto` flag (`core/scripts/harness-adapters/codex.ts`). Live Codex CLI
`0.145.0` emits `warning: \`--full-auto\` is deprecated; use \`--sandbox
workspace-write\` instead.` on plan-review, review rounds, pre-merge delta
review, shipcheck, and eval cells. When Codex removes the alias, the secondary
review harness and every other Codex-backed stage break.

## What Changes

- Replace the managed-sandbox Codex argv token `--full-auto` with the
  non-deprecated equivalent verified against the installed CLI:
  `--sandbox workspace-write` (two argv elements after `exec`).
- Preserve effective sandbox + non-interactive approval behavior that
  `--full-auto` provided today. Verified on `codex-cli 0.145.0`:
  - `codex exec --sandbox workspace-write` session header:
    `approval: never`, `sandbox: workspace-write` (matches `--full-auto`)
  - `codex exec -a never` / `--ask-for-approval never` is **rejected** by the
    CLI — the adapter must **not** emit those tokens after `exec`
  - Headless never-ask is the `codex exec` path default; it is not a separate
    post-`exec` flag on this version (see design.md verification table)
- Leave the `PIPELINE_CODEX_NO_SANDBOX=1` /
  `sandboxMode: "external-bypass"` path on
  `--dangerously-bypass-approvals-and-sandbox` unchanged, and mutually exclusive
  with both the managed sandbox pair and any approval-policy arguments.
- Update golden-argv / harness regression tests that pin `--full-auto`, and
  adapter/header comments that document the old flag (`codex.ts`, `harness.ts`,
  related docs that state the production invocation).
- Update living-spec scenarios that hard-code `--full-auto` in argv examples so
  they match the post-migration shape (including explicit "no approval-policy
  tokens after `exec`" and bypass mutual exclusivity).
- **File and link** a follow-up GitHub issue for deferred isolation-posture
  honesty (ambient env demotion, `capabilities.sandbox` axis, least-privilege
  defaults) — do not leave that residual as unnumbered prose.

**Not in this change (follow-up issue to file):** broader isolation posture
honesty called out in architectural review — ambient `PIPELINE_CODEX_NO_SANDBOX`
demotion when `sandboxMode` is unset, `capabilities.sandbox: false` vs a
separate Codex sandbox axis, and product default least-privilege redesign. This
issue is the live-defect flag migration only.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `cli-harness-adapters`: managed-sandbox Codex argv replaces deprecated
  `--full-auto` with `--sandbox workspace-write` while keeping
  external-bypass and ambient-env selection semantics; golden-argv pins the new
  shape and forbids reintroduced `--full-auto` and rejected approval-policy
  tokens after `exec`.
- `configurable-review-harness`: built-in codex invocation scenario no longer
  requires `exec --full-auto`; it requires the non-deprecated managed-sandbox
  shape.
- `plan-review-effort-controls`: codex argv examples replace `--full-auto` with
  the managed-sandbox pair so effort-control placement stays accurate.

## Impact

- `core/scripts/harness-adapters/codex.ts` — managed-sandbox argv + header
  comments (document verified approval equivalence)
- `core/scripts/harness.ts` — header / option comments naming `--full-auto`
- `core/scripts/harness-adapters/types.ts` (comments only, if they name
  `--full-auto`)
- `core/test/harness.test.ts` (and any other golden-argv pins of `--full-auto`)
- Operator docs that state the production codex flags (`README.md` harness
  sandbox section, config schema comments) so they stop teaching the deprecated
  flag
- Living specs listed above (via this change's deltas; archive later)
- `plugin/` regenerated mirror after `core/` edits (`node scripts/build.mjs`)
- New follow-up GitHub issue (filed during implement) for isolation-posture work

**Out of scope:** changing when ambient bypass applies; flipping
`capabilities.sandbox`; altering Claude argv; adding a new config key; merge
authority; inventing post-`exec` approval flags the CLI rejects.

## Acceptance criteria

- [ ] Managed-sandbox Codex invocations (no ambient bypass, no
      `sandboxMode: "external-bypass"`) pass consecutive `--sandbox` +
      `workspace-write` and do **not** pass `--full-auto`, `-a`, or
      `--ask-for-approval`.
- [ ] External-bypass path (`PIPELINE_CODEX_NO_SANDBOX=1` when no explicit mode,
      or `sandboxMode: "external-bypass"`) still passes only
      `--dangerously-bypass-approvals-and-sandbox` as the sandbox/approval
      selector — no `--full-auto`, no `--sandbox`/`workspace-write`, no `-a` /
      `--ask-for-approval` on that path.
- [ ] Explicit `sandboxMode: "managed"` still wins over ambient
      `PIPELINE_CODEX_NO_SANDBOX=1` and uses the new managed-sandbox flags.
- [ ] Effective behavior for managed mode matches pre-migration `--full-auto`
      on installed CLI: session-equivalent `approval: never` +
      `sandbox: workspace-write` (verified in design.md for `codex-cli 0.145.0`;
      re-check if host version differs). No interactive approval prompt is
      introduced on the headless path, and no rejected approval flag is added.
- [ ] Golden-argv / harness tests cover at least: default managed, explicit
      managed overriding ambient bypass, ambient bypass, explicit bypass, and
      reasoning-effort placement. Managed-vs-bypass comparison strips the
      multi-token managed sequence. Every managed and bypass case fails if
      `--full-auto` returns.
- [ ] Adapter and harness header comments (and high-traffic operator docs that
      document the codex production argv) no longer present `--full-auto` as the
      current invocation; comments document the verified never-ask equivalence.
- [ ] Spec deltas for `cli-harness-adapters`, `configurable-review-harness`, and
      `plan-review-effort-controls` pass `openspec validate
      codex-full-auto-flag-migration` and assert the full managed sequence plus
      bypass mutual exclusivity (including no approval-policy tokens after
      `exec`).
- [ ] After `core/` edits, `plugin/` is regenerated; `node scripts/build.mjs
      --check` and `npm run ci` pass.
- [ ] Broader ambient-env demotion / capability-bit least-privilege redesign is
      **not** silently implemented here; a follow-up GitHub issue is **filed and
      numbered** in the PR description and design residual risks (not merely
      described as "tracked").
