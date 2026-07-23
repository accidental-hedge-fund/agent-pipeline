## Context

`pipeline:loop` is the durable multi-item run command. Its preflight already
probes for the engine's native autonomous `/goal` mode and refuses to start
without it (`pipeline-loop-facade` → "SHALL require the host's built-in
autonomous `/goal` mode"). What is missing is operator-facing prose telling a
human how to *start* such a run — and, just as importantly, prose bounding what
the skill does **not** do, because the natural (wrong) reading is that the skill
detects, launches, and owns the `/goal` session.

Issue #514 is deliberately scoped to **documentation and its drift guard**, not
new behavior. The constraints are explicit: do not claim host-state detection,
recursive invocation, or lifecycle control; native completion stays a host/user
action after the durable run reports its own done and reconciliation conditions.

## Goals / Non-Goals

**Goals**
- One symmetric bootstrap subsection on each host surface (`/goal` → host loop
  token), differing only in the command token.
- Explicit non-claims (no state detection, no recursive `/goal`, no lifecycle
  control) and explicit host/user ownership of native completion.
- A drift-guard test that bites, keeping both surfaces honest over time.

**Non-Goals**
- No new runtime code path, config key, CLI flag, or `/goal` detection logic.
- No change to the existing native-`/goal` capability probe or its version-floor
  / attestation semantics — this change *documents the operator workflow around*
  that probe, it does not re-specify it.
- No auto-merge, no session-ending behavior, no recursive invocation. The
  pipeline still stops at `pipeline:ready-to-deploy`.

## Decisions

### New capability rather than folding into `pipeline-loop-facade`

The facade capability already carries the *machine* contract (the probe, the
version floor, the attestation, the preflight ordering). The bootstrap is a
*human-workflow documentation* contract with its own non-claims and its own
drift guard. Keeping it a distinct `native-goal-bootstrap` capability keeps the
issue focused and avoids re-opening the large, hard-won facade requirement set.
The two are complementary: the facade *enforces* `/goal` is present; this
capability *documents how the operator supplies it* and what the skill will and
will not do around it.

### Author on host surfaces, mirror is generated

Per the golden rules, `hosts/claude/SKILL.md` is the authored Claude surface and
`plugin/pipeline/SKILL.md` is its generated mirror; `hosts/codex/SKILL.md` is the
authored Codex surface. The bootstrap subsections are added to the two authored
host files, and `node scripts/build.mjs` regenerates the Claude mirror. The
drift-guard test targets the **authored** host files (`hosts/claude/SKILL.md`,
`hosts/codex/SKILL.md`) so a failure points the operator at the file they edit,
while `build.mjs --check` in CI independently guarantees the mirror carries it.

### Drift guard asserts tokens and non-claims, tolerant on wording

The test asserts, per host: presence of `/goal`, the correct loop token
(`/pipeline:loop` for Claude, `$pipeline:loop` for Codex) documented as the step
that follows `/goal`, and a stable phrase for each of the four disclaimers
(host-state detection, recursive invocation, lifecycle control, host-owned
completion). To avoid a brittle exact-string snapshot, the test matches on
durable keyword anchors (e.g. "does not detect", "does not invoke", "lifecycle",
"host or operator" completion) rather than full sentences, mirroring the
keyword-anchor style used by the existing prompt drift guards
(`prompt-loader.test.ts`). The test must be shown to bite: removing the
bootstrap block from a fixture copy fails it.

### Symmetry check

Beyond per-host presence, the test cross-checks that neither host accidentally
carries the *other* host's token in its bootstrap step, and that both carry the
same set of non-claims — enforcing the "differ only in the command token"
requirement.

## Risks / Trade-offs

- **Wording drift vs. false green:** keyword anchors risk passing on degraded
  prose. Mitigation: anchor on the load-bearing terms (the tokens and the four
  disclaimers) and keep them few and specific; the review layer catches prose
  quality.
- **Over-coupling to file paths:** the test hard-codes the two host SKILL paths.
  That is acceptable and intentional — those paths are stable, golden-rule-named
  surfaces, and a path change is exactly the kind of drift the guard should
  surface.

## Migration

None. Additive documentation plus a new test; no consumer-visible behavior
changes and nothing to migrate.
