## Context

See `proposal.md` for motivation. Incident: install of v1.39.13 onto a 1.38.x consumer (and this engine repo at that tag) made `pipeline status`, `pipeline doctor`, and `pipeline config sync` fail because `.github/pipeline.yml` omitted `harnesses:`. `pipeline init` skips an existing file, so it is not a migration.

**Class vs site (engine-dogfood bar):**

| Question | Answer |
| --- | --- |
| Class | A newly required repository-config key has no migration verb that can run against the pre-key file. Fail-closed load blocks the one command whose job is adding the key. Diagnostics name the requirement, not the remediation. Engine self-host config is not CI-validated, so the break is invisible. |
| Site | `harnesses.implementer` / `harnesses.reviewer` after #1240 / 1.39.x. |
| Shared law | `config sync` is the only verb allowed to see “missing required harness role I can add.” Inference is mechanical from explicit `models:` / `review_harness.command` via a closed table, never from the host profile. Missing-role diagnostics name `pipeline config sync`. Missing file still names `pipeline init`. This repo ships both roles; `npm run ci` validates the live file. |
| Next identical fault | Another required key with no migration MUST extend this same exception + diagnostic + CI-validate pattern. Filling from the profile, commenting a stub block, or weakening `status`/`doctor` is not the class fix. A generic migratable-key framework is out of scope; the exception stays named and harness-specific. |

**Current constraints:**

- `pipeline config` already dispatches before `resolveConfig()` (`needsConfig: false`). The block is inside `syncConfig`: it runs `validateConfig` and returns on any error diagnostic.
- `omittedHarnessRolesMessage` states the requirement and that the profile does not fill live workers. It does not name `pipeline config sync`. `missingPipelineYmlMessage` already names `pipeline init`.
- `buildSyncCandidate` is append-only at top-level YAML keys. A missing `harnesses` block can be appended. A partial `harnesses` block will not gain a nested key by append alone.
- `isClaudeOnlyModelAlias` exists for runtime routing. Locked design uses a separate closed migration-only table so later OpenCode/Pi/extension detectors cannot widen inference.
- This worktree’s `.github/pipeline.yml` already declares `implementer: grok` / `reviewer: codex`. `npm run ci` does not run `config validate` against that file. ADR 0001 exists as a one-paragraph stub.

ADR 0001 remains the governing design record. This document is the implementation map for that ADR plus the 2026-08-29 locked clarification.

## Goals / Non-Goals

**Goals:**

- One named `config sync` exception for omitted required harness roles.
- Deterministic inference from explicit config via a versioned table.
- Actionable missing-role diagnostics.
- Engine self-host file + CI validate so this class cannot land silently again.

**Non-Goals:**

- Profile fallback for live workers.
- Weakening `config validate`, `status`, `doctor`, or execution `resolveConfig()`.
- Inferring OpenCode, Pi, extensions, `auto`, or unknown aliases.
- A generic “any missing required key” migrator.
- Changing `pipeline init` no-clobber.
- Replacing `review_harness` overlay semantics on a complete `harnesses` pair.

## Decisions

### D1: `config sync` is the only verb that may see omitted required harness roles

**Decision:** After `validateConfig`, `syncConfig` partitions error diagnostics. If every error is the omitted-role class (`harnesses` block absent, or `harnesses.implementer` / `harnesses.reviewer` omitted) and YAML/schema otherwise parse, sync continues into inference. Any other error (invalid YAML, unknown key, empty-string role, unknown key inside `harnesses`, conflicting `review_harness` vs declared `harnesses.reviewer`) keeps today’s fail-closed block and exit 1.

`config validate` still reports those omitted-role errors. Execution `resolveConfig()` still throws.

**Rationale:** Locked. The migration verb must run. Every other verb stays fail-closed.

**Alternatives:** Tolerate invalid config on `status`/`doctor` (rejected: fail-closed stays). Make Zod keys required (rejected: collapses missing-file vs missing-key). Fill from profile (rejected: profile is bootstrap, not live workers).

### D2: Closed, versioned, migration-only alias table

**Decision:** Ship a dedicated table constant with an explicit version (start at `1`) next to sync, not a reuse of `isClaudeOnlyModelAlias` / `mapModelFamily`. Classification:

| Family | Maps to | Membership |
| --- | --- | --- |
| Claude | `claude` | Exact `sonnet`, `opus`, `haiku`, `claude-fable-5`; any value whose trimmed form starts with `claude-` |
| Grok | `grok` | Any value whose trimmed form starts with `grok-` |
| Codex/OpenAI | `codex` | Any value whose trimmed form starts with `gpt-` |

No other prefix or exact alias classifies. `auto`, empty, unknown strings, OpenCode, Pi, and extension ids produce no inference. Built-in role names (`claude` / `codex` / `grok`) classify when they appear as `review_harness.command`, not as model ids.

The table is test-pinned. Widening it is a versioned change, not an accidental detector reuse.

**Rationale:** Locked 2026-08-29. Runtime detectors will grow. Migration must not.

**Alternatives:** Reuse `isClaudeOnlyModelAlias` (rejected: not closed/versioned; OpenCode/Pi later). Infer from host profile (rejected). Substring scrapers such as `mapModelFamily` (rejected: too wide, `unknown` fallback).

### D3: Implementer evidence is the five implementer model fields, unanimous

**Decision:** Examine every explicitly configured `models.planning`, `models.implementing`, `models.fix`, `models.intake`, and `models.sweep`. Ignore absent fields and explicit `auto`. Classify each remaining value through the table.

- Zero classified values → implementer unresolved.
- All classified values map to one adapter → that adapter.
- Any unknown explicit non-`auto` value, or two classified adapters → unresolved (conflict). Do not write.

**Rationale:** Locked. One field is enough when it classifies. Disagreement is not majority vote.

**Alternatives:** First-wins (rejected: silent). Ignore unknown siblings if one field classifies (rejected: unknown is a conflict). Include `models.review` (rejected: reviewer evidence).

### D4: Reviewer evidence is `models.review` plus explicit `review_harness.command`

**Decision:**

1. Classify `models.review` when it is explicit and not `auto`.
2. Read explicit `review_harness.command` (string form or object `command`).
3. If command is `claude` / `codex` / `grok`: that is classified command evidence. If model family exists and differs → conflict. Else reviewer = that command.
4. If command is any other non-empty string: it is a custom reviewer. If classified `models.review` exists → conflict (classified model evidence must agree with the inferred reviewer; custom has no family). Else reviewer = the custom command string.
5. If no command: classified `models.review` family becomes the reviewer adapter. Else unresolved.

A structured `review_harness.model` is overlay, not a second implementer-style field list. If present and not `auto`, classify it the same way as `models.review` and require agreement with the inferred reviewer.

**Rationale:** Locked: custom command MAY satisfy reviewer because the role already supports custom commands; classified review-model evidence MUST agree. Fail-closed on custom+classified-model avoids inferring `my-reviewer` while a Claude/Grok/Codex model is also voting.

**Alternatives:** Treat `review_harness` as the live reviewer without `harnesses.reviewer` on the execution path (rejected: #1240). Allow custom command plus classified model (rejected: “must agree”). Infer reviewer from profile (rejected).

### D5: Preserve declared roles; infer only omissions

**Decision:** If `harnesses.implementer` is a non-empty declared string, keep it. Same for `reviewer`. Inference runs only for omitted keys. A commented `# harnesses:` line is not a declaration (YAML has no block). An empty string is a schema error, not an omission; sync stays blocked.

**Rationale:** Locked. Never overwrite operator policy. Never treat comments as policy.

### D6: Inject inferred roles, then reuse append-preserving sync

**Decision:** On successful inference, merge the inferred keys into the in-memory partial, then run the existing render + `buildSyncCandidate` + candidate `validateConfig` + `normalizeForSync` equality path.

- Entire `harnesses` block missing: fresh render contains a complete block; append-only merge appends it. Operator comments and other top-level keys stay byte-identical.
- Partial block (one role present): append-only will not add a nested key. Rewrite only the top-level `harnesses` block so it contains the declared role plus the inferred role, leaving every other top-level block untouched.

Preview (`--apply` absent) returns the complete candidate and writes nothing. `--apply` writes only after the candidate passes full validation, including both required roles.

Failed inference: `ok: false`, no candidate write, diagnostics name each unresolved role, CLI exit 2 (distinct from other sync blocks at exit 1).

**Rationale:** Locked: preview shows the complete candidate; `--apply` uses existing append-preserving behavior; candidate then gets full validation. Partial-block rewrite is the minimum extra write the append-only helper cannot do.

**Alternatives:** Wholesale re-render (rejected: #504 comment preservation). Skip the effective-change guard entirely (rejected: it still protects unrelated keys). Exit 1 on failed inference (rejected: locked exit 2).

### D7: Missing-role diagnostics name `pipeline config sync`

**Decision:** Extend `omittedHarnessRolesMessage` (shared by `resolveConfig` and `validateConfig`) with one line naming `pipeline config sync`. `missingPipelineYmlMessage` still names `pipeline init` only.

**Rationale:** Locked. The reporter had to find SKILL.md.

**Alternatives:** Only change the `config sync` blocked banner (rejected: `status`/`doctor` are what operators run first). Name `pipeline init` for missing roles (rejected: init will not edit an existing file).

### D8: Engine file + CI validate

**Decision:** Keep or add uncommented `harnesses.implementer` and `harnesses.reviewer` in this repo’s `.github/pipeline.yml` (already present on current main: `grok` / `codex`). Add a `npm run ci` step that runs `validateConfig` / `pipeline config validate` against that live file and fails the gate on any error diagnostic. Do not depend on a globally installed `pipeline` binary; invoke in-tree.

**Rationale:** Locked remedy 3. Unit fixtures cannot catch the engine file drifting.

**Alternatives:** Trust the existing file without CI (rejected: this class was invisible). Validate a copied fixture (rejected: not the live file).

### D9: Expand ADR 0001 in the same change

**Decision:** Replace the stub paragraph in `docs/adr/0001-config-sync-infers-harnesses-from-models.md` with the locked rules (exception, table, evidence, preserve-declared, exit 2, diagnostics, CI). Do not add a second ADR.

**Rationale:** Issue and 2026-08-29 lock name ADR 0001 as the governing record.

## Risks / Trade-offs

- **Wrong adapter inferred from a coincidental model prefix.** → Mitigation: closed prefixes only (`claude-` / `grok-` / `gpt-`); unknown and conflict fail closed; no write.
- **Partial `harnesses` block cannot be completed by append-only merge.** → Mitigation: D6 rewrites only that top-level block.
- **Custom reviewer plus `models.review: sonnet` cannot migrate.** → Mitigation: fail closed with named `harnesses.reviewer`; operator sets the key. Prefer that over averaging custom vs Claude.
- **Exit 2 vs existing exit 1 for other sync blocks.** → Mitigation: tests pin both; CLI maps an inference-failure result flag, not every `ok: false`.
- **Engine file already has roles, so remedy 3 looks like a no-op.** → Mitigation: CI validate still catches a future deletion; tests assert the live file and the ci script.

## Migration Plan

1. Consumers with unambiguous `models:` run `pipeline config sync --apply`.
2. Consumers with `auto` / unknown / conflicting models add both keys by hand, then `config validate`.
3. Repos with no file still run `pipeline init`.
4. Rollback: revert the engine. A file that already received inferred keys remains valid under #1240.

## Open Questions

None. Exception, table, evidence, exit 2, diagnostics, and CI are locked.
