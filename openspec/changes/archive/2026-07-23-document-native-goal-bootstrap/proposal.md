## Why

`pipeline:loop` already *probes* for the engine's built-in autonomous `/goal`
mode and refuses to start without it (`pipeline-loop-facade`), but nowhere do
the operator-facing docs tell an operator **how to actually enter that mode and
launch a durable run**. The bootstrap is a manual, operator-owned two-step —
enter the host's native `/goal` mode, then invoke `pipeline:loop` inside it —
and it must be documented identically for Claude and Codex. Because the same
skill develops itself through this pipeline, an unwritten or over-claimed
bootstrap has already produced confusion: readers assume the skill *detects*
whether `/goal` is active, *invokes* `/goal` itself, or *owns* the run's
lifecycle and completion. None of those are true, and this change writes down
the true contract and guards it against drift.

## What Changes

- Document, on **both** host surfaces (`hosts/claude/SKILL.md`,
  `hosts/codex/SKILL.md`), the canonical operator-owned native `/goal`
  bootstrap for a durable run:
  - **Claude:** run `/goal`, then invoke `/pipeline:loop …` inside that session.
  - **Codex:** run `/goal`, then invoke `$pipeline:loop …` inside that session.
- State the bootstrap's **non-claims** explicitly in the docs: the skill does
  **not** detect host `/goal` state, does **not** recursively invoke `/goal`
  itself, and does **not** control the native session's lifecycle. The engine's
  `/goal` mode is the outer autonomous driver; `pipeline:loop` is the durable
  workload it runs.
- Document that **native completion is a host/user action**: `pipeline:loop`
  reports its own terminal done and reconciliation conditions from the durable
  loop engine, and the operator (or the host's `/goal` mode) ends the native
  session afterward — the skill neither ends the `/goal` session nor merges.
- Add a **drift-guard test** asserting both host docs carry the bootstrap
  sequence with the correct per-host command tokens and the required non-claim
  statements, so the two surfaces cannot silently diverge or regress into an
  over-claim.
- Regenerate the `plugin/` mirror so the documented bootstrap ships to installs.

This is a documentation + drift-guard change only. It adds **no** new runtime
behavior, config key, CLI flag, or state-detection code, and it does not touch
the existing native-`/goal` capability probe.

## Capabilities

### New Capabilities

- `native-goal-bootstrap`: The operator-owned, host-symmetric documentation
  contract for bootstrapping a durable `pipeline:loop` run inside the engine's
  native autonomous `/goal` mode, including its explicit non-claims and the
  host/user ownership of native completion, plus the drift-guard that keeps both
  host surfaces in sync.

### Modified Capabilities

<!-- None. This change adds operator-facing documentation and a drift guard; it
     does not change any existing requirement. The native-`/goal` capability
     probe in `pipeline-loop-facade` is unchanged. -->

## Acceptance Criteria

- [ ] `hosts/claude/SKILL.md` contains a bootstrap subsection that shows the
      operator running `/goal` **then** `/pipeline:loop` (in that order) to start
      a durable run.
- [ ] `hosts/codex/SKILL.md` contains a bootstrap subsection that shows the
      operator running `/goal` **then** `$pipeline:loop` (in that order) to start
      a durable run.
- [ ] Both host docs state that the skill does **not** detect host `/goal`
      state, does **not** recursively invoke `/goal`, and does **not** control
      the native session lifecycle.
- [ ] Both host docs state that native completion is a **host/user action** taken
      after `pipeline:loop` reports its own done and reconciliation conditions,
      and that the skill neither ends the `/goal` session nor merges.
- [ ] A drift-guard test under `core/test/` fails if either host doc drops the
      bootstrap sequence, uses the wrong per-host command token, or omits any of
      the required non-claim statements; the test bites (fails before the docs
      are added).
- [ ] The Codex bootstrap doc reflects that Codex has no documented native `/goal`
      floor and therefore requires the `available` operator attestation, without
      re-specifying the probe's detection logic.
- [ ] `node scripts/build.mjs --check` passes (the `plugin/` mirror carries the
      new Claude-host bootstrap text) and `npm run ci` is green.
- [ ] No new runtime behavior, config key, CLI flag, or `/goal` state-detection
      code is introduced by this change.

## Impact

- **Docs:** `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` (a bootstrap
  subsection each). The generated `plugin/pipeline/SKILL.md` mirror is
  regenerated from the Claude host by `node scripts/build.mjs`.
- **Tests:** a new co-located drift-guard test under `core/test/` asserting the
  bootstrap text and non-claims on both host surfaces.
- **No** changes to engine code, config schema, CLI arguments, or the loop
  preflight/probe. The pipeline still never merges and never ends the native
  `/goal` session.
