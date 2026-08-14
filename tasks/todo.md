# #693 Plan revision — governed typed overrides

## Status
- [x] Plan review feedback incorporated
- [x] Implementation complete

## Reviewer feedback dispositions
See chat response `## Feedback Incorporated` (authoritative for this revision).

## Implementation sequence (post-approval)
1. Config schema + types (`config.ts`, `types.ts`) — done
2. Pure module `override-governance.ts` (decision schema, validity, projection, renewal-lite eligibility) — done
3. Authority reuse from pre-code patterns + trusted_override_actors — done
4. Record path (`runOverride`, comment sentinels, rejected events) — done
5. Wire `partitionFindings` + auto-resume gates — done
6. Renewal side-effect job, events, evidence-bundle — done
7. Escalation inventory + docs — done
8. Tests + `build.mjs` + `npm run ci` — done

## Review

### What changed
- Added `override_governance` strict config block with implicit `low_risk_deferred` defaults when omitted.
- Pure `override-governance.ts`: validity, authority, SoD, renewal-lite, projection, events.
- Dual-read `pipeline-override-gov` sentinels; legacy sentinels map to low-risk compat.
- `runOverride` refuses unauthorized/missing-evidence/unknown-class before post.
- Partition consumers use validity-gated active projection.
- Escalation inventory rows for integrity refuse + expiry/drift (not transient-retryable).
- Docs + generated config reference for low-risk and high-risk examples.

### Verification
- `node --test` override-governance + pipeline-override: pass
- `npm run ci` from repo root: pass
- `openspec validate governed-typed-overrides`: pass
- `node scripts/build.mjs --check`: pass
- `npm run docs:check`: pass
