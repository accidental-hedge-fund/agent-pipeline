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
  `--sandbox workspace-write` (two argv elements).
- Preserve effective sandbox + non-interactive approval behavior that
  `--full-auto` provided today (workspace-write sandbox, never-ask approval for
  `codex exec` — see design.md verification).
- Leave the `PIPELINE_CODEX_NO_SANDBOX=1` /
  `sandboxMode: "external-bypass"` path on
  `--dangerously-bypass-approvals-and-sandbox` unchanged.
- Update golden-argv / harness regression tests that pin `--full-auto`, and
  adapter/header comments that document the old flag (`codex.ts`, `harness.ts`,
  related docs that state the production invocation).
- Update living-spec scenarios that hard-code `--full-auto` in argv examples so
  they match the post-migration shape.

**Not in this change (follow-up):** broader isolation posture honesty called out
in architectural review — ambient `PIPELINE_CODEX_NO_SANDBOX` demotion when
`sandboxMode` is unset, `capabilities.sandbox: false` vs a separate Codex
sandbox axis, and product default least-privilege redesign. This issue is the
live-defect flag migration; those remain tracked follow-ups rather than scope
expansion here.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `cli-harness-adapters`: managed-sandbox Codex argv replaces deprecated
  `--full-auto` with `--sandbox workspace-write` while keeping
  external-bypass and ambient-env selection semantics; golden-argv pins the new
  shape.
- `configurable-review-harness`: built-in codex invocation scenario no longer
  requires `exec --full-auto`; it requires the non-deprecated managed-sandbox
  shape.
- `plan-review-effort-controls`: codex argv examples replace `--full-auto` with
  the managed-sandbox pair so effort-control placement stays accurate.

## Impact

- `core/scripts/harness-adapters/codex.ts` — managed-sandbox argv + header
  comments
- `core/scripts/harness.ts` — header / option comments naming `--full-auto`
- `core/scripts/harness-adapters/types.ts` (comments only, if they name
  `--full-auto`)
- `core/test/harness.test.ts` (and any other golden-argv pins of `--full-auto`)
- Operator docs that state the production codex flags (`README.md` harness
  sandbox section, config schema comments) so they stop teaching the deprecated
  flag
- Living specs listed above (via this change's deltas; archive later)
- `plugin/` regenerated mirror after `core/` edits (`node scripts/build.mjs`)

**Out of scope:** changing when ambient bypass applies; flipping
`capabilities.sandbox`; altering Claude argv; adding a new config key; merge
authority.

## Acceptance criteria

- [ ] Managed-sandbox Codex invocations (no ambient bypass, no
      `sandboxMode: "external-bypass"`) pass `--sandbox` + `workspace-write` and
      do **not** pass `--full-auto`.
- [ ] External-bypass path (`PIPELINE_CODEX_NO_SANDBOX=1` when no explicit mode,
      or `sandboxMode: "external-bypass"`) still passes only
      `--dangerously-bypass-approvals-and-sandbox` as the sandbox selector — no
      `--full-auto`, no `--sandbox workspace-write` on that path.
- [ ] Explicit `sandboxMode: "managed"` still wins over ambient
      `PIPELINE_CODEX_NO_SANDBOX=1` and uses the new managed-sandbox flags.
- [ ] Effective behavior for managed mode matches pre-migration `--full-auto`:
      workspace-write sandbox and non-interactive never-ask approval for
      `codex exec` (verified against installed CLI; see design.md). No new
      interactive approval prompt is introduced on the headless path.
- [ ] Golden-argv / harness tests that previously asserted `--full-auto` assert
      the new managed-sandbox argument sequence (including multi-arg strip when
      comparing managed vs bypass) and fail if `--full-auto` returns.
- [ ] Adapter and harness header comments (and high-traffic operator docs that
      document the codex production argv) no longer present `--full-auto` as the
      current invocation.
- [ ] Spec deltas for `cli-harness-adapters`, `configurable-review-harness`, and
      `plan-review-effort-controls` pass `openspec validate
      codex-full-auto-flag-migration`.
- [ ] After `core/` edits, `plugin/` is regenerated; `node scripts/build.mjs
      --check` and `npm run ci` pass.
- [ ] Broader ambient-env demotion / capability-bit least-privilege redesign is
      **not** silently implemented here; if not fixed, a follow-up issue is
      named in the PR or design residual risks (this AC is about honesty of
      scope, not shipping that redesign).
