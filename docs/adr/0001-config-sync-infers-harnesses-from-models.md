# Config sync infers harness roles from models, never from the host profile

**Status:** Accepted  
**Date:** 2026-08-27 (locked clarification 2026-08-29)  
**Issue:** #1264

Required `harnesses.implementer` / `harnesses.reviewer` is repository execution policy. `pipeline config sync` is the only verb allowed to add a missing required key it can supply.

## Decision

### Exception

`config sync` may proceed when `.github/pipeline.yml` exists and every `severity: "error"` diagnostic is the omitted-role class: the `harnesses` block is absent, or `harnesses.implementer` is omitted, or `harnesses.reviewer` is omitted. Any other error (invalid YAML, unknown key, empty-string role, unknown key inside `harnesses`, conflicting `review_harness` against a declared `harnesses.reviewer`) stays fail-closed and writes nothing. `config validate`, `status`, `doctor`, and execution `resolveConfig()` stay fail-closed on omitted roles.

### Closed migration-only alias table (version 1)

Inference classifies explicit model aliases through a closed, versioned table. It never uses the host profile or runtime family detectors.

| Family | Maps to | Membership |
| --- | --- | --- |
| Claude | `claude` | Exact `sonnet`, `opus`, `haiku`, `claude-fable-5`; any trimmed value that starts with `claude-` |
| Grok | `grok` | Any trimmed value that starts with `grok-` |
| Codex/OpenAI | `codex` | Any trimmed value that starts with `gpt-` |

`auto`, unknown aliases, OpenCode, Pi, and extension names produce no inference. Built-in role names (`claude` / `codex` / `grok`) classify when they appear as `review_harness.command`, not as model ids. A commented `# harnesses:` block is not declared policy.

### Implementer evidence

Examine every explicitly configured `models.planning`, `models.implementing`, `models.fix`, `models.intake`, and `models.sweep` field. Ignore absent fields and explicit `auto`. A missing implementer requires at least one classified non-`auto` value, and every explicit non-`auto` value must map to the same adapter. An unknown explicit non-`auto` value or two classified adapters leave implementer unresolved.

### Reviewer evidence

Examine `models.review` and an explicit `review_harness.command` when present. A built-in command (`claude` / `codex` / `grok`) is classified command evidence. A custom non-empty command satisfies the reviewer role when no classified review-model evidence exists. Classified review-model evidence must agree with classified command evidence. Custom command plus classified review-model evidence is unresolved. A structured `review_harness.model` that is present and not `auto` classifies the same way as `models.review` and must agree with the inferred reviewer.

### Preserve declared roles

Keep every valid explicitly declared `harnesses.implementer` or `harnesses.reviewer` value. Infer only omitted roles. Never overwrite a declared role from models, from `review_harness`, or from the active profile.

### Preview, apply, exit codes

Preview (no `--apply`) prints the complete candidate that includes inferred harness roles and writes nothing (exit 0). `--apply` writes through the existing append-preserving sync path: a missing top-level `harnesses` block is appended; a partial or commented `harnesses` block is rewritten in place. Other top-level keys and operator comments stay unchanged. The candidate must pass full configuration validation before any write.

Failed inference writes nothing, names each unresolved role, and exits 2. Other sync blocks stay at exit 1.

### Diagnostics

A missing-role diagnostic names `pipeline config sync`. A missing-file diagnostic names `pipeline init` only.

### Engine self-host

This repository's `.github/pipeline.yml` ships uncommented `harnesses.implementer` and `harnesses.reviewer`. `npm run ci` runs in-tree `config validate` against that live file and fails on any error diagnostic.

## Considered options

- Fill from profile (rejected: profile is bootstrap, not live workers).
- Append a commented `# harnesses:` block (rejected: comments are not policy once the keys are required).
- Weaken `status` / `doctor` to load without harnesses (rejected: fail-closed stays).
- Reuse `isClaudeOnlyModelAlias` / `mapModelFamily` (rejected: not closed or versioned; later OpenCode/Pi detectors must not widen migration).
- Exit 1 on failed inference (rejected: locked exit 2).
- A generic migratable-key framework (out of scope; the exception stays named and harness-specific).
