## Context

See `proposal.md` for motivation. Incident: `/pipeline 290` on v1.39.13, runs `loop-43c47d695f2e1085` (fatal) and `loop-43c47d695f2e1085-s1` (succeeded after re-auth).

**Class vs site (engine-dogfood bar):**

| Question | Answer |
| --- | --- |
| Class | Three honesty faults in one diagnostic class: (1) default doctor pass copy asserts live authentication it did not prove; (2) implementer smoke disables the tools needed to commit, then deletes the scratch repo without capturing evidence; (3) post-spawn provider credential failure is classified as `harness-contract` and themed `workflow-engine-defect`. |
| Site | Codex revoked refresh token + Claude implementer smoke trailer-miss on one host. Human comments later showed the smoke false-fail is independent of dead auth. |
| Shared law | Doctor pass-copy contract; implementer smoke without lean; per-treatment failure artifact; typed `environment-auth` classification + existing `verify_authentication` + FRG product-class. |
| Next identical fault | Any assigned harness whose login-status file is stale, any implementer smoke trailer-miss, or any 401/`refresh_token_invalidated` after spawn MUST hit this law. A doctor-only wording tweak, a Claude-only smoke special case, or a Codex-stderr mole is incomplete. |

**Current constraints:**

- Default doctor assigned-harness checks call adapter `preflight` / `runtimeSmoke` (login-status / credentials present). On success they print "`bin` is available and authenticated". `codex login status` reports logged-in while the refresh token is revoked (upstream). Locked design: no live probe on the default path.
- Implementer smoke invokes with `lean: true` (`--tools ""` on Claude). Reviewer smoke already passes. Scratch repos already set `user.name` / `user.email`; git identity is not the missing piece.
- `classifyHarnessFailure` maps non-zero exit and `spawn_error` to `harness-contract`, which projects to `workflow-engine-defect`. `HarnessResult.preflight_reason_code` can already be `environment-auth`, but the classifier does not honor it after spawn. Durable class `environment-auth` and recipe `verify_authentication` already exist. `classifyFrgBlocker` already maps typed durable classes other than `workflow-engine-defect` to product-class — mis-theming is what inflates engine-class.
- `#1272` owns salvage publication. Codex `resolved_model` stays unknown until a recorded current CLI fixture exists.

## Goals / Non-Goals

**Goals:**

- Pass copy matches what the static check measured.
- Implementer smoke measures trailer-bearing commit capability, not a tool-disabled session.
- Smoke assertion failures leave inspectable, sanitized evidence.
- Provider credential failure is `environment-auth` end to end (reason, theme, recovery, FRG bucket).

**Non-Goals:**

- Live model probe on default `pipeline doctor`.
- New `DurableBlockerClass` or stop-theme string.
- Classifying arbitrary stderr prose as auth.
- Codex served-model / `resolved_model` telemetry.
- `#1272` salvage publication, recover-parked, park-release.
- A live FRG pack item that requires a revoked credential.
- Changing reviewer smoke lean, merge authority, or review rigor.

## Decisions

### D1: Default doctor reports credentials / login-status, never “authenticated”

**Decision:** Keep adapter preflight as the static signal. Change check description, pass detail, and JSON `reason` to “credentials present” / “login-status present”. Fail path for `unauthenticated` stays distinct from missing-CLI. Remediation on fail MAY still say “authenticate”. Default doctor remains model-free.

**Rationale:** Locked design. A false green is worse than no check. Upstream `codex login status` lies; the engine must not amplify that lie.

**Alternatives:** Live probe on every doctor (rejected: cost; locked no). Drop the harness check (rejected: missing-CLI still matters). Keep “authenticated” in JSON only (rejected: `--json` is the machine signal).

### D2: Implementer smoke drops lean; reviewer may keep it

**Decision:** Implementer `invokeSmoke` does not pass `lean: true`. Reviewer treatments MAY still pass lean because they are read-only and must not mutate. Unit tests inject `invokeSmoke` and fail if implementer lean is true. A second fixture: fake implementer commits only when lean is absent; that treatment passes.

**Rationale:** Locked design. Claude lean is `--tools ""`, so the canned implementer cannot `git commit`. Reviewer smoke already passes with lean.

**Alternatives:** Keep lean and ask the model to print a commit (rejected: smoke must prove mutation). Special-case Claude (rejected: class-over-site). Disable trailers for smoke (rejected: production contract is trailers).

### D3: One typed failure artifact per treatment, then cleanup

**Decision:** On every assertion failure (readiness already short-circuits without scratch; spawn fail, missing trailers, contract fail, reviewer mutation, telemetry fail, unexpected throw), write one artifact **before** `cleanupScratchRepo`. Schema `pipeline/harness-smoke-failure@1`. Fields: treatment identity; stdout; stderr; before/after porcelain; HEAD and `git log` excerpt; exit, timeout, preflight flags. Same secret-redaction / injection-denylist as run artifacts. Bound head/tail like trajectory artifacts. Human summary and `--json` carry `{ path, content_hash }` (digest). Write failure is logged and MUST NOT replace the original assertion fail with a pass. Artifact lives next to the stored doctor result so it survives scratch delete.

**Rationale:** Locked design. Today `/tmp/pipeline-<domain>-doctor-result.json` stores only the trailer-miss sentence. The reporter could not tell spawn-error vs commit-without-trailers vs tool-disabled.

**Alternatives:** Embed full stdout in the doctor JSON envelope (rejected: secrets + size). Keep the scratch repo on failure (rejected: `/tmp` leak; artifact is enough). Capture only on trailer-miss (rejected: locked “every assertion failure”).

### D4: Typed auth signal; allowlisted JSON codes; no prose scraper

**Decision:** Classification order:

1. `preflight_reason_code === "environment-auth"` → `environment-auth`.
2. Structured provider status on the harness result (typed field, or a JSON object parsed from CLI output whose `error.code` / equivalent closed field is allowlisted).
3. Exact allowlisted compatibility markers only. The incident marker `refresh_token_invalidated` is in that closed table. A structured HTTP 401 on the provider status object is allowed. Scanning English sentences (“please log in”, “Your session has ended”) is forbidden.
4. Else existing `classifyHarnessFailure` (timeout, throttle, `harness-contract`, …).

Projection: `environment-auth` → durable class `environment-auth` → recipe `verify_authentication`. Stop theme is that existing string. `blocker_kind` MAY stay `harness-failure` at the coarse GitHub-comment layer if reason_code / theme carry the class; do not invent a new blocker kind or theme.

**Rationale:** Locked design. `harness-contract` → `workflow-engine-defect` is why the incident counted as an engine defect. `environment-auth` already has recovery and FRG product-class mapping. Prose scraping would false-positive output-contract text.

**Alternatives:** New theme `harness-auth` (rejected: locked no new theme). Derive theme only from `blocker_kind` (superseded by locked reason_code path). Treat every 401 substring in stderr as auth (rejected: locked no arbitrary prose).

### D5: FRG product-class via existing taxonomy, not a live revoked-token pack item

**Decision:** Add a biting unit scenario: `classifyFrgBlocker("environment-auth") === "product-class"` and a scored pack item with theme `environment-auth` increments product-class, not `engine_class_count`. Do not add a live FRG pack scenario that needs a dead credential.

**Rationale:** Locked “represented as a product-class FRG scenario”. The live pack cannot mint revoked tokens. The bug is mis-theming; the taxonomy function is already correct once the theme is `environment-auth`.

**Alternatives:** New live pack id (rejected: cannot inject revoked credentials in CI). Map environment-auth to engine-class (rejected: locked product-class).

### D6: Out of scope stays out

**Decision:** Do not parse or invent Codex `resolved_model`. Adapters that cannot recover a served model keep omitting it or returning null until a recorded current CLI fixture exists (`#778` comment). Do not change `#1272` salvage publication.

**Rationale:** Locked 2026-08-29 clarification.

## Risks / Trade-offs

- **[Risk]** Dropping implementer lean increases smoke tool surface and cost. → **Mitigation:** keep canned prompt cheap; timeout unchanged; reviewer stays lean.
- **[Risk]** Allowlist misses a future provider code. → **Mitigation:** fail as `harness-contract` (visible, not a false environment-auth). Add the exact code when a fixture exists. Class-over-site: extend the table, not a path-local mole.
- **[Risk]** Parsing JSON objects out of mixed stderr could pick the wrong object. → **Mitigation:** only closed `error.code` / typed status fields; ignore leftover prose.
- **[Risk]** Artifact write fails. → **Mitigation:** original assertion remains fail; summary names the write error; never convert to pass.
- **[Risk]** Pass copy still says “authenticated” in help or check description. → **Mitigation:** tests scan assigned-harness pass detail, JSON `reason`, and check description for that word on the pass path.

## Migration Plan

- Behavior change only. No schema version bump of durable blocker class.
- In-flight runs keep their recorded theme. New classifications use `environment-auth`.
- No rollback of doctor JSON schema required: artifact locator is additive.
- After `core/` edits: `node scripts/build.mjs` in the same commit.

## Open Questions

None. Locked design 2026-08-27 / 2026-08-29 answers probe vs copy, lean, artifact contents, classification, FRG bucket, telemetry, and `#1272`.
