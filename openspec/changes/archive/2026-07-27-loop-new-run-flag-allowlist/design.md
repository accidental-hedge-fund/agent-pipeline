## Context

The production fix is one line. The only real decision is how to guard the drift class so the same
defect cannot recur silently for the next `loop:` option, without weakening the registry's
deliberate allowlist posture.

## Decisions

### Fix at the registry, not at the validator

Add `"newRun"` to `COMMAND_REGISTRY.loop.allowedFlags`.

Rejected alternative: adding `newRun` to `UNIVERSAL_FLAGS`. That set exists for flags the *host
wrapper* injects unconditionally (`profile`), and its own comment names itself the single
authoritative source for that exemption. `--new-run` is operator-chosen and loop-specific;
exempting it universally would let it leak onto `merge` and every other allowlisted command —
precisely the leakage the allowlist design prevents.

Rejected alternative: giving `loop` `allowedFlags: "all"`. That would silently accept every future
global flag on a command that drives durable run state. The allowlist is the feature, not the bug.

### Guard direction: `loop:`-namespaced options must be allowlisted

The existing cross-check (test 2.7) asserts allowlist ⊆ registered options. It is blind to the
inverse — a registered option missing from an allowlist — which is exactly what happened here.

A fully general inverse guard is impossible: most global options are intentionally absent from most
allowlists. But the loop options are already self-labelling — their help descriptions are prefixed
`loop:` (`--range`, `--roadmap-slice`, `--resume`, `--audit`, `--new-run`). Using that prefix as the
membership predicate gives a precise, cheap guard with no false positives: an option is claimed for
`loop` in its own user-facing help text, so it must be accepted by `loop`.

Trade-off: the guard is only as good as the description convention. That is acceptable — the
convention is already uniform across all five loop options, and a future loop option that omits the
prefix is itself a documentation defect worth catching separately. Scoping the guard to `loop`
(rather than generalizing to every `<command>:` prefix) keeps this change surgical; generalizing is
a follow-up if the pattern proves useful.

### No semantic change to supersession

`decideNewRun*`, the run-id minting, the `supersedes` / `superseded_by` pointers, and the
not-terminally-stopped refusal are untouched. This change only removes a gate that fired before any
of that logic ran. The `loop-run-supersession` delta records reachability as a requirement so the
capability's own scenarios are no longer vacuously satisfiable by an unreachable surface.

## Risks

- **Low.** The flag was already registered and already read by `runLoopCommand`; the supersession
  path has its own tests. The exposure is that a previously dead path becomes live — mitigated by
  the fact that its refusal conditions are already specified and tested.
