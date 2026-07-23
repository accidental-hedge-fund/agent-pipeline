## Context

The in-repo durable loop engine (#508, capability `durable-loop-engine`) already models bounded
recovery: a per-item `blocked_theme`, `recovery_budgets` keyed by that free-text theme with a
`default` fallback, a `consecutive_blocked_limit`, and a `LoopStopRecord` with reasons
`recovery_exhausted | consecutive_blocked`. What it lacks is *typed* diagnosis: the theme is
arbitrary, so an unrecognized blocker can be retried under an invented key, and nothing detects an
item re-blocking on the *same* evidence. Issue #509 ports goal-loop#1's typed hard-block
classification and machine-readable recovery policy onto this substrate.

This is a spec-only step. The decisions below fix the contract the implementation will honor.

## Goals / Non-Goals

**Goals**
- A closed, machine-readable blocker taxonomy and a validated per-class recovery policy.
- Fail-closed behavior for unknown/ambiguous blockers and for repeated no-progress evidence.
- Authority-safe recovery that reinforces, never bypasses, the existing four authority gates.
- Durable, event-emitting persistence of classification, actions, evidence, and outcome.

**Non-Goals**
- No change to the per-item advance state machine's `BlockerKind` / `BLOCKER_RECIPES`
  (capability `blocked-recovery-recipes`); that governs a single issue's blocked comment, a
  distinct surface from the durable *run* engine.
- No auto-merge, auto-release, auto-deploy, or credential automation — recovery never crosses an
  authority gate (golden rule #4).
- No external reads during recovery; the engine keeps its injected-seam, no-network discipline.

## Decisions

### Blocker class is the budget key; theme becomes the class name
Rather than add a parallel field, the recorded `blocked_theme` is redefined to be the
`DurableBlockerClass` member name. This keeps the existing `recovery_budgets` map and the
budget-charging requirement intact in shape (still "keyed by theme, default fallback") while making
the key typed and closed. The `durable-loop-engine` recovery-budget requirement is updated to say
the key is the classification. Legacy goal-loop import (`loop/import.ts`) maps an imported theme
onto its class, so imported runs remain readable.

### Recovery policy compiled into the contract, fail-closed
The policy — `class → { recipes[], retry_budget, backoff, terminal_outcome, run_fatal }` — is
compiled into `LoopContract` at init. Compilation refuses a policy missing any class, referencing a
recipe a class does not permit, or otherwise malformed. There is deliberately **no** open default
for a missing class: a gap fails compilation. This mirrors the `BLOCKER_RECIPES`-covers-every-kind
discipline already used in `blocked-recovery-recipes`, and is drift-guarded by a runtime test
(types are stripped, not checked — CLAUDE.md build note).

### Evidence fingerprint = pure function over normalized evidence
Fingerprints are produced by an exported pure function so they are unit-testable without git or
network, matching the `blocker-worktree-disclosure` pattern (pure render function) and the
injected-seam testing rule. The engine counts consecutive same-fingerprint blocks per item; the
policy's `repeated_evidence_limit` bounds them independently of the class budget, so identical
evidence cannot silently drain a budget. A differing fingerprint resets the count — the analogue of
"forward progress resets the consecutive-blocked count" already in the engine.

### Two independent stop guards
Recovery-budget exhaustion and repeated-evidence are *separate* terminal-stop conditions, layered
on top of the existing `consecutive_blocked_limit`. A run can stop for any of the three. Unknown /
ambiguous classification is a fourth, fail-closed, needs-human stop. All reuse the existing
`LoopStopRecord` / stop-class-failure machinery (extended with the new reasons) so a stopped run
still refuses every further transition.

### Authority classes route to humans
`missing-authority` and `specification-decision` have no automated recipe; their policy outcome is
a terminal human-authority stop. This is the spec-level expression of "recovery never bypasses
merge, release, credential, or product-decision authority," and it composes with — does not
replace — the engine's compile-time authority gates.

### Independent-item continuation gated by `run_fatal`
Each class's policy marks the block `run_fatal` or not. A non-run-fatal block lets a
dependency-independent eligible item proceed (subject to the unchanged single-active-item and
merge-barrier invariants); a run-fatal block stops the whole run. This keeps the "allow independent
eligible items to continue when policy permits" criterion explicit and policy-driven rather than ad
hoc.

## Risks / Trade-offs

- **Taxonomy completeness.** Eight classes may not cover a future failure shape. Mitigation: the
  fail-closed path means an unmapped blocker stops for a human rather than mis-recovering — the safe
  direction — and adding a class is a localized enum + policy-entry change guarded by the
  every-class-covered test.
- **Fingerprint normalization is judgment.** Over-normalizing merges distinct failures (masks a
  real second bug); under-normalizing lets a cosmetically-different repeat escape the bound.
  Mitigation: normalization lives in the pure, tested function with explicit before/after fixtures.
- **Budget re-keying is a breaking internal change.** Existing theme-keyed budgets no longer apply
  by arbitrary string. Mitigation: import maps theme→class; native runs adopt the class key from
  first block.

## Migration

No live durable runs depend on the old free-text theme key at spec time; the import path translates
legacy runs. No data migration script is required — this is additive plus one re-keying, delivered
with the implementation change, not this spec step.
