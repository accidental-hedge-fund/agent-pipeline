## Why

`--override "<key>: <reason>"` keys on an 8-hex per-finding fingerprint
(`findingKey`, see `stable-finding-identity`). Even with #144's location-addressed
key and #228's verdict cache, those keys still **drift on re-review**: the reviewer
is non-deterministic, so the same conceptual concern can come back at a different
line band, a different severity, or as a freshly-minted finding under a new key.
When that happens the documented manual-unblock path becomes unreliable —
overriding the current keys and resuming re-reviews and re-parks on keys that did
not exist when the operator triaged (observed in pipeline-desk #90: the run could
not converge by key).

The operator's actual intent is rarely "this one fingerprint" — it is "I have
accepted the rollback-safety concern" or "I am deferring everything under
`src-tauri/src/repo.rs` to follow-up #N". A per-key handle cannot express that, so
a morning triage of parked items degrades into an unwinnable key chase.

## What Changes

Add **scoped override dispositions** that survive re-review, evaluated in
`partitionFindings` alongside the existing key overrides:

```
--override "category:rollback-safety: deferred #N"
--override "file:src-tauri/src/repo.rs: deferred #N"
```

A scoped override moves *any* finding matching the scope — by structured
`category`, or by file path / directory prefix — into the overridden (advisory)
set, regardless of its per-finding key, on **every** (re-)review. Because the
match is recomputed against the live verdict each round, it is immune to key
drift: a re-worded, re-located, or newly-minted finding that still falls in the
scope is still dispositioned. Scoped dispositions are recorded with the same
audited-sentinel mechanism as key overrides and feed the same auto-resume path
(`override-auto-resume`). Bare-key overrides keep their exact current behavior,
including the #144 single-candidate ambiguity guard.

This is intentionally a broad instrument: a scope suppresses *new* blockers in
that category/path too. That is the operator's explicit, audited choice — the
trade is reliability of the unblock path against the precision of a per-finding
key, and the scope, disposition, reason, and recording account are all visible on
the issue.

## Capabilities

### Modified Capabilities
- `review-severity-policy`: the audited-override capability gains scoped (category
  and file/path-prefix) dispositions in addition to per-finding-key dispositions.
  Scoped dispositions are key-independent, re-evaluated every round, recorded via a
  distinct audited sentinel, and bypass the per-key ambiguity guard (by design,
  since a scope is meant to match more than one finding).

## Acceptance criteria

- [ ] `parseOverrideArg` accepts `category:<name>` and `file:<path>` in the same
      argument position as a bare key, returning a scoped disposition (scope type +
      value + normalized disposition + reason) rather than a key disposition; a bare
      8-hex key continues to parse exactly as before.
- [ ] An empty scope value (`category:` / `file:` with nothing after the prefix) or
      an empty reason is rejected with a usage error and posts nothing.
- [ ] `partitionFindings` moves **every** finding whose `category` equals a
      `category:<name>` scope (case-insensitive) into the overridden set, regardless
      of each finding's `findingKey`.
- [ ] `partitionFindings` moves **every** finding whose normalized `file` equals or
      is a directory-prefix of a `file:<path>` scope into the overridden set,
      regardless of each finding's `findingKey`; a non-boundary string prefix
      (`src/repo` vs `src/report.rs`) does NOT match.
- [ ] Scoped overrides are re-applied on every (re-)review, so a finding that drifts
      to a new key but stays within the scope remains overridden across rounds.
- [ ] Scoped overrides do not invoke the per-key single-candidate ambiguity guard:
      two or more distinct findings matching one scope are all overridden.
- [ ] A scoped override posts an audited comment carrying a scope sentinel that
      `extractOverrides` (or its scoped counterpart) reads back on subsequent reviews,
      recording the scope, disposition, reason, stage, and timestamp.
- [ ] Recording a scoped override clears `blocked` and re-enters the advance loop the
      same way a key override does (`override-auto-resume`), with no manual re-run.
- [ ] The `core/` change is mirrored to `plugin/` via `node scripts/build.mjs` in the
      same commit, and `npm run ci` passes.
- [ ] Unit tests cover: scope parsing (both types + rejection), category match,
      file-prefix match with directory-boundary semantics, key-independence across a
      simulated re-review, and the ambiguity-guard bypass.
