# Design — scoped finding overrides

## Context

Overrides today live entirely in `review-policy.ts`:

- `parseOverrideArg(arg)` parses `"<key>: <reason>"` → `{ key, disposition, reason }`.
- `overrideComment(...)` renders an audited comment ending in
  `<!-- pipeline-override: <8hex> <disposition> -->`.
- `extractOverrides(comments)` regex-scans those sentinels → `Map<key, disposition>`.
- `partitionFindings(findings, policy, overrides)` consults the map, with the #144
  single-distinct-candidate ambiguity guard, to move overridden findings out of
  `blocking`.

The whole apparatus is key-addressed. The drift problem is structural: the key is a
function of the finding, and the finding's identity is not stable across a
non-deterministic reviewer. Scopes solve it by addressing the *finding's
attributes* (its declared `category`, its `file`) instead of its hash, and by
re-matching every round.

## Decisions

### D1 — Two scope types: `category:<name>` and `file:<path>`

These are exactly the two stable, structured attributes a `ReviewFinding` already
carries (`category?: string`, `file?: string`) that an operator can name from the
review comment without guessing a hash. No new reviewer output is required. Line
ranges and severities are deliberately *not* scope types — they are precisely the
attributes that drift, so scoping on them would reintroduce the problem.

### D2 — Parsing: detect the scope prefix, split scope from reason on the first `": "`

`parseOverrideArg` recognizes a scoped argument when it begins with `category:` or
`file:`. The scope token runs up to the first `": "` (colon-space) delimiter; the
remainder is the reason (which is then run through the existing
disposition-normalization — `deferred [#N]` / `rejected`). Rationale: scope values
themselves contain a colon (`category:rollback-safety`) and file paths can contain
colons on some platforms, so splitting on the *first colon* (today's behavior)
would mis-parse. Splitting the scoped form on the first `": "` is unambiguous
because neither a category name nor a path contains a space, while a reason almost
always begins after `": "`. A bare-key argument (no recognized prefix) keeps the
exact current first-colon parse, so existing keyed overrides are byte-for-byte
unaffected.

The return type becomes a discriminated union so callers can tell a key
disposition from a scoped one:

```
{ kind: "key";   key: string;        disposition; reason }
| { kind: "scope"; scopeType: "category" | "file"; scopeValue: string; disposition; reason }
| { error: string }
```

`scopeValue` is normalized consistently with `findingKey`'s inputs: lowercased
(matching `normalizeFile`); for `category`, lowercased and trimmed.

### D3 — Matching semantics in `partitionFindings`

A new optional argument carries active scopes (parallel to the existing
`overrides` map), e.g. `scopes: Array<{ type, value, disposition }>`.

- **category** — matches when `(finding.category ?? "").toLowerCase().trim()`
  equals the scope value. Findings without a `category` never match a category
  scope.
- **file** — matches when `normalizeFile(finding.file)` either equals the scope
  value or begins with `scopeValue + "/"` (directory-boundary-aware prefix). This
  makes `file:src-tauri/src` cover `src-tauri/src/repo.rs` and `…/lib.rs` but not
  `src-tauri/srcfoo.rs`. Findings without a `file` never match a file scope.

A finding matched by any active scope is pushed to `result.overridden` (with the
scope recorded for the audit/advance comment) and skipped from the
blocking/advisory classification — the same terminal disposition as a key
override.

### D4 — Scopes bypass the #144 ambiguity guard, by design

The ambiguity guard exists because a *key* override is meant to disposition one
finding; if two distinct findings collide on a key, applying the override to both
could wave through a real blocker the operator never saw. A *scope* inverts that
intent: it is explicitly "disposition everything matching." So the guard does not
apply to scopes — all matching findings are overridden, including ones minted after
the scope was recorded. This breadth is the feature (it is what survives drift) and
also its risk; D6 covers making the risk visible.

### D5 — Audit sentinel: a distinct scope marker

Key overrides use `<!-- pipeline-override: <8hex> <disposition> -->`. Scopes use a
distinct, non-overlapping marker so the two extractors can't cross-parse:

```
<!-- pipeline-override-scope: <type>:<value> <disposition> -->
```

`extractOverrides` is extended (or paired with `extractScopedOverrides`) to return
both the key map and the scope list from the same comment scan. The `<type>:<value>`
is round-tripped verbatim, so a later scope sentinel for the same scope wins (same
"human revises a disposition" rule as keys). `overrideComment` gains a scope-aware
form (or a sibling `scopedOverrideComment`) that renders the human-readable block
plus the scope sentinel.

### D6 — Surfacing the breadth in the audit/advance trail

Because a scope can suppress findings the operator never individually inspected,
the all-advisory advance comment (`review-severity-policy`'s "advance comment
records the advisory findings") SHALL list each scope-overridden finding under its
scope, so the issue history shows exactly what the scope swept — not just that a
scope was active. This keeps "rigor over latency": breadth is allowed but never
silent.

### D7 — Auto-resume unchanged

`runOverride` already posts the sentinel, clears `blocked`, and re-enters the
advance loop (`override-auto-resume`). A scoped override reuses that path verbatim;
the only branch is which comment body / sentinel is rendered. No new control flow in
`pipeline.ts` beyond selecting the scoped comment renderer.

## Risks / trade-offs

- **A scope is broad.** It can disposition a genuinely new high-severity blocker in
  the same file/category. Mitigated by D6 (every swept finding is itemized in the
  audit comment) and by the fact that the operator opted into the scope explicitly
  with a reason. Not mitigated by a confirmation prompt — the pipeline is
  non-interactive; the audit trail is the control.
- **Path normalization only lowercases.** Matching inherits `normalizeFile`'s
  behavior (no `./` collapsing, no separator canonicalization). Acceptable because
  the operator copies the `file` value straight from the review comment, which is
  the same string `normalizeFile` sees. If reviewer file strings are later
  canonicalized, scope matching benefits automatically (single source).

## Out of scope

- New reviewer output fields or schema changes (`review-schema.ts` untouched).
- Glob / regex scopes — only equality (category) and directory-prefix (file).
- Severity- or line-range-based scopes (they drift; see D1).
- Any change to how bare-key overrides parse, match, or guard.
