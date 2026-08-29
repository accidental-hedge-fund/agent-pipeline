// Generated short host SKILL renderer (#1049). In-process only: no network,
// git, or subprocess. Injects operationSurface and manifests through
// renderHostSkill(options?).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_SKILL_CLI_DOC_URL,
  HOST_SKILL_PACKAGING_DOC_URL,
  SKILL_HOST_IDS,
  hostSkillRelativePath,
  hostSkillRelativePaths,
  projectSkillNotifyRows,
  renderHostSkill,
  selectSkillHostManifests,
} from "../scripts/host-skill.ts";
import { OPERATION_SURFACE } from "../scripts/operation-surface.ts";
import { loadOuterHostManifestsPreferHosts } from "../scripts/outer-hosts/load-manifest.ts";
import type { OuterHostManifest } from "../scripts/outer-hosts/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const HOST_SKILL_SOURCE = join(repoRoot, "core/scripts/host-skill.ts");
const ORCHESTRATION_SOURCE = join(repoRoot, "core/scripts/outer-hosts/orchestration.ts");

const HOST_SKILL_FILES = SKILL_HOST_IDS.map((id) =>
  join(repoRoot, hostSkillRelativePath(id)),
);

function baseNotify(id: string, mapping: OuterHostManifest["material_progress_notify"]["mapping"]) {
  return {
    support: "supported" as const,
    how: "fixture",
    mapping,
    fallback: "stdout material lines via events.jsonl",
  };
}

function fixtureManifest(
  id: string,
  mapping: OuterHostManifest["material_progress_notify"]["mapping"],
  extra: Partial<OuterHostManifest["material_progress_notify"]> = {},
): OuterHostManifest {
  return {
    manifestVersion: 1,
    id,
    displayName: id,
    origin: "builtin",
    install: {
      support: "supported",
      mode: "tree",
      basePath: { defaultHomeSegments: [`.${id}`] },
      skillsRelative: ["skills"],
      skillDirName: "pipeline",
      overlayDir: `hosts/${id}`,
      overlayFiles: ["SKILL.md"],
      overlayDirs: [],
      managedArtifacts: {
        skillTree: true,
        commandsGlob: null,
        commandsDirRelative: null,
        commandsKind: "none",
      },
      userOwnedExclusion: "fixture",
      postInstall: "fixture",
      installOrder: 10,
    },
    invocation: {
      support: "supported",
      skillPathHint: `~/.${id}/skills/pipeline`,
      commandSurface: "pipeline",
      discoveryProbe: "fixture",
      discovery: { kind: "skill_path" },
    },
    early_run_handoff: { support: "supported", how: "fixture" },
    event_follow: { support: "supported", how: "fixture" },
    reattach: { support: "supported", how: "fixture" },
    wait_cancel: {
      support: "supported",
      classification: "non_terminal",
      recovery: "reattach_or_portable_follow",
      how: "fixture",
    },
    material_progress_notify: { ...baseNotify(id, mapping), ...extra },
    terminal_cleanup: { support: "supported", how: "fixture" },
    terminal_summary: { support: "supported", how: "fixture" },
  };
}

function selectedFixtures(
  overrides: Partial<Record<(typeof SKILL_HOST_IDS)[number], OuterHostManifest["material_progress_notify"]["mapping"]>> = {},
): OuterHostManifest[] {
  const defaults: Record<(typeof SKILL_HOST_IDS)[number], OuterHostManifest["material_progress_notify"]["mapping"]> = {
    claude: {
      surface: "claude_monitor_push",
      tools: ["Monitor", "PushNotification"],
      filter: "scripts/material-filter.mjs",
    },
    codex: {
      surface: "codex_chat_status",
      tools: ["chat", "status"],
      filter: "scripts/material-filter.mjs",
    },
    grok: {
      surface: "grok_monitor_lines",
      tools: ["monitor"],
      filter: "scripts/material-filter.mjs",
    },
    opencode: {
      surface: "stdout_only",
      tools: [],
      filter: "scripts/material-filter.mjs",
    },
  };
  return SKILL_HOST_IDS.map((id) => fixtureManifest(id, overrides[id] ?? defaults[id]));
}

function parseNotifyRows(skill: string): Array<{
  id: string;
  surface: string;
  tools: string;
  filter: string;
}> {
  const rows: Array<{ id: string; surface: string; tools: string; filter: string }> = [];
  const table = skill.split("### Host notify map")[1] ?? "";
  for (const line of table.split("\n")) {
    const match = line.match(/^\| ([a-z]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/);
    if (!match) continue;
    const id = match[1]!;
    if (id === "Host" || id === "---") continue;
    rows.push({
      id,
      surface: match[2]!.trim(),
      tools: match[3]!.trim(),
      filter: match[4]!.trim(),
    });
  }
  return rows;
}

function toolsCell(tools: readonly string[]): string {
  return tools.length > 0 ? tools.join(", ") : "—";
}

describe("SKILL_HOST_IDS membership", () => {
  test("tuple is exactly claude, codex, grok, opencode", () => {
    assert.deepEqual([...SKILL_HOST_IDS], ["claude", "codex", "grok", "opencode"]);
  });

  test("derived paths match hosts/<id>/SKILL.md in tuple order", () => {
    assert.deepEqual([...hostSkillRelativePaths()], [
      "hosts/claude/SKILL.md",
      "hosts/codex/SKILL.md",
      "hosts/grok/SKILL.md",
      "hosts/opencode/SKILL.md",
    ]);
  });
});

describe("selectSkillHostManifests", () => {
  test("selects tuple order and ignores OMP", () => {
    const omp = fixtureManifest("omp", {
      surface: "stdout_only",
      tools: [],
      filter: "scripts/material-filter.mjs",
    });
    const selected = selectSkillHostManifests([...selectedFixtures(), omp]);
    assert.deepEqual(
      selected.map((m) => m.id),
      ["claude", "codex", "grok", "opencode"],
    );
  });

  test("fails closed on a missing selected ID", () => {
    const manifests = selectedFixtures().filter((m) => m.id !== "grok");
    assert.throws(
      () => selectSkillHostManifests(manifests),
      /missing selected host manifest: grok/,
    );
  });

  test("fails closed on a duplicate selected ID", () => {
    const manifests = [...selectedFixtures(), ...selectedFixtures().filter((m) => m.id === "codex")];
    assert.throws(
      () => selectSkillHostManifests(manifests),
      /duplicate selected host manifest: codex/,
    );
  });
});

describe("notify projection", () => {
  test("rendered rows equal injected mapping fields", () => {
    const fixtures = selectedFixtures();
    const rows = projectSkillNotifyRows(fixtures);
    const skill = renderHostSkill({ manifests: fixtures });
    const parsed = parseNotifyRows(skill);
    assert.equal(parsed.length, SKILL_HOST_IDS.length);
    for (const row of rows) {
      const rendered = parsed.find((p) => p.id === row.id);
      assert.ok(rendered, `missing rendered row for ${row.id}`);
      assert.equal(rendered!.surface, row.surface);
      assert.equal(rendered!.tools, toolsCell(row.tools));
      assert.equal(rendered!.filter, row.filter);
    }
  });

  test("a fixture mapping change changes only the corresponding rendered row", () => {
    const original = renderHostSkill({ manifests: selectedFixtures() });
    const changed = renderHostSkill({
      manifests: selectedFixtures({
        grok: {
          surface: "fixture_grok_surface",
          tools: ["fixture-monitor"],
          filter: "scripts/fixture-filter.mjs",
        },
      }),
    });
    const originalRows = parseNotifyRows(original);
    const changedRows = parseNotifyRows(changed);
    assert.notEqual(
      changedRows.find((r) => r.id === "grok")?.surface,
      originalRows.find((r) => r.id === "grok")?.surface,
    );
    assert.equal(changedRows.find((r) => r.id === "grok")?.surface, "fixture_grok_surface");
    assert.equal(changedRows.find((r) => r.id === "grok")?.tools, "fixture-monitor");
    for (const id of ["claude", "codex", "opencode"] as const) {
      assert.deepEqual(
        changedRows.find((r) => r.id === id),
        originalRows.find((r) => r.id === id),
      );
    }
  });

  test("fails when a selected notify declaration has neither surface nor fallback", () => {
    const manifests = selectedFixtures();
    const broken = manifests.map((m) =>
      m.id === "opencode"
        ? fixtureManifest(
            "opencode",
            { surface: "none", tools: [], filter: "" },
            { support: "unsupported", fallback: "" },
          )
        : m,
    );
    assert.throws(
      () => renderHostSkill({ manifests: broken }),
      /neither a usable surface nor a portable fallback/,
    );
  });

  test("production manifests project rows that match mapping fields", () => {
    const manifests = loadOuterHostManifestsPreferHosts(repoRoot);
    const rows = projectSkillNotifyRows(manifests);
    const skill = renderHostSkill({ manifests });
    const parsed = parseNotifyRows(skill);
    assert.deepEqual(
      rows.map((r) => r.id),
      [...SKILL_HOST_IDS],
    );
    for (const row of rows) {
      const manifest = manifests.find((m) => m.id === row.id)!;
      const mapping = manifest.material_progress_notify.mapping;
      assert.equal(row.surface, mapping.surface);
      assert.deepEqual([...row.tools], [...mapping.tools]);
      assert.equal(row.filter, mapping.filter);
      const rendered = parsed.find((p) => p.id === row.id)!;
      assert.equal(rendered.surface, mapping.surface);
      assert.equal(rendered.tools, toolsCell(mapping.tools));
      assert.equal(rendered.filter, mapping.filter);
    }
    assert.equal(
      parsed.some((r) => r.id === "omp"),
      false,
      "OMP must not appear in the compact notify table",
    );
  });
});

describe("renderHostSkill contract", () => {
  const skill = renderHostSkill();

  test("names follow-until-terminal commands and run_id", () => {
    assert.match(skill, /run_id/);
    assert.match(skill, /pipeline logs <advance-run-id> --events --follow/);
    assert.match(skill, /pipeline loop logs <loop-run-id> --events --follow/);
    assert.match(skill, /Reattach an interrupted follow/);
    assert.match(skill, /Stop every run-scoped follow on confirmed terminal/);
    assert.match(skill, /terminal reason/);
  });

  test("forbids follower merge-capable commands", () => {
    assert.match(skill, /never invokes a merge-capable command/);
    assert.match(skill, /`merge`/);
    assert.match(skill, /`merge-queue --apply`/);
    assert.match(skill, /`train --merge`/);
    assert.match(skill, /`ship`/);
  });

  test("retains default numeric drive outside OPERATION_SURFACE table", () => {
    assert.match(skill, /Default numeric drive \(outside the verb table\): `pipeline <N>`/);
    const table = skill.split("## Operations")[1]?.split("## Follow")[0] ?? "";
    for (const op of OPERATION_SURFACE) {
      assert.match(table, new RegExp(`pipeline ${op.usage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    assert.match(table, /pipeline train --milestone/);
    assert.match(table, /pipeline ship --milestone vX\.Y\.Z/);
  });

  test("compact policy preserves merge-authority boundary", () => {
    assert.match(skill, /autonomous\nthrough `pipeline:ready-to-deploy` and never merge or deploy/);
    assert.match(skill, /`pipeline merge <pr>`/);
    assert.match(skill, /`pipeline merge-queue --apply` \(merge-queue is dry-run by default unless `--apply` is explicit\)/);
    assert.match(skill, /`pipeline train --merge`/);
    assert.match(skill, /`pipeline ship --milestone`/);
    assert.match(
      skill,
      /`Ship milestone vX\.Y\.Z` maps to `pipeline ship --milestone vX\.Y\.Z`/,
    );
  });

  test("uses exact installed-tree-safe GitHub doc links", () => {
    assert.match(skill, new RegExp(HOST_SKILL_PACKAGING_DOC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(skill, new RegExp(HOST_SKILL_CLI_DOC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(skill, /\]\(\.\.\/docs\/(?:packaging|cli)\.md\)/);
  });

  test("omits retired engine essays", () => {
    assert.doesNotMatch(skill, /## State machine/);
    assert.doesNotMatch(skill, /Happy path \(18 stages/);
    assert.doesNotMatch(skill, /## Per-repo config/);
    assert.doesNotMatch(skill, /base_branch: main/);
    assert.doesNotMatch(skill, /evals manifesto|Objective grading and comparative reporting/);
    assert.doesNotMatch(skill, /### 4\. Orchestration pattern/);
    assert.doesNotMatch(skill, /### 4b\. Orchestration pattern/);
    assert.doesNotMatch(skill, /### 4c\. Orchestration pattern/);
    assert.doesNotMatch(skill, /FIFO_DIR=\$\(mktemp/);
    assert.doesNotMatch(skill, /completes in seconds/);
    assert.doesNotMatch(skill, /No background process or Monitor needed/);
  });

  test("does not fork CLI table with host discovery tokens", () => {
    assert.doesNotMatch(skill, /^\/pipeline /m);
    assert.doesNotMatch(skill, /^\$pipeline /m);
    assert.match(skill, /Execute catalog operations as `pipeline <verb>`/);
  });
});

describe("source-of-truth bite", () => {
  test("renderer and orchestration have no second notify-value map or host-id dispatch", () => {
    const sources = [
      readFileSync(HOST_SKILL_SOURCE, "utf8"),
      readFileSync(ORCHESTRATION_SOURCE, "utf8"),
    ];
    for (const source of sources) {
      assert.doesNotMatch(
        source,
        /claude:\s*\{\s*(?:surface|tools|filter)\s*:/,
        "must not hardcode a host-keyed notify-value map",
      );
      assert.doesNotMatch(
        source,
        /if\s*\(\s*(?:id|hostId|host)\s*===?\s*["'](?:claude|codex|grok|opencode)["']/,
        "must not branch on host id to dispatch notify behavior",
      );
      assert.doesNotMatch(
        source,
        /switch\s*\(\s*(?:id|hostId|host)\s*\)/,
        "must not switch on host id for notify dispatch",
      );
    }
    const renderer = sources[0]!;
    assert.match(renderer, /SKILL_HOST_IDS = \["claude", "codex", "grok", "opencode"\] as const/);
  });

  test("renderer contains no stage inventory or host-specific stage dispatch", () => {
    const source = readFileSync(HOST_SKILL_SOURCE, "utf8");
    assert.doesNotMatch(source, /STAGES\s*=/);
    assert.doesNotMatch(source, /stage_start|planning → implement/);
    assert.doesNotMatch(source, /host-specific stage/);
    const skill = renderHostSkill();
    assert.doesNotMatch(skill, /backlog → needs-spec → ready → planning/);
    assert.doesNotMatch(skill, /scripts\/stages\//);
  });
});

describe("committed SKILL freshness", () => {
  test("all four committed files match a fresh renderHostSkill()", () => {
    const expected = renderHostSkill();
    for (const path of HOST_SKILL_FILES) {
      const committed = readFileSync(path, "utf8");
      assert.equal(
        committed,
        expected,
        `${path} is stale — run node scripts/build.mjs`,
      );
    }
  });

  test("a one-byte edit of a committed SKILL fails freshness", () => {
    const expected = renderHostSkill();
    const stale = `${expected} `;
    assert.notEqual(stale, expected);
  });

  test("the four generated SKILLs are byte-identical", () => {
    const bodies = HOST_SKILL_FILES.map((path) => readFileSync(path, "utf8"));
    for (let i = 1; i < bodies.length; i++) {
      assert.equal(bodies[i], bodies[0], `${HOST_SKILL_FILES[i]} differs from ${HOST_SKILL_FILES[0]}`);
    }
  });
});

type FollowState = {
  loopFollow: string | null;
  advanceFollow: string | null;
  outcome: "watching" | "completed" | "non_terminal_failure";
  summary: string | null;
};

function emptyFollow(): FollowState {
  return { loopFollow: null, advanceFollow: null, outcome: "watching", summary: null };
}

/** Semantic fixture for the compact follow contract (not a command-presence grep). */
function applyFollowEvent(
  state: FollowState,
  event:
    | { type: "loop_handoff"; loopRunId: string }
    | { type: "loop_item_advance_linked"; pipelineRunId: string }
    | { type: "advance_terminal" }
    | { type: "loop_terminal"; reason: string }
    | { type: "supervisor_exit" },
): FollowState {
  if (state.outcome !== "watching") return state;
  switch (event.type) {
    case "loop_handoff":
      return { ...state, loopFollow: `pipeline loop logs ${event.loopRunId} --events --follow` };
    case "loop_item_advance_linked":
      return {
        ...state,
        loopFollow: state.loopFollow,
        advanceFollow: `pipeline logs ${event.pipelineRunId} --events --follow`,
      };
    case "advance_terminal":
      return { ...state, advanceFollow: null };
    case "loop_terminal":
      return {
        loopFollow: null,
        advanceFollow: null,
        outcome: "completed",
        summary: `terminal reason=${event.reason}; follows stopped`,
      };
    case "supervisor_exit":
      return {
        loopFollow: null,
        advanceFollow: null,
        outcome: "non_terminal_failure",
        summary: "non-terminal failure/recovery; follows stopped",
      };
  }
}

describe("semantic follow contract fixtures", () => {
  test("after loop_item_advance_linked the loop follow stays active and advance follow is added", () => {
    let state = emptyFollow();
    state = applyFollowEvent(state, { type: "loop_handoff", loopRunId: "loop-1" });
    state = applyFollowEvent(state, {
      type: "loop_item_advance_linked",
      pipelineRunId: "adv-1",
    });
    assert.equal(state.loopFollow, "pipeline loop logs loop-1 --events --follow");
    assert.equal(state.advanceFollow, "pipeline logs adv-1 --events --follow");
    assert.equal(state.outcome, "watching");
  });

  test("a later linkage or terminal advance replaces/stops the prior advance follow", () => {
    let state = emptyFollow();
    state = applyFollowEvent(state, { type: "loop_handoff", loopRunId: "loop-1" });
    state = applyFollowEvent(state, {
      type: "loop_item_advance_linked",
      pipelineRunId: "adv-1",
    });
    state = applyFollowEvent(state, {
      type: "loop_item_advance_linked",
      pipelineRunId: "adv-2",
    });
    assert.equal(state.loopFollow, "pipeline loop logs loop-1 --events --follow");
    assert.equal(state.advanceFollow, "pipeline logs adv-2 --events --follow");

    state = applyFollowEvent(state, { type: "advance_terminal" });
    assert.equal(state.loopFollow, "pipeline loop logs loop-1 --events --follow");
    assert.equal(state.advanceFollow, null);
  });

  test("premature supervisor exit tears down follows and is not completion", () => {
    let state = emptyFollow();
    state = applyFollowEvent(state, { type: "loop_handoff", loopRunId: "loop-1" });
    state = applyFollowEvent(state, {
      type: "loop_item_advance_linked",
      pipelineRunId: "adv-1",
    });
    state = applyFollowEvent(state, { type: "supervisor_exit" });
    assert.equal(state.loopFollow, null);
    assert.equal(state.advanceFollow, null);
    assert.equal(state.outcome, "non_terminal_failure");
    assert.match(state.summary ?? "", /non-terminal failure\/recovery/);
    assert.notEqual(state.outcome, "completed");
  });

  test("confirmed terminal loop yields a completion summary after teardown", () => {
    let state = emptyFollow();
    state = applyFollowEvent(state, { type: "loop_handoff", loopRunId: "loop-1" });
    state = applyFollowEvent(state, { type: "loop_terminal", reason: "loop_run_complete" });
    assert.equal(state.outcome, "completed");
    assert.match(state.summary ?? "", /terminal reason=loop_run_complete/);
    assert.match(state.summary ?? "", /follows stopped/);
  });
});
