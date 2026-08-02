## Context

The Codex adapter's managed-sandbox path still emits the deprecated alias:

```text
codex exec [--json] --full-auto -C <worktreeDir> … -
```

Installed CLI (re-verified on the implementer host before plan revision):

| Check | Result |
| --- | --- |
| Version | `codex-cli 0.145.0` |
| Deprecation | `warning: \`--full-auto\` is deprecated; use \`--sandbox workspace-write\` instead.` |
| Session under `codex exec --full-auto` | `approval: never`, `sandbox: workspace-write` (+ deprecation warning) |
| Session under `codex exec --sandbox workspace-write` | `approval: never`, `sandbox: workspace-write` (no deprecation warning) |
| Session under bare `codex exec` (no sandbox flag) | `approval: never`, `sandbox: danger-full-access` |
| `codex exec -a never` / `codex exec --ask-for-approval never` | **Rejected** — `error: unexpected argument '-a'/'--ask-for-approval' found` |
| Top-level interactive `codex -a never` | Documented on root CLI; values include `never` |
| `codex -a never -s workspace-write exec …` | Works (`approval: never`, `sandbox: workspace-write`) but moves sandbox/approval options **before** `exec`, changing the established `codex exec …` command shape for no behavioral gain on this CLI |
| Bypass path | `--dangerously-bypass-approvals-and-sandbox` still documented on `codex exec` |

Issue #613 requires preserving **effective** behavior of `--full-auto` (workspace-write
sandbox **plus** never-ask approval for headless runs). The issue text suggests pairing
`--sandbox workspace-write` with an approval-policy flag. Live `codex exec` does **not**
accept `-a`/`--ask-for-approval` after the subcommand. On this CLI, every `codex exec`
session reports `approval: never` (including bare exec and the managed sandbox shape), so
the deprecation message's documented replacement — `--sandbox workspace-write` as two argv
tokens after `exec` — is the behavior-preserving migration.

**Verified approval selector for managed mode on `codex exec` 0.145.0:** there is **no**
accepted post-`exec` approval-policy flag. The headless never-ask policy is the `codex exec`
path default, already equivalent under both `--full-auto` and `--sandbox workspace-write`
(session headers match). The adapter therefore **must not** invent `-a never` /
`--ask-for-approval never` after `exec` (CLI rejects them and would break every stage).

Architectural-review notes (ambient `PIPELINE_CODEX_NO_SANDBOX` demotion,
`capabilities.sandbox: false` honesty, least-privilege product posture) are related but
orthogonal to removing a flag that is about to disappear. They stay out of this design's
goals and are residual risks / a **named follow-up to file** (no open issue currently owns
that slice; related but distinct: #618 OS-level eval isolation, #637 eval isolation docs).

## Goals / Non-Goals

**Goals:**

- Stop emitting `--full-auto` on every managed Codex invocation.
- Emit the verified non-deprecated managed-sandbox argv after `exec`:
  `--sandbox` `workspace-write` (two consecutive argv elements).
- Pin (in design, adapter comments, specs, and golden tests) that managed mode does **not**
  emit `-a` / `--ask-for-approval` / `--full-auto`, because those are either rejected or
  deprecated on this path — and that effective approval remains never-ask via the `exec` path.
- Keep external-bypass selection (`sandboxMode` / ambient env) and all other argv
  (telemetry, model, effort, `-C`, stdin `-`) unchanged.
- Keep bypass mutually exclusive with managed sandbox tokens **and** with any approval-policy
  arguments (adapter must not combine them).
- Update golden-argv tests and documentation comments so they pin and teach the new shape.
- Keep effective sandbox + never-ask headless behavior equivalent to today's `--full-auto`
  path on `codex exec` (session-header parity: `approval: never` + `sandbox: workspace-write`).

**Non-Goals:**

- Changing when ambient `PIPELINE_CODEX_NO_SANDBOX` applies.
- Flipping `AdapterCapabilities.sandbox` or making `harness_sandbox` affect Codex.
- Reordering approval/sandbox flags before the `exec` subcommand
  (`codex -a never -s workspace-write exec …`) — rejected alternative (D1).
- Adding a new config key or operator surface.
- Claude argv changes.
- Redesigning default product isolation posture for least privilege.

## Decisions

### D1 — Managed-sandbox argv is `--sandbox` + `workspace-write` only (no post-exec approval flag)

**Decision:** In `codexAdapter.buildInvocation`, when not in no-sandbox / external-bypass
mode, push `"--sandbox", "workspace-write"` instead of `"--full-auto"`. Do **not** push
`-a` / `--ask-for-approval` (or any other approval-policy tokens) on the managed path.

**Rationale:** Matches Codex's own deprecation guidance and live session parity
(both shapes report `approval: never` + `sandbox: workspace-write` on `codex-cli 0.145.0`).
Post-`exec` approval flags are rejected by the CLI.

**Alternatives rejected:**

| Alternative | Why not |
| --- | --- |
| `--sandbox workspace-write` **and** `-a never` after `exec` | `codex exec` rejects `-a` / `--ask-for-approval` — would hard-fail every stage |
| `codex -a never -s workspace-write exec …` | Changes global option placement and the established `codex exec …` shape for no gain on `exec` (approval already never; session identical) |
| `-c approval_policy=never --sandbox workspace-write` | Redundant on `exec` today; couples argv to a config key; prefer the CLI's documented sandbox flag only |
| Keep `--full-auto` until removal | Live deprecation warning on every stage; hard break when alias is deleted |

**Pinned managed shape (production):**

```text
codex exec [--json] --sandbox workspace-write -C <worktreeDir> [-m X] [-c model_reasoning_effort=Y] -
```

### D2 — External-bypass path stays a single mutually exclusive flag

**Decision:** No change to
`--dangerously-bypass-approvals-and-sandbox` selection via
`sandboxMode === "external-bypass"` or ambient `PIPELINE_CODEX_NO_SANDBOX=1` when mode is
unset. That path SHALL NOT also emit `--sandbox` / `workspace-write`, `--full-auto`, or any
`-a` / `--ask-for-approval` approval-policy arguments. Managed and bypass selectors remain
mutually exclusive.

**Rationale:** Issue requires the bypass path unchanged; #607 precedence rules stay; combining
bypass with sandbox/approval selectors would contradict Codex's documented "skip approvals
and sandbox" meaning.

### D3 — Golden-argv comparison treats managed sandbox as a multi-token selector

**Decision:** Tests that assert "managed vs bypass differ only in the sandbox-selecting
argument" MUST strip the **sequence** `--sandbox`, `workspace-write` on the managed side
(and the single bypass flag on the other), not a single `--full-auto` token. Every managed
and bypass case SHALL also assert absence of `--full-auto` and absence of
`-a` / `--ask-for-approval`.

**Rationale:** The former alias was one argv element; the replacement is two. A naive
single-token filter would falsely fail the "rest of argv identical" assertion. Explicit
rejection of reintroduced `--full-auto` and of invented approval flags guards both
regressions the review called out.

**Required golden cases (minimum):**

1. Default managed (no ambient bypass, no explicit mode)
2. Explicit `sandboxMode: "managed"` overriding ambient `PIPELINE_CODEX_NO_SANDBOX=1`
3. Ambient bypass (`PIPELINE_CODEX_NO_SANDBOX=1`, no explicit mode)
4. Explicit `sandboxMode: "external-bypass"`
5. Reasoning-effort placement still immediately before the stdin `-` sentinel on managed path

### D4 — Spec and comment updates are part of the same change

**Decision:** Update living-spec scenarios and operator/header comments that still name
`--full-auto` as the production managed shape in the same PR as the adapter change. Spec
text MUST state (1) the managed two-token sequence, (2) that post-`exec` approval flags are
not emitted, (3) bypass mutual exclusivity, and (4) effective never-ask equivalence via the
verified `codex exec` path — not an unstated claim without evidence.

**Rationale:** Specs and golden tests are the contract; leaving `--full-auto` in
`configurable-review-harness` / `plan-review-effort-controls` would immediately re-flag
the migration as drift. The prior plan's vague "as provided by that CLI's exec path"
wording is replaced by the verification table above and by explicit "SHALL NOT emit
approval-policy flags after `exec`" requirements.

### D5 — Follow-up must be filed and numbered (not "remain tracked")

**Decision:** Do not change ambient-env semantics or `capabilities.sandbox` in this
change. During implementation (or immediately after the PR opens), **file a GitHub issue**
owning the deferred isolation-posture work and link it from the PR description and this
change's residual risks. Working title:

> Codex isolation posture honesty: ambient `PIPELINE_CODEX_NO_SANDBOX` demotion when
> `sandboxMode` is unset, `capabilities.sandbox` vs the separate Codex sandbox axis, and
> least-privilege product defaults

No existing open issue owns that exact slice (#618 is OS-level eval isolation; #637 is eval
docs honesty). "Remain tracked follow-ups" without a number fails this change's own AC.

**Rationale:** Issue body is a live-defect flag migration; review requires a named follow-up
to keep the change surgical without losing the residual risk.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| A future Codex version changes `codex exec` default approval away from `never` | Pin managed flags to documented sandbox mode; adapter header notes verification for `0.145.0`. If approval becomes interactive, re-verify and add whatever `exec` then documents (config override or new flag) in a follow-up — do not invent rejected flags today. |
| Reviewer expects `-a never` in argv | Document live rejection of post-`exec` `-a`; golden tests assert absence so a mistaken "add never-ask flag" PR fails before runtime. |
| Golden tests still match `/--full-auto/` | Grep + update all test assertions in `core/test/` that pin the old token. |
| Multi-arg sandbox selector breaks "rest of argv identical" helper | Update filter to drop consecutive `--sandbox` + `workspace-write` (D3). |
| Docs still teach `--full-auto` | Update README harness-sandbox section and config comments that describe production codex argv. |
| Merge collision with #607 / eval argv tests | Coordinate on the same golden-argv files; prefer a single clear managed-shape constant in tests if one already exists. |
| Broader isolation honesty deferred without an issue number | D5: file and link the follow-up issue in the same PR window. |

## Migration Plan

1. Re-confirm CLI version/flags on the implementer host (task 1.x); if version differs from
   `0.145.0`, re-run the session-header probe and update this table in the PR.
2. Implement adapter argv change + comments (managed sequence only; no approval tokens).
3. Update golden-argv / harness tests (all five cases in D3).
4. Update high-traffic docs that document the flag.
5. Regenerate `plugin/` via `node scripts/build.mjs`.
6. `openspec validate codex-full-auto-flag-migration` and `npm run ci`.
7. File the D5 follow-up issue and link it from the PR + residual risks.
8. On merge/archive, living specs pick up the deltas.

**Rollback:** Revert the PR; `--full-auto` still works (with warning) until Codex removes
it. No data migration.

## Open Questions

None blocking implementation. Approval-policy flag pairing was resolved by live CLI
verification (D1): not applicable as a post-`exec` argv token on `codex-cli 0.145.0`.

## Residual follow-ups (not this change)

1. **#842** — Codex isolation posture honesty: ambient `PIPELINE_CODEX_NO_SANDBOX=1`
   still demotes isolation when `sandboxMode` is unset on ordinary (non-eval) call sites;
   `capabilities.sandbox: false` while a separate Codex sandbox/bypass axis exists;
   default product posture still optimizes for unattended completion over least privilege.
2. Related but not the same work: #618 (OS-level eval-cell isolation), #637 (honest eval
   isolation docs).
