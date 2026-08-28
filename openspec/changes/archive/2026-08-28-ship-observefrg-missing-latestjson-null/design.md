## Context

See `proposal.md` for motivation. After train observation succeeds, ship reconcile calls `observeFrg`. Production `observeFrg` calls `validateFrgEvidenceFileForTag` (tag-path fail-closed) and catches only `(err as Error).message.includes("evidence missing")`. `validateFrgEvidenceSnapshotForTag` on ENOENT throws `formatFrgTagPathFailure(..., "missing at ${latestPath}")`. That text does not contain `"evidence missing"`. The catch rethrows. Coordinator never sets `frg_pack`. Live v1.39.14 printed the tag-path remediation (`Cannot create or push tag v1.39.14`) before pack started.

Reconcile already treats `observeFrg === null` as “run pack.” Coordinator tests that stub `observeFrg → null` already expect `next_action: "frg_pack"`. The mole is the real observe catch, not the coordinator skip.

`waitForPublication` / `release ensure-tag` call the same validator **without** that catch. They must stay fail-closed.

### Engine-dogfood bar (#1271)

1. **Class vs site.** Class: observation of a later-phase artifact reused a fail-closed mutator validator and classified “not yet present / not yet eligible” as a thrown tag-path error by matching formatter prose the tag-path formatter no longer emits. Site: `observeFrg` after proven train on v1.39.14 with attestor key set and no `latest.json`.
2. **Shared law.** Observe-path consumers of the shared tag validator map missing / unreadable / not-release-eligible to not-observed without reading `formatFrgTagPathFailure` copy. Tag-path callers keep throwing that message. Do not add a second eligibility definition.
3. **Next identical fault.** A later ship whose train is proven and whose `latest.json` is absent, unreadable, or `pass: false` runs FRG pack instead of exiting 1 on the tag-path message. The next observer wrapping the tag validator does not substring-match formatter copy, so a later rewrite of `formatFrgTagPathFailure` does not need a new mole.

## Goals / Non-Goals

**Goals:**

- Observe maps missing / unreadable / not-release-eligible `latest.json` to `null` without matching formatter substrings.
- After proven train, `next_action` is `frg_pack`; pack / `factory-release prepare` starts.
- Tag / ensure-tag / publication still fail closed with `formatFrgTagPathFailure` on the same file.
- Identity defects during observe still throw.
- Tests drive the real observe mapping through injected fs; they fail on today’s `"evidence missing"` catch.

**Non-Goals:**

- Changing tag-path eligibility, HMAC, or `formatFrgTagPathFailure` copy.
- `--skip-frg` restore or hand-running FRG around a thrown observe.
- Weakening `assertFrgCandidateProvenance` / base-moved gates.
- Auto-tag workflow, gitignored tree-file auto-tag exception, or a second tag validator.
- `auto_merge` or merge inside advance/loop.
- Re-opening #1252 train freeze or #1269 `observeTrain` lookup.

## Decisions

### 1. Typed tag-path failure (or a dedicated observe helper), not a new substring

**Choice:** Classify not-observed from a typed tag-path failure (or a helper in `factory-reliability-gate` that returns `FrgEvidence | null` by catching that type). `observeFrg` uses that mapping. `formatFrgTagPathFailure` message stays for tag-path throws. Observe MUST NOT `message.includes("evidence missing")` and MUST NOT match `"missing at"`, `"FRG evidence is not release-eligible"`, or any other formatter substring as the observe API.

**Why:** The incident is exactly “formatter changed, catch did not.” Matching the new copy recreates the class. Swallowing every `Error` from the validator would also hide attestor-missing / programmer errors as pack. A type (or helper owned by the validator module) is the shared law.

**Alternatives considered:**

- Change the catch to `includes("missing at")` or `includes("not release-eligible")` → rejected: class-over-site; next formatter rewrite is another mole.
- Return `null` on any throw from `validateFrgEvidenceFileForTag` → weaker: no formatter coupling, but attestor-missing and unexpected validator bugs become “not observed.” Prefer typed missing/unreadable/not-eligible.
- Stop wrapping ENOENT inside the validator so observe can catch `err.code === "ENOENT"` → incomplete: unreadable and `pass: false` are already wrapped; observe still needs a non-string signal for those.
- Duplicate a second “is this file eligible?” checker in `ship-adapter` → rejected: living tag-path law forbids a second eligibility definition.

### 2. Observe-null covers absent, unreadable, and not-eligible; identity still throws

**Choice:** Map the three tag-validator ineligibility reasons (absent, unreadable, not release-eligible including `pass: false` / HMAC / parse) to `null` during observe. Keep throwing for: base advanced after recorded train, recorded train not contained in base, HMAC `candidate_git_sha` mismatch **after** a valid eligible read (`assertFrgCandidateProvenance`). Missing attestor credential during observe SHALL still throw (config), not become pack.

**Why:** Issue lists absent / unreadable / not-yet-eligible as the pre-pack state. A `pass: false` `latest.json` is “pack must run again,” not “cannot tag.” Tagging later still fail-closes if pack never writes a pass. Identity mismatch after a valid pass is not pre-pack.

**Testing seam:** Extract observe mapping so `core/test/ship-adapter.test.ts` injects `FrgFsDeps` (and base/git fakes already used by `observeTrainEvidence`). Drive ENOENT, unreadable, `pass: false`, eligible pass, and identity throw. Keep existing `validateFrgEvidenceFileForTag` fail-closed tests.

### 3. Tag / publication call sites stay fail-closed and uncaught

**Choice:** Do not wrap `waitForPublication` / `ensureAnnotatedReleaseTag` / `--validate-tag` in the observe mapping. They keep calling `validateFrgEvidenceFileForTag` / `validateFrgEvidenceSnapshotForTag` and throwing `formatFrgTagPathFailure`. Observe returning `null` on tick N does not skip ensure-tag on a later tick after pack writes a pass.

**Why:** Acceptance: “does not skip tagging later.” Living ship-coordinator already requires publication wait to invoke ensure-tag against on-disk HMAC `latest.json`.

## Risks / Trade-offs

- **[Risk] Typed error wrapping changes stack / `instanceof` across `plugin/` mirror.** → Mitigation: define the type next to `formatFrgTagPathFailure`; regenerate `plugin/` in the same change; tests assert observe-null and tag-throw, not a particular class name in user output.
- **[Risk] Mapping `pass: false` to observe-null loops pack forever.** → Mitigation: existing pack failure / wait-budget / genuine `pass: false` stop law stays; this change only lets pack **start**. Do not add a new retry policy.
- **[Risk] Tests stub `observeFrg → null` and miss the production catch again.** → Mitigation: at least one test MUST call the real observe mapping with injected fs, not the coordinator stub. Prove it fails on today’s `"evidence missing"` catch (red without the fix).
- **[Risk] Broadening observe-null hides a missing attestor key.** → Mitigation: attestor-missing stays a throw; only typed tag-path ineligibility maps to null.

## Migration Plan

- Ship on v1.39.14 so the stuck milestone can finish through pack → release → tag → promote.
- Rollback: revert the observe mapping; ships with no `latest.json` throw tag-path again.
- No data migration. No grant file. Do not finish v1.39.14 by hand-running FRG around a thrown observe.

## Open Questions

None. Observe-null vs tag fail-closed, no formatter substring, and identity-still-throws are settled by the v1.39.14 incident (2026-08-27).
