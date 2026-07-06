## 1. Replace head-biased truncation with head+tail elision

- [ ] 1.1 In `core/scripts/stages/eval.ts`, replace the head-only `truncate(s, cap)` helper
      with a head+tail elision helper that, when `s.length > cap`, returns a head slice, an
      explicit middle-elision marker stating the number of characters dropped, and the tail
      slice — with the head+tail source characters summing to `cap`.
- [ ] 1.2 Keep the `s.length <= cap` branch returning `s` verbatim with no marker.
- [ ] 1.3 Confirm all four failure paths (gate fail at ~line 310, timeout at ~line 275,
      spawn/runner error at ~line 288) and the shared/pass excerpt at ~line 242 route through
      the new helper — no additional call-site changes should be required.

## 2. Regression + unit tests

- [ ] 2.1 Add a co-located test for the helper: long input whose summary sentinel is only in
      the final characters → the sentinel appears in the excerpt.
- [ ] 2.2 Assert the excerpt for an over-limit input contains a head fragment, the elision
      marker, and the tail fragment, and that shown source characters ≤ `MAX_COMMENT_OUTPUT`.
- [ ] 2.3 Assert an input of length ≤ `MAX_COMMENT_OUTPUT` is returned verbatim with no marker.
- [ ] 2.4 Prove the test bites: it fails against the pre-change `slice(0, cap)` implementation.

## 3. Mirror + gate

- [ ] 3.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it with the
      `core/` change.
- [ ] 3.2 Run `npm run ci` from the repo root; all checks green (including
      `openspec validate --all`).
