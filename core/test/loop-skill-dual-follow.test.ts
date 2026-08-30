// Drift guard: host SKILL §4b.d (pipeline:loop dual-follow after advance
// linkage) must stay mandatory until #611 densifies the loop stream (#684).
// Reads checked-in host docs directly — no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const HOST_SKILLS = [
  { label: "claude", path: path.join(repoRoot, "hosts/claude/SKILL.md") },
  { label: "codex", path: path.join(repoRoot, "hosts/codex/SKILL.md") },
  { label: "grok", path: path.join(repoRoot, "hosts/grok/SKILL.md") },
  { label: "opencode", path: path.join(repoRoot, "hosts/opencode/SKILL.md") },
] as const;

/** Extract §4b.d through the next #### heading (e. or successor). */
function dualFollowSection(source: string, label: string): string {
  // Prefer the mandatory dual-follow heading; fall back to legacy optional
  // heading so a regression that reintroduces optional-only prose still lands
  // in this extractor and fails the positive assertions below.
  const start =
    source.search(
      /#### d\.\s+(?:Dual-follow:|Optional:\s*follow active item advance)/i,
    );
  assert.ok(
    start !== -1,
    `${label}: expected §4b.d dual-follow (or legacy optional advance-follow) heading`,
  );
  const from = source.slice(start);
  const next = from.search(/\n#### [e-z]\./i);
  return next === -1 ? from : from.slice(0, next);
}

const MATERIAL_KINDS = [
  "stage_start",
  "stage_complete",
  "pr_created",
  "review_verdict",
  "gate_result",
  "blocker_set",
  "run_complete",
] as const;

// Optional-only post-linkage wording that must not be the sole instruction.
// Matches the historical §4b.d body that caused silent mid-item progress.
const OPTIONAL_ONLY_POST_LINKAGE =
  /optionally follow that item'?s single-issue stream/i;
const OPTIONAL_ONLY_HEADING =
  /#### d\.\s*Optional:\s*follow active item advance events when published/i;

function assertMandatoryDualFollow(section: string, label: string): void {
  assert.ok(
    !OPTIONAL_ONLY_HEADING.test(section),
    `${label}: §4b.d must not use the optional-only heading for post-linkage advance follow (#684)`,
  );
  assert.ok(
    !OPTIONAL_ONLY_POST_LINKAGE.test(section),
    `${label}: §4b.d must not describe post-linkage advance follow as optional-only (#684)`,
  );

  // Positive mandatory language after linkage.
  assert.ok(
    /\bSHALL\b|\bMUST\b|\bmust\b|\bmandatory\b/i.test(section) &&
      /dual-follow|advance event stream|arm a follow/i.test(section),
    `${label}: §4b.d must mandate dual-follow / arm advance follow after linkage`,
  );
  assert.ok(
    /loop_item_advance_linked/i.test(section),
    `${label}: §4b.d must name loop_item_advance_linked (or equivalent) as the linkage trigger`,
  );
  assert.ok(
    /pipeline_run_id|advance-run-id/i.test(section),
    `${label}: §4b.d must reference pipeline_run_id / advance-run-id`,
  );
  assert.ok(
    /logs[\s\S]*--events[\s\S]*--follow/i.test(section),
    `${label}: §4b.d must prefer logs … --events --follow for the advance run`,
  );
  assert.ok(
    /absolute `?events`? path|absolute advance `?events`?/i.test(section),
    `${label}: §4b.d must accept the absolute events path from linkage`,
  );
  assert.ok(
    /not required|do \*\*not\*\* require|do not require a\s+non-existent/i.test(section),
    `${label}: §4b.d must keep pre-linkage caveat (advance follow not required before linkage)`,
  );
  assert.ok(
    /switch or add|stop.*prior|terminal advance outcome/i.test(section),
    `${label}: §4b.d must document advance-follow lifecycle (switch/add/stop)`,
  );
  assert.ok(
    /#611/.test(section) && /#682/.test(section),
    `${label}: §4b.d must cross-link #611 and #682`,
  );
  assert.ok(
    /insufficient alone|not on the sparse loop stream|mid-item stage progress/i.test(
      section,
    ),
    `${label}: §4b.d must state loop-only is insufficient for mid-item stage progress until #611`,
  );
  assert.ok(
    /demot/i.test(section),
    `${label}: §4b.d must document the #611 demotion path`,
  );

  for (const kind of MATERIAL_KINDS) {
    assert.ok(
      section.includes(kind),
      `${label}: §4b.d material advance kinds must include \`${kind}\``,
    );
  }
  assert.ok(
    /pre_merge\.advancePolling|CI poll|polling/i.test(section),
    `${label}: §4b.d must instruct suppressing CI poll spam`,
  );
}

for (const { label, path: skillPath } of HOST_SKILLS) {
  test(`loop dual-follow drift-guard: ${label} host skill mandates post-linkage advance follow (#684)`, () => {
    const source = fs.readFileSync(skillPath, "utf8");
    assert.match(source, /loop_item_advance_linked/);
    assert.match(source, /pipeline logs <advance-run-id> --events --follow/);
    assert.match(source, /pipeline loop logs <loop-run-id> --events --follow/);
    assert.match(source, /Keep the loop follow\s+active/);
    assert.match(source, /stop or replace the prior\s+advance follow/);
    assert.match(source, /Do not guess an advance id before linkage/);
    assert.doesNotMatch(source, OPTIONAL_ONLY_POST_LINKAGE);
    assert.doesNotMatch(source, OPTIONAL_ONLY_HEADING);
  });
}

test("loop dual-follow drift-guard: pre-linkage optional absence does not trip optional-only ban (#684)", () => {
  // The fixed prose intentionally says advance follow is not required before
  // linkage — that must remain allowed. Build a synthetic section that has
  // mandatory post-linkage language + pre-linkage caveat and no optional-only
  // post-linkage instruction.
  const synthetic = `
#### d. Dual-follow: MUST arm advance events after linkage (mandatory until #611)

When loop_item_advance_linked publishes pipeline_run_id, the harness SHALL arm
a follow on that advance event stream (dual-follow). Prefer logs <id> --events
--follow; absolute events path is acceptable.

Before linkage exists: do not require a non-existent advance-linkage field.

Lifecycle: switch or add on new item; stop prior on terminal advance outcome.
Material: stage_start stage_complete pr_created review_verdict gate_result
blocker_set run_complete. Suppress pre_merge.advancePolling CI poll spam.
Loop-only is insufficient alone for mid-item stage progress until #611 (#682).
Demotion MAY land with #611.
`;
  assert.ok(
    !OPTIONAL_ONLY_POST_LINKAGE.test(synthetic),
    "synthetic fixed prose must not match optional-only ban",
  );
  assertMandatoryDualFollow(synthetic, "synthetic-fixed");
});

test("loop dual-follow drift-guard: optional-only post-linkage wording fails the guard (#684)", () => {
  // Prove the guard bites: historical optional-only §4b.d body must fail.
  const legacy = `
#### d. Optional: follow active item advance events when published

When an item's advance run_id is published on a loop event (dispatch→advance
linkage), optionally follow that item's single-issue stream with the §4
material kinds.
`;
  assert.throws(
    () => assertMandatoryDualFollow(legacy, "legacy-optional"),
    (err: unknown) => {
      assert.ok(err instanceof assert.AssertionError);
      return true;
    },
  );
});
