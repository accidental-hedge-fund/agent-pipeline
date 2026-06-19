## 1. Parse scoped override arguments

- [ ] 1.1 Change `parseOverrideArg` in `core/scripts/review-policy.ts` to return a
      discriminated union: `{ kind: "key", ... }` for bare 8-hex keys (current
      behavior, byte-for-byte) and `{ kind: "scope", scopeType, scopeValue, ... }` for
      `category:<name>` / `file:<path>` arguments.
- [ ] 1.2 Detect the scope prefix (`category:` / `file:`) and split the scope token
      from the reason on the first `": "` delimiter; normalize `scopeValue`
      (lowercase; trim category names) consistent with `normalizeFile`.
- [ ] 1.3 Reject an empty scope value or empty reason with a usage error (return
      `{ error }`); reuse the existing disposition normalization (`deferred [#N]` /
      `rejected`) for scoped reasons.
- [ ] 1.4 Update every `parseOverrideArg` caller in `pipeline.ts` for the new shape.

## 2. Match scopes in `partitionFindings`

- [ ] 2.1 Add an active-scopes parameter to `partitionFindings`
      (`scopes: { type, value, disposition }[]`, default `[]`).
- [ ] 2.2 Implement category matching: `(finding.category ?? "").toLowerCase().trim()`
      equals the scope value.
- [ ] 2.3 Implement file matching: `normalizeFile(finding.file)` equals the scope value
      OR begins with `scopeValue + "/"` (directory-boundary-aware prefix).
- [ ] 2.4 Push every scope-matched finding to `result.overridden` (carry the matched
      scope for the audit comment); ensure scope matching does NOT invoke the per-key
      ambiguity guard. Key-override precedence/behavior is unchanged.

## 3. Audit sentinel + extraction

- [ ] 3.1 Add the scope sentinel `<!-- pipeline-override-scope: <type>:<value>
      <disposition> -->` and a scoped comment renderer (extend `overrideComment` or add
      `scopedOverrideComment`).
- [ ] 3.2 Extend extraction (`extractOverrides` or a new `extractScopedOverrides`) to
      return active scopes from the comment scan; later sentinel for the same scope wins.
- [ ] 3.3 Wire the review (`stages/review.ts`) and pre-merge (`stages/pre_merge.ts`)
      `partitionFindings` call sites to pass the extracted scopes alongside the key map.

## 4. CLI + auto-resume

- [ ] 4.1 In `runOverride` (`pipeline.ts`), branch on `parsed.kind`: render the scoped
      comment + sentinel for scope dispositions; keep the keyed path for keys.
- [ ] 4.2 Confirm the existing clear-`blocked` + auto-resume path
      (`override-auto-resume`) runs unchanged for scoped overrides.

## 5. Surface breadth in the advance/audit trail

- [ ] 5.1 In the all-advisory advance comment, itemize each scope-overridden finding
      under the scope that swept it (not just "a scope was active").

## 6. Tests

- [ ] 6.1 `parseOverrideArg`: parses both scope types; rejects empty scope value and
      empty reason; bare key still parses to `kind: "key"` identically.
- [ ] 6.2 `partitionFindings`: category scope overrides all matching findings
      regardless of key; non-matching category untouched.
- [ ] 6.3 `partitionFindings`: file scope matches exact + directory-prefix; rejects a
      non-boundary string prefix (`src/repo` vs `src/report.rs`).
- [ ] 6.4 Key-independence: simulate a re-review where the same conceptual finding
      returns under a new `findingKey`; the scope still overrides it.
- [ ] 6.5 Ambiguity-guard bypass: two distinct findings under one scope are both
      overridden (whereas two distinct findings under one key are not).
- [ ] 6.6 Sentinel round-trip: `scopedOverrideComment` → extraction yields the original
      scope + disposition; later sentinel for the same scope wins.
- [ ] Each new test fails before the corresponding implementation (prove it bites).

## 7. Mirror + gate

- [ ] 7.1 `node scripts/build.mjs` to regenerate `plugin/`; commit the mirror in the
      same change.
- [ ] 7.2 `npm run ci` green from the repo root (`ci:core` → mirror check →
      install-smoke).
