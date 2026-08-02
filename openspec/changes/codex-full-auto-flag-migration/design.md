## Context

The Codex adapter's managed-sandbox path still emits the deprecated alias:

```text
codex exec [--json] --full-auto -C <worktreeDir> … -
```

Installed CLI (verified this worktree host):

| Check | Result |
| --- | --- |
| Version | `codex-cli 0.145.0` |
| Deprecation | `warning: \`--full-auto\` is deprecated; use \`--sandbox workspace-write\` instead.` |
| Session under `--full-auto` | `approval: never`, `sandbox: workspace-write` |
| Session under `codex exec --sandbox workspace-write` | `approval: never`, `sandbox: workspace-write` (no deprecation warning) |
| Session under bare `codex exec` (no sandbox flag) | `approval: never`, `sandbox: danger-full-access` |
| `codex exec -a never` / `--ask-for-approval never` | **Rejected** — `error: unexpected argument '-a'/'--ask-for-approval' found` |
| Top-level interactive `codex -a never` | Documented; values include `never` |
| Bypass path | `--dangerously-bypass-approvals-and-sandbox` still documented on `codex exec` |

Issue #613 requires preserving **effective** behavior of `--full-auto` (workspace-write
sandbox **plus** never-ask approval for headless runs). The issue text suggests pairing
`--sandbox workspace-write` with an approval-policy flag; live `codex exec` does not
accept `-a`/`--ask-for-approval` on the subcommand. On this CLI, `codex exec` already
runs with `approval: never` (even when `-c approval_policy=on-request` is attempted), so
the deprecation message's single replacement — `--sandbox workspace-write` — is the
behavior-preserving migration for the adapter's `exec` invocation.

Architectural-review notes (ambient `PIPELINE_CODEX_NO_SANDBOX` demotion,
`capabilities.sandbox: false` honesty, least-privilege product posture) are related but
orthogonal to removing a flag that is about to disappear. They stay out of this design's
goals and are residual risks / follow-ups.

## Goals / Non-Goals

**Goals:**

- Stop emitting `--full-auto` on every managed Codex invocation.
- Emit the verified non-deprecated managed-sandbox argv: `--sandbox` `workspace-write`.
- Keep external-bypass selection (`sandboxMode` / ambient env) and all other argv
  (telemetry, model, effort, `-C`, stdin `-`) unchanged.
- Update golden-argv tests and documentation comments so they pin and teach the new
  shape.
- Keep effective sandbox + never-ask headless behavior equivalent to today's
  `--full-auto` path on `codex exec`.

**Non-Goals:**

- Changing when ambient `PIPELINE_CODEX_NO_SANDBOX` applies.
- Flipping `AdapterCapabilities.sandbox` or making `harness_sandbox` affect Codex.
- Reordering approval/sandbox flags before the `exec` subcommand (`codex -a never exec …`).
- Adding a new config key or operator surface.
- Claude argv changes.
- Redesigning default product isolation posture for least privilege.

## Decisions

### D1 — Managed-sandbox argv is `--sandbox` + `workspace-write` only

**Decision:** In `codexAdapter.buildInvocation`, when not in no-sandbox / external-bypass
mode, push `"--sandbox", "workspace-write"` instead of `"--full-auto"`.

**Rationale:** Matches Codex's own deprecation guidance and the live session parity
check (both shapes report `approval: never` + `sandbox: workspace-write` on
`codex-cli 0.145.0`).

**Alternatives rejected:**

| Alternative | Why not |
| --- | --- |
| `--sandbox workspace-write` **and** `-a never` after `exec` | `codex exec` rejects `-a` / `--ask-for-approval` |
| `codex -a never -s workspace-write exec …` | Changes global option placement, command shape, and every golden test for no gain on `exec` (approval already never) |
| `-c approval_policy=never --sandbox workspace-write` | Redundant on `exec` today; couples argv to a config key that still did not force `on-request` in a probe; prefer the CLI's documented sandbox flag only |
| Keep `--full-auto` until removal | Live deprecation warning on every stage; hard break when alias is deleted |

### D2 — External-bypass path stays a single flag

**Decision:** No change to
`--dangerously-bypass-approvals-and-sandbox` selection via
`sandboxMode === "external-bypass"` or ambient `PIPELINE_CODEX_NO_SANDBOX=1` when mode is
unset.

**Rationale:** Issue requires the bypass path unchanged; #607 precedence rules stay.

### D3 — Golden-argv comparison treats managed sandbox as a multi-token selector

**Decision:** Tests that assert "managed vs bypass differ only in the sandbox-selecting
argument" MUST strip the **sequence** `--sandbox`, `workspace-write` on the managed side
(and the single bypass flag on the other), not a single `--full-auto` token.

**Rationale:** The former alias was one argv element; the replacement is two. A naive
single-token filter would falsely fail the "rest of argv identical" assertion.

### D4 — Spec and comment updates are part of the same change

**Decision:** Update living-spec scenarios and operator/header comments that still name
`--full-auto` as the production managed shape in the same PR as the adapter change.

**Rationale:** Specs and golden tests are the contract; leaving `--full-auto` in
`configurable-review-harness` / `plan-review-effort-controls` would immediately re-flag
the migration as drift.

### D5 — Follow-up, not silent expansion, for isolation-posture honesty

**Decision:** Do not change ambient-env semantics or `capabilities.sandbox` in this
change. Name the residual in Risks and in PR text; file or link a follow-up if one does
not already exist.

**Rationale:** Issue body is a live-defect flag migration; review comments allow a
linked follow-up to keep the change surgical.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| A future Codex version changes `codex exec` default approval away from `never` | Pin managed flags to documented sandbox mode; if approval becomes interactive, re-verify and add whatever `exec` then documents (config override or new flag). Add a short design note in adapter header that approval equivalence was verified for `0.145.0` exec defaults. |
| Golden tests still match `/--full-auto/` | Grep + update all test assertions in `core/test/` that pin the old token. |
| Multi-arg sandbox selector breaks "rest of argv identical" helper | Update filter to drop consecutive `--sandbox` + `workspace-write` (D3). |
| Docs still teach `--full-auto` | Update README harness-sandbox section and config comments that describe production codex argv. |
| Merge collision with #607 / eval argv tests | Coordinate on the same golden-argv files; prefer a single clear managed-shape constant in tests if one already exists. |
| Broader isolation honesty deferred | Residual risk listed explicitly; not a silent claim that product isolation is fixed. |

## Migration Plan

1. Implement adapter argv change + comments.
2. Update golden-argv / harness tests.
3. Update high-traffic docs that document the flag.
4. Regenerate `plugin/` via `node scripts/build.mjs`.
5. `openspec validate codex-full-auto-flag-migration` and `npm run ci`.
6. On merge/archive, living specs pick up the deltas.

**Rollback:** Revert the PR; `--full-auto` still works (with warning) until Codex removes
it. No data migration.

## Open Questions

None blocking implementation. Approval-policy flag pairing was resolved by live CLI
verification (D1): not applicable on `codex exec` for `0.145.0`.

## Residual follow-ups (not this change)

1. Ambient `PIPELINE_CODEX_NO_SANDBOX=1` still demotes isolation when `sandboxMode` is
   unset on ordinary (non-eval) call sites.
2. `capabilities.sandbox: false` while a separate Codex sandbox/bypass axis exists —
   comment honesty only in this change; capability-bit redesign deferred.
3. Default product posture still optimizes for unattended completion over least
   privilege (`harness_sandbox` default false; Codex managed path is workspace-write
   but not a broader isolation redesign).
