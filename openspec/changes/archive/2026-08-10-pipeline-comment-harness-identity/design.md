## Context

See `proposal.md` for motivation. Current engine state that shapes the fix:

- Planning stamps `harness:${primary}` for any resolved implementer (`stages/planning.ts`).
- `getHarnessLabel` only accepts `claude` | `codex`, so any other stamp is treated as absent and transition comments fall back to `unassigned`.
- `ensurePipelineLabels` pre-creates only `harness:claude` and `harness:codex`. Missing labels can fail silent add paths.
- `buildTransitionComment` and the blocked-comment body builder append a module-local `COMMENT_FOOTER` hardcoded to the Claude skill string. Other builders already use `cfg.marker_footer` / `cfgFooter`.
- Built-in adapter names are single-sourced as `BUILTIN_ADAPTER_NAMES` (`claude`, `codex`, `grok`, `opencode`, `pi`) in the harness-adapter registry.
- Grok outer host sets `profileDefault: "claude"` and installs by symlink to the Claude skill tree. Profile `markerFooter` is skill-packaging identity, not necessarily the implementer CLI name.

## Goals / Non-Goals

**Goals:**

- Correct harness display for any stamped `harness:<name>` label.
- Label bootstrap covers every built-in (and, where practical, registered) harness name planning may stamp.
- Transition and blocked comment footers follow active config `marker_footer` like other pipeline comments.
- Regression tests lock the #954 behaviors.

**Non-Goals:**

- Changing Grok host `profileDefault` or install symlink semantics.
- Adding `core/profiles/grok.json` or rewriting footer *content* to follow implementer CLI rather than profile.
- Changing attestation markers, audit sentinels, stage graph, or review policy.
- Cross-host label creation races beyond existing `ensurePipelineLabels` idempotency.

## Decisions

### 1. `getHarnessLabel` accepts any non-empty `harness:` suffix

**Choice:** Return the full suffix after `harness:` when present and non-empty. Do not whitelist claude/codex.

**Rationale:** `Harness` is already `string` (adapter-registry validated at config resolve). Planning stamps arbitrary registered primaries. A closed union forced `unassigned` for valid labels.

**Alternatives considered:**

- Whitelist `BUILTIN_ADAPTER_NAMES` only → still drops extension adapters and any future built-in until a second edit.
- Map unknown labels to `unassigned` → preserves the bug class for new harnesses.

**Fallback:** Transition keeps `?? "unassigned"` only when no `harness:` label is present.

### 2. Label bootstrap sources built-in adapter names

**Choice:** `ensurePipelineLabels` creates `harness:<name>` for each entry in `BUILTIN_ADAPTER_NAMES` (via the existing registry export), plus existing stage labels and `blocked`. Prefer the constant over a live registry snapshot so bootstrap does not depend on extension load order or process registration state.

**Rationale:** Planning can stamp any built-in primary. The constant is already the golden single-source for shipped adapters. Extension adapters remain free to have labels created on demand or by a later change; this change closes the known gap for grok/opencode/pi.

**Alternatives considered:**

- Enumerate live `registeredAdapterNames()` at ensure time → includes extensions but couples label bootstrap to load order and test registry mutation.
- Keep hand-listed pairs and add grok only → incomplete for opencode/pi and reintroduces drift.

### 3. Footer from config on every path that used `COMMENT_FOOTER`

**Choice:** Remove (or stop using) the Claude-only `COMMENT_FOOTER` constant. Transition and blocked body builders append `\n\n---\n${cfg.marker_footer}` (trim-consistent with other builders). Pure `buildTransitionComment` gains a footer argument (or cfg fragment) so unit tests inject the expected string without loading full config.

**Rationale:** The defect is the outlier hardcode. Sibling blocked comments share the same constant; fixing only transition would leave one Claude-hardcode path. Profile remains the source of footer *text*.

**Alternatives considered:**

- Footer from implementer harness name → changes identity semantics and conflicts with deliberate Claude profileDefault on Grok host.
- Keep hardcode but also append cfg footer → duplicate/conflicting footers.

### 4. Profile identity content deferred

**Choice:** Document that after this change, a grok-primary run under the claude profile still shows the Claude `markerFooter` string by design (skill packaging identity). Operators who want a Grok skill string need a follow-up profile/host decision, not this correctness fix.

**Rationale:** Mixing install-path identity with implementer CLI would surprise codex/claude dual-role setups and the intentional Grok→Claude skill symlink.

## Risks / Trade-offs

- **[Risk] Unknown/garbage `harness:foo` labels render as `foo`** → Mitigation: only pipeline/config paths should stamp labels; display is observational. Empty suffix still ignored.
- **[Risk] More GitHub labels created on init/advance** → Mitigation: create is idempotent; five built-ins is small; no rename of existing labels.
- **[Risk] Pure `buildTransitionComment` signature change breaks call sites/tests** → Mitigation: update attestation drift-guard and review tests in the same change; keep attestation/sentinel append order.
- **[Risk] Operators still see Claude footer on grok-primary runs** → Mitigation: explicit non-goal; document in proposal/design; optional follow-up issue for `profiles/grok.json`.

## Migration Plan

1. Ship engine change; no repo config migration.
2. First `ensurePipelineLabels` / `pipeline init` / advance after upgrade creates missing `harness:grok|opencode|pi` labels.
3. Existing issues keep current labels; next planning stamp + transition uses fixed parser/footer.
4. Rollback: revert the change; extra harness labels on GitHub are harmless leftovers.

## Open Questions

None that block implementation. Optional product follow-up (not this change): whether Grok host should resolve a dedicated profile with a Grok `markerFooter`.
