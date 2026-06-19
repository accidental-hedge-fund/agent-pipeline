# Tasks

## 1. Config knob

- [ ] 1.1 Add `surface_recurrence_rounds: number` to the `review_policy` shape in `core/scripts/types.ts` with a comment explaining the surface guard.
- [ ] 1.2 Add the default (`3`) to `DEFAULT_CONFIG.review_policy` in `types.ts`.
- [ ] 1.3 Add the Zod field in `core/scripts/config.ts` (`z.number().int().min(0)`, `.optional()`, `.describe(...)`) and the resolution fallback to the default.
- [ ] 1.4 Append `review_policy.surface_recurrence_rounds` to `RIGOR_GATING_PATHS` and to the emitted commented default YAML.
- [ ] 1.5 Test: config resolves the default, accepts a declared value, rejects non-integer/negative, and the path resolves in the emitted JSON Schema (extend the existing `RIGOR_GATING_PATHS`↔schema coherence test).

## 2. Surface clustering + marker (pure helpers in `review-policy.ts`)

- [ ] 2.1 Add `surfaceKey(f: ReviewFinding): string | null` — `normalize(file) + "|" + (category ?? "")`; returns `null` when `file` is absent.
- [ ] 2.2 Add `formatBlockingSurfacesMarker(findings): string` emitting `<!-- pipeline-blocking-surfaces: <key>~<surface>,... -->` (empty marker when no blocking findings carry a surface).
- [ ] 2.3 Add `extractBlockingSurfacesFromComment(body: string): Map<string,string>` (key→surface) — full-line-anchored regex, last-occurrence-wins, pure (no network/git/subprocess).
- [ ] 2.4 Tests: round-trip emit→extract; last-occurrence-wins against a spoofed earlier marker; empty/malformed body returns empty map without throwing.

## 3. Emit the marker from the review comment

- [ ] 3.1 In `core/scripts/stages/review.ts` `formatReviewComment`, append the `pipeline-blocking-surfaces` marker next to the existing `pipeline-blocking-keys` marker, computed from the same blocking partition.
- [ ] 3.2 Test: a needs-attention verdict comment contains the surfaces marker; an advisory-only round emits the empty surfaces marker.

## 4. Surface-recurrence detection in `advanceReview`

- [ ] 4.1 After the exact-key early-park check and before the round-ceiling check, compute per-surface streaks from `priorRoundComments` using `extractBlockingSurfacesFromComment`.
- [ ] 4.2 Determine fired surfaces: `streak(S) >= cfg.review_policy.surface_recurrence_rounds` (skip entirely when the knob is `0`) AND the current round contributes a new key to `S` (not an exact repeat).
- [ ] 4.3 Skip the surface guard for any surface whose findings already early-parked via the exact-key guard (precedence) — i.e., the check only runs on the fall-through after the exact-key branch did not park.

## 5. Fired-guard action (reuse existing terminals)

- [ ] 5.1 Under `ceiling_action: park` — post the `reviewCeilingComment(..., "recurrence")` punch-list and transition to `needs-human` early; return the advanced result. Do NOT consume remaining round budget.
- [ ] 5.2 Under `ceiling_action: demote_and_advance` — partition the fired cluster's findings; keep `high`/`critical` blocking; demote below-high to advisory via the #233 primitives (`reviewCeilingDemotionComment`, audited `pipeline-override` sentinels, single follow-up issue with idempotency marker), then advance.
- [ ] 5.3 Ensure `high`/`critical` findings are never demoted by this guard under any `ceiling_action`.

## 6. Regression + integration tests

- [ ] 6.1 Whack-a-mole (acceptance a): 3 rounds of new keys in the same `(file, category)` → guard fires (park: needs-human; demote_and_advance: below-high demoted + advance). Prove it bites (fails without the guard).
- [ ] 6.2 Distinct surfaces (acceptance b): 3 rounds, different file/category each → guard does NOT fire (loop proceeds to normal ceiling behavior).
- [ ] 6.3 Exact-key precedence: an exact-key repeat still early-parks before the surface guard runs.
- [ ] 6.4 High/critical in a fired cluster is NOT demoted under `demote_and_advance`.
- [ ] 6.5 `surface_recurrence_rounds: 0` disables the guard.

## 7. Mirror + gate

- [ ] 7.1 `node scripts/build.mjs` to regenerate `plugin/`; commit the mirror in the same change.
- [ ] 7.2 `npm run ci` green from repo root (core tests + mirror check + install smoke).
