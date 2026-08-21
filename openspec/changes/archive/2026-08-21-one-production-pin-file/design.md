## Context

See `proposal.md` for why. Current law and code:

- Pin resolution (`productionPinPath`) already uses override →
  `AGENT_PIPELINE_PRODUCTION_PIN` →
  `<repoDir>/.agent-pipeline/production-engine-pin.json`. `engine-promote`
  writes that one resolved path. It does not dual-write a Hermes-state
  copy.
- Tugboat `export_factory_production_pin` (#1127) exports the
  control-checkout pin **only when the env is unset**. An already-set
  value is left unchanged.
- The in-repo Hermes SKILL
  (`examples/supervisor/hermes/SKILL.md`) already documents the control
  pin and does not default the Hermes-state path. `env.example` does not
  name `AGENT_PIPELINE_PRODUCTION_PIN`. Live Buzz
  `~/.hermes/profiles/pipeline-factory/skills/pipeline-supervisor/SKILL.md`
  still defaulted
  `$HOME/.local/state/hermes-factory/production-engine-pin.json`. That
  pre-set env is what Tugboat treated as an operator override.
- Doctor `install:engine-track` evaluates the **env pin** (when set)
  against the installed engine. It does not fail-closed because the env
  pin and the control-checkout pin disagree. A Buzz ship can therefore
  doctor/promote a second file while the control pin and CLI are already
  current.

**Class vs site (engine-dogfood bar):**

| | |
| --- | --- |
| **Site** | Live Buzz SKILL defaulted Hermes-state pin 1.39.6; Tugboat v1.39.7 ship wrote the control pin; next train warned or failed `install:engine-track`. |
| **Class** | The factory plane has one live production pin file. Host supervisor SKILL/env MUST NOT default a second path. Doctor MUST fail when env pin identity disagrees with the control pin. Promote MUST write exactly one resolved file. |
| **Shared surfaces** | in-repo Hermes SKILL + `env.example`, Tugboat unset-export (#1127), `engine-promote` single-write, factory-plane doctor pin-path check. |
| **Next identical fault** | A later SKILL/env default of the Hermes-state path, a later doctor pass on split pins, or a later promote dual-write fails the same tests. No new mole issue. |

Copying the control pin into
`~/.local/state/hermes-factory/production-engine-pin.json` by hand is
not the class fix.

## Goals / Non-Goals

**Goals:**

- One live pin file on the factory plane: control-checkout pin unless
  the operator explicitly sets the env to that same path (or a file
  whose `version` / `git_sha` agree).
- In-repo supervisor SKILL and `env.example` never default or document
  the Hermes-state path.
- Factory-plane doctor fails (not only warns) when env pin and control
  pin disagree on `version` or `git_sha`.
- Promote writes exactly one resolved file.
- Hermetic tests bite SKILL/env default, doctor pass-on-split, and
  promote dual-write.

**Non-Goals:**

- Hand-editing Hermes-state JSON to catch up as the product path.
- Treating `no-frg-*` pins as production.
- KEY_FILE engine loader (sibling v1.39.8).
- Tugboat skip-train (sibling v1.39.8).
- v1.40.0 packaging / Hermes install pack (v1.40.1 MAY template env;
  it MUST NOT reintroduce a second pin).
- Changing Tugboat preserve-if-set (#1127) into overwrite-always.
- Merge inside advance/loop; `auto_merge`; a merge stage.
- Editing the live `~/.hermes/.../SKILL.md` as the in-repo product
  source (the product owns `examples/supervisor/hermes/SKILL.md`).

## Decisions

### 1. Keep Tugboat preserve-if-set; forbid SKILL default of a second path

**Choice:** Tugboat still leaves an already-set
`AGENT_PIPELINE_PRODUCTION_PIN` unchanged (#1127). The host supervisor
SKILL and `env.example` SHALL NOT assign a default of
`~/.local/state/hermes-factory/production-engine-pin.json`. Unset SHALL
reach Tugboat so it can bind
`$REPO_DIR/.agent-pipeline/production-engine-pin.json`.

**Why not overwrite a set env in Tugboat:** that would break a real
operator override and regress #1127. The class defect is a host default
that masquerades as an operator override.

**Why not dual-write Hermes-state from promote:** that creates two live
pins again. The next host that reads the other file drifts.

**Why not delete the Hermes-state file as the product path:** leftover
host files are not pin authority. Doctor fail-closed on disagreement is
the gate.

### 2. Additive factory-plane doctor check, fail not warn

**Choice:** On the factory plane (`REPO_DIR` is the control checkout),
`pipeline doctor` SHALL run an additive check (stable id in the
`install:` family, for example `install:production-pin-path`) that
compares the env pin file to the control-checkout pin when the env is
set to a **different** resolved path. Status `"fail"` when `version` or
`git_sha` disagree. Status SHALL NOT be `"warn"` or `"pass"` in that
case. Same resolved path, unset env, or matching `version` and
`git_sha`: this check SHALL NOT fail for split-pin disagreement.
Non-factory product repos SHALL skip this check.

**Why not fold only into `install:engine-track`:** that check compares
the resolved pin to the installed engine. With env pin 1.39.6 and CLI
1.39.7 it can fail, but the diagnosis is "install ≠ pin", not "two pin
files disagree". A Buzz host whose CLI still matches the stale env pin
would pass `install:engine-track` while the control pin is already
1.39.7.

**Why fail not warn:** a warning-only envelope is how the next train
proceeds on a second pin. Factory-plane split pins are a configuration
defect.

**Compare fields:** normalized `version` and `git_sha` (40-hex;
missing/null counts as empty). Either field different is disagreement.

### 3. Drift-guard the in-repo SKILL and env.example as the class source

**Choice:** Unit tests SHALL read
`examples/supervisor/hermes/SKILL.md` and
`examples/supervisor/hermes/env.example` (and any product-owned
generated copy under the repo). They SHALL fail if those files default
or document
`~/.local/state/hermes-factory/production-engine-pin.json` or
`$HOME/.local/state/hermes-factory/production-engine-pin.json`.
`env.example` MAY omit the var, or MAY show the control-checkout pin.
It SHALL NOT show a second live path.

**Why not only fix the live `~/.hermes` copy:** that is the site. The
next install pack or SKILL refresh would reintroduce the default unless
the in-repo source and tests forbid it.

v1.40.1 packaging MAY template env from `env.example`. The same drift
guard SHALL fail if that template reintroduces the Hermes-state path.

### 4. Promote single-write stays; test the non-dual-write invariant

**Choice:** Keep `engine-promote` writing `productionPinPath` only. Add
a hermetic test that a successful promote writes the resolved path and
does not write a Hermes-state path.

**Why a test when code already writes one file:** without it, a later
"helpful" dual-write to catch up Hermes is a mole, not a class fix.

## Risks / Trade-offs

- **[Risk]** A real operator override that points at a different file
  with a different `version` / `git_sha` will fail factory-plane doctor.
  → **Mitigation:** that is the intended fail-closed. Remediation is
  unset the env (Tugboat binds control pin) or point the env at the
  control pin (or a file that agrees). Spec this in the check detail.
- **[Risk]** Live Buzz SKILL stays stale until the host refreshes from
  the in-repo source. → **Mitigation:** doctor fail-closed on split pins
  makes the leftover default visible. This change does not hand-edit
  `~/.hermes`.
- **[Risk]** Tugboat preserve-if-set still honors a SKILL-defaulted env
  until the SKILL is refreshed. → **Mitigation:** SKILL drift-guard plus
  doctor disagreement fail. Do not regress #1127.
- **[Risk]** Matching `version` / `git_sha` on two paths still leaves a
  second file. → **Mitigation:** AC fails only on disagreement. SKILL
  default remains forbidden so a second path is not the default. Do not
  dual-write.

## Migration Plan

1. Land in-repo SKILL / `env.example` guards and the doctor check on
   this change.
2. Refresh the factory host SKILL from the in-repo source (host
   deploy). Unset `AGENT_PIPELINE_PRODUCTION_PIN` in the supervisor env
   if it still names the Hermes-state path.
3. Leave `~/.local/state/hermes-factory/production-engine-pin.json` in
   place as a leftover file. Do not treat it as pin authority. Do not
   hand-edit it to catch up.
4. Rollback is revert of this change. Pin files already written stay;
   doctor split-pin fail would go away, which is the defect.

## Open Questions

None. Live `~/.hermes` refresh is host deploy, not a spec fork.
