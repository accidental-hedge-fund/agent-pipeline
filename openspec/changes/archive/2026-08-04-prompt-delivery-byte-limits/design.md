## Context

#492 moved large-prompt delivery for `claude` / `codex` / `grok` onto stdin or prompt-file
channels and added a pre-spawn `runCapped` guard that refuses any argv element ≥
`MAX_ARG_STRLEN` (131,072). That guard still fires **inside** the spawn path after the stage has
already assembled work and (often) advanced labels.

`pi` and `opencode` remain argv-only because their documented headless interfaces do not offer a
message-replacing stdin or prompt-file channel (`@file` / `-f` attach content *alongside* a
message). Assigning either adapter to review/fix roles that materialize >128 KiB prompts fails
deterministically — today only when `runCapped` refuses or the OS returns `E2BIG`.

#783 added `AdapterExtensionDeclaration.prompt.{delivery,sizeLimit}` where `sizeLimit` is the
coarse enum `"max-arg-strlen" | "unlimited"`. #779 asks for an explicit **byte** capability on
`AdapterCapabilities` (`maxPromptBytes`) and for **preflight** enforcement against the
**materialized** prompt, with doctor visibility. The recommendation upsert keeps this as a
**generic delivery-channel capability for every adapter**, not a Pi/OpenCode exception, and
aligns enforcement with #636’s preflight-before-invoke surface.

## Goals / Non-Goals

**Goals:**

- Every adapter declares a delivery-channel byte limit: finite positive integer, unlimited, or
  unknown.
- Stage dispatch measures the fully materialized prompt (UTF-8) and refuses finite-limit
  overruns **before** spawn with a typed capability refusal + remediation.
- Doctor reports declared limits for assigned adapters and fails closed on missing/incoherent
  declarations.
- Declaration vocabulary (`declaration.prompt`) stays lockstep with the capability (no dual
  truth).
- Re-verify and document upstream delivery options for `pi`/`opencode` in adapter headers.
- Preserve the #492 `runCapped` argv guard as residual safety.

**Non-Goals:**

- Shrinking or changing prompt content.
- Implementing stdin/file for CLIs that do not document it.
- Making #602 eval inventory a production gate.
- Full #738 verification-policy negotiation beyond keeping the field shape consumable.

## Decisions

### 1. `maxPromptBytes` is a generic `AdapterCapabilities` field for every adapter

Shape (intent; exact TypeScript encoding chosen at implementation as long as semantics hold):

- **finite**: positive integer — maximum UTF-8 byte length of the prompt payload the delivery
  channel can accept.
- **unlimited**: stdin/file (or equivalent) channels with no practical OS single-argument ceiling
  for the prompt itself.
- **unknown**: only when an extension cannot honestly claim a bound (must still fail closed under
  stage dispatch when a concrete comparison is required — see decision 4).

Rationale: the recommendation upsert forbids treating this as a Pi/OpenCode-only flag. Capability
negotiation (#738) and doctor/eval surfaces need one vocabulary for all adapters.

**Alternative rejected:** only enriching `declaration.prompt.sizeLimit` without a capabilities
field — stages already consult `AdapterCapabilities` for model/effort/sandbox; size belongs on
the same surface operators and preflight already read.

### 2. Keep `declaration.prompt` coherent; derive, do not fork

Today `buildAdapterDeclaration` sets `sizeLimit: promptDelivery === "argv" ? "max-arg-strlen" :
"unlimited"`. Implementation SHALL:

- Derive coarse `sizeLimit` from `maxPromptBytes` + delivery channel (or vice versa from a single
  source of truth), so conformance can assert lockstep.
- For argv adapters, finite `maxPromptBytes` MUST be `< MAX_ARG_STRLEN` when measured for execve
  payload sizing, or equal to the same NUL-aware ceiling the #492 guard uses — pick one rule and
  pin it in tests. Preferred: declare the maximum **prompt string** byte length that is still
  spawnable under the existing `>= MAX_ARG_STRLEN` refuse rule (i.e. `MAX_ARG_STRLEN - 1` if the
  guard rejects at `>=`, matching #492 tests).
- For stdin/file adapters, `maxPromptBytes` is unlimited and `sizeLimit` remains `"unlimited"`.

**Alternative rejected:** a second independent numeric field on the declaration that can disagree
with capabilities.

### 3. Measure the fully materialized prompt at the shared preflight-before-invoke choke point

After the stage has substituted templates and assembled the final prompt string, and **before**
`invoke` / `runCapped` spawn:

1. Resolve the assigned adapter.
2. Read `maxPromptBytes`.
3. Compute `Buffer.byteLength(prompt, "utf8")` (or equivalent UTF-8 byte length).
4. If finite and `measured > maxPromptBytes` (or `>=` if the declared ceiling is exclusive —
   match the constant and document the comparison in the refusal message), refuse.

Placement preference: a shared helper used by production stage dispatch (review, plan-review,
implement, fix, eval cells that invoke local adapters) so no prompt-bearing path silently skips
the check. `runCapped`’s argv-element loop remains as defense-in-depth for residual argv paths
and multi-arg edge cases, not as the primary operator message.

Failure shape:

- Typed / named capability refusal (distinct from missing-CLI, unauthenticated, unsupported
  model/effort, and from bare `spawn_error`).
- Message MUST include: adapter name, delivery channel (when known), declared limit, measured
  bytes, and remedy (assign a stdin/file-capable adapter; for custom CLI enable stdin delivery;
  do not “retry the same invocation”).

**Alternative rejected:** only relying on the existing `runCapped` oversize_argv flag — it is late
and does not teach operators that the **adapter capability** is the limiting factor.

### 4. `unknown` fails closed at stage dispatch; doctor flags it

- Doctor: missing `maxPromptBytes`, incoherent channel/limit pairs (argv + unlimited; stdin +
  finite MAX_ARG_STRLEN-as-only-story without justification), or `unknown` on an assigned
  production adapter → fail (or warn only for unassigned adapters if doctor skips deep checks —
  match existing unassigned-adapter skip rules, but **assigned** adapters with `unknown` fail).
- Stage dispatch: if the adapter is assigned and limit is `unknown`, refuse before invoke with
  remediation to declare a finite limit or unlimited — never treat unknown as unlimited.

### 5. Doctor reports limits without materializing full stage prompts

Doctor does not assemble review/fix prompts. It:

1. Lists assigned adapters’ `prompt.delivery` + `maxPromptBytes`.
2. Validates declaration coherence (decision 2 / 4).
3. When an assigned adapter has a finite argv-bound limit, emits remediation that production
   review/fix prompts commonly exceed ~128 KiB (cite the #492 class of failure) so operators
   learn before the first large PR.

Optional later (out of scope unless trivial): a synthetic lower-bound sample size check — not
required for #779 if (1)–(3) hold and stage preflight covers real materializations.

### 6. Built-in limit table (intent)

| adapter   | channel | `maxPromptBytes` | notes |
| --------- | ------- | ---------------- | ----- |
| `claude`  | stdin   | unlimited        | #492 |
| `codex`   | stdin   | unlimited        | #492 |
| `grok`    | file    | unlimited        | #492 |
| `pi`      | argv    | finite (`MAX_ARG_STRLEN`-aware) | re-verify header |
| `opencode`| argv    | finite (`MAX_ARG_STRLEN`-aware) | re-verify header |
| custom-reviewer compatibility default argv | argv | finite | stdin option → unlimited |

Exact numeric finite value is single-sourced next to `MAX_ARG_STRLEN` so preflight, declaration,
and tests never drift.

### 7. Upstream investigation for `pi` / `opencode` is documentation, not a channel change

At implementation time (golden rule 5): re-run each CLI’s `--help` / docs for stdin or
prompt-file **replacement** of the message. Record the date and finding in the adapter header
comment. If a real channel appears, a **follow-up** may move delivery; this change only records
the finding and keeps argv + finite limit unless the verified channel is clear and safe.

### 8. Compatibility with #738 / #783

- Field is capability-level and declaration-coherent so negotiation schemas can reference
  `maxPromptBytes` without inventing a parallel name.
- Do not expand scope into full verification-policy negotiation.

## Risks / Trade-offs

- **[Risk] Comparison off-by-one vs `runCapped` (`>=` vs `>`)** → Mitigation: single shared
  constant and one comparison rule; unit tests at boundary values (limit−1, limit, limit+1) for
  both preflight and `runCapped`.
- **[Risk] Missing a call site skips preflight** → Mitigation: shared helper at the harness
  invoke boundary (preferred) or an exhaustive call-site inventory in tasks + regression that
  fails if invoke is reachable without the check for local adapters.
- **[Risk] Doctor noise for intentionally small-prompt argv adapters** → Mitigation: report is
  informational + coherence fail; hard fail on oversize is stage-side with measured size. Doctor
  remediation for argv assignment is explicit but does not block unrelated doctor checks unless
  declaration is incoherent.
- **[Risk] Extension adapters omit the field** → Mitigation: conformance kit + doctor fail closed;
  types alone are not enough (no `tsc`).
- **[Risk] Dual truth between `sizeLimit` enum and `maxPromptBytes`** → Mitigation: derive one
  from the other in `buildAdapterDeclaration`; conformance asserts equality of meaning.

## Migration Plan

1. Add capability + declaration lockstep + conformance tests (red then green).
2. Declare limits on all built-ins and compatibility adapter; update `pi`/`opencode` headers after
   re-verify.
3. Wire stage preflight-before-invoke check + typed refusal.
4. Wire doctor reporting + coherence.
5. Regenerate `plugin/`; run `npm run ci`.
6. No config migration: defaults come from adapters, not pipeline.yml keys.

Rollback: revert the change set; behavior returns to #492-only late refuse (no new preflight).

## Open Questions

- Exact TypeScript encoding of unlimited/unknown (`null` | `{ kind: "unlimited" }` | number) —
  choose the option that stays JSON-serializable for doctor `--json` and extension manifests.
- Whether the shared check lives strictly inside `invoke()` (covers all paths) vs only stage
  preflight wrappers — prefer `invoke()` (or immediately above it) so no path bypasses, while
  still classifying the failure as capability preflight rather than spawn error.
