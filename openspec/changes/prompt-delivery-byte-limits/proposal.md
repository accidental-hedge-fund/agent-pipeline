## Why

`pi` and `opencode` deliver prompts only as a positional argv element (`promptDelivery: "argv"`).
Linux refuses any single argv element ≥ 131,072 bytes (`MAX_ARG_STRLEN`), and the harness already
guards that case inside `runCapped` (#492). Review and fix prompts already exceed 128 KiB in
production, so assigning either adapter to a large-context role fails deterministically mid-stage —
often after the stage has already begun — with a spawn-adjacent refusal rather than a capability
preflight that names the adapter, the limit, the measured size, and the remedy. Nothing today
declares a delivery-channel byte limit on `AdapterCapabilities` or checks the fully materialized
prompt against that limit before dispatch.

## What Changes

- **Declare `maxPromptBytes` on every adapter.** Extend `AdapterCapabilities` with a generic
  delivery-channel size capability every adapter must set: a finite positive byte limit, unlimited,
  or unknown. Keep the shape compatible with the #783 extension declaration vocabulary
  (`declaration.prompt` delivery + size/limit policy) and with future capability-negotiation
  consumers (#738) — this is not a Pi/OpenCode exception field.
- **Preflight the materialized prompt before invoke.** Stage dispatch (the shared preflight-before-
  invoke surface associated with #636) measures UTF-8 byte length of the fully materialized prompt
  and, when the assigned adapter declares a finite limit that the prompt exceeds, refuses with a
  typed capability failure that names the adapter, the declared limit, the measured size, and a
  concrete remedy — **before** spawn, not as an opaque mid-stage `exit -1`.
- **Doctor surfaces declared limits.** `pipeline doctor` (and run-start doctor when enabled) reports
  each assigned adapter’s declared `maxPromptBytes` / delivery channel, fails closed on missing or
  incoherent declarations (e.g. argv channel without a finite limit), and points operators at
  remediation when an argv-bound adapter is assigned to a role that routinely materializes large
  prompts.
- **Re-verify upstream delivery channels for `pi` and `opencode`.** Re-read each CLI’s documented
  headless interface for stdin or prompt-file channels; record the finding (supported channel or
  “still argv-only”) in that adapter’s header comment. Do **not** invent channels or shrink prompts.
- **Keep the #492 `runCapped` oversize-argv guard** as a last-line defense for any residual argv
  path (custom reviewer CLI, extension adapters). Preflight is the operator-facing gate; the
  spawn guard remains belt-and-braces.

**Non-goals (explicit):**

- Reducing, truncating, or rewriting prompt content.
- Moving `pi`/`opencode` off argv unless their CLIs document another channel (investigation only).
- Changing review rigor, stage selection, merge authority, or verdict schemas.
- Eval-only capability inventory as a production gate (#602 remains adjacent, not this gate).

## Capabilities

### New Capabilities

- (none) — this extends existing harness-adapter and doctor contracts rather than introducing a
  separate product surface.

### Modified Capabilities

- `cli-harness-adapters`: Every adapter SHALL declare `maxPromptBytes` (finite | unlimited |
  unknown) as part of its capability set; stage dispatch SHALL refuse oversize materialized
  prompts against that limit with a typed, remediated capability failure before invoke; built-in
  adapters SHALL keep declaration.prompt size policy in lockstep with the capability; `pi` and
  `opencode` header comments SHALL record the re-verified upstream delivery-channel finding.
- `doctor-preflight`: Doctor and run-start preflight SHALL report assigned adapters’ declared
  prompt-delivery byte limits, fail on missing/incoherent declarations, and remediate
  argv-bound assignments that cannot accept production-scale prompts.
- `adapter-extension-registry`: The public extension declaration’s prompt size/limit policy SHALL
  remain coherent with `maxPromptBytes` (same vocabulary, no second conflicting enum); the
  shared conformance kit SHALL reject adapters that omit the capability or declare a channel/
  limit pair that cannot hold.

## Impact

- `core/scripts/harness-adapters/types.ts` — `AdapterCapabilities.maxPromptBytes`, declaration
  builders / conformance, capability helpers
- Built-in adapters (`claude`, `codex`, `grok`, `pi`, `opencode`) and the custom-reviewer
  compatibility adapter — declare limits; `pi`/`opencode` header comments updated from re-verify
- `core/scripts/harness.ts` and/or shared stage preflight-before-invoke path — materialized-prompt
  byte check with typed refusal
- `core/scripts/stages/doctor.ts` — surface limits and declaration coherence
- Unit tests with injected deps (no real network/git/subprocess); golden/conformance coverage
- Regenerated `plugin/` mirror after `core/` edits; `npm run ci` green
- No change to prompt templates, review policy, or merge path

## Acceptance criteria

Observable, falsifiable outcomes that make #779 done:

- [ ] Every registered adapter (built-in + compatibility path) exposes a `maxPromptBytes`
      capability value that is one of: a finite positive byte count, unlimited, or unknown —
      enforced by the shared conformance kit (incomplete declaration fails the kit by name).
- [ ] `pi` and `opencode` declare a finite `maxPromptBytes` consistent with argv delivery and
      `MAX_ARG_STRLEN` (NUL-aware), and their header comments record a re-verified finding on
      whether stdin/prompt-file delivery exists upstream.
- [ ] `claude`, `codex`, and `grok` declare unlimited (or an equivalent non-argv ceiling) consistent
      with their stdin/file channels.
- [ ] When stage dispatch materializes a prompt whose UTF-8 length exceeds the assigned adapter’s
      finite `maxPromptBytes`, the pipeline refuses **before** spawn with a typed capability
      failure that names the adapter, the declared limit, the measured size, and a remedy (e.g.
      use a stdin/file-capable adapter or raise the delivery channel) — not a bare `exit -1` /
      mid-stage opaque spawn death.
- [ ] A prompt at or under the declared finite limit is not refused by this new check solely for
      size (existing stage/harness behavior otherwise unchanged for under-limit prompts).
- [ ] `pipeline doctor` reports declared delivery channel + `maxPromptBytes` for assigned adapters,
      fails on missing/incoherent declarations, and includes remediation text when an argv-bound
      adapter is assigned despite the hard ceiling.
- [ ] The public extension declaration (`declaration.prompt` size/limit policy) stays coherent with
      `maxPromptBytes` — no dual conflicting sources of truth; conformance covers the lockstep.
- [ ] The existing #492 `runCapped` oversize-argv guard remains as a residual safety net and is not
      removed.
- [ ] Unit/regression tests cover: declaration required; finite-limit refusal with measured size;
      unlimited adapters not refused by size alone; doctor coherence failure; conformance kit bite.
- [ ] `npm run ci` is green and `plugin/` is regenerated in the same change set as any `core/` edits.
