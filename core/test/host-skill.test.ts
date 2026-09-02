// Generated short host SKILL renderer (#1049). In-process only: no network,
// git, or subprocess. Injects operationSurface and manifests through
// renderHostSkill(options?).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SKILL_HOST_IDS,
  renderHostSkill,
} from "../scripts/host-skill.ts";
import { OPERATION_SURFACE } from "../scripts/operation-surface.ts";
import { loadOuterHostManifestsPreferHosts } from "../scripts/outer-hosts/load-manifest.ts";
import type { OuterHostManifest } from "../scripts/outer-hosts/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const HOST_SKILL_SOURCE = join(repoRoot, "core/scripts/host-skill.ts");
const ORCHESTRATION_SOURCE = join(repoRoot, "core/scripts/outer-hosts/orchestration.ts");

const PACKAGING_DOC_URL =
  "https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/packaging.md";
const CLI_DOC_URL =
  "https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/cli.md";
const HOST_SKILL_FILES = SKILL_HOST_IDS.map((id) =>
  join(repoRoot, `hosts/${id}/SKILL.md`),
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

  test("rendered rows and committed paths match SKILL_HOST_IDS in tuple order", () => {
    const skill = renderHostSkill();
    assert.deepEqual(
      parseNotifyRows(skill).map((r) => r.id),
      [...SKILL_HOST_IDS],
    );
    assert.deepEqual(
      SKILL_HOST_IDS.map((id) => `hosts/${id}/SKILL.md`),
      [
        "hosts/claude/SKILL.md",
        "hosts/codex/SKILL.md",
        "hosts/grok/SKILL.md",
        "hosts/opencode/SKILL.md",
      ],
    );
  });

  test("public API is only renderHostSkill and SKILL_HOST_IDS", () => {
    const source = readFileSync(HOST_SKILL_SOURCE, "utf8");
    const names: string[] = [];
    for (const match of source.matchAll(
      /^export\s+(?:async\s+)?(?:type|interface|function|const|class|enum|let|var)\s+(\w+)/gm,
    )) {
      names.push(match[1]!);
    }
    assert.deepEqual(
      [...names].sort(),
      ["SKILL_HOST_IDS", "renderHostSkill"].sort(),
    );
    assert.doesNotMatch(source, /^export type SkillHostId/m);
    assert.doesNotMatch(source, /^export interface RenderHostSkillOptions/m);
    assert.doesNotMatch(source, /^export \{/m);
    assert.doesNotMatch(source, /^export type \{/m);
    assert.doesNotMatch(source, /^export function hostSkillRelativePath/m);
    assert.doesNotMatch(source, /^export function hostSkillRelativePaths/m);
    assert.doesNotMatch(source, /^export function selectSkillHostManifests/m);
    assert.doesNotMatch(source, /^export function projectSkillNotifyRows/m);
    assert.doesNotMatch(source, /^export const HOST_SKILL_PACKAGING_DOC_URL/m);
    assert.doesNotMatch(source, /^export const HOST_SKILL_CLI_DOC_URL/m);
    assert.doesNotMatch(source, /^export interface SkillNotifyRow/m);
  });
});

describe("selectSkillHostManifests", () => {
  test("selects tuple order and ignores OMP", () => {
    const omp = fixtureManifest("omp", {
      surface: "stdout_only",
      tools: [],
      filter: "scripts/material-filter.mjs",
    });
    const parsed = parseNotifyRows(renderHostSkill({ manifests: [...selectedFixtures(), omp] }));
    assert.deepEqual(
      parsed.map((r) => r.id),
      ["claude", "codex", "grok", "opencode"],
    );
    assert.equal(parsed.some((r) => r.id === "omp"), false);
  });

  test("fails closed on a missing selected ID", () => {
    const manifests = selectedFixtures().filter((m) => m.id !== "grok");
    assert.throws(
      () => renderHostSkill({ manifests }),
      /missing selected host manifest: grok/,
    );
  });

  test("fails closed on a duplicate selected ID", () => {
    const manifests = [...selectedFixtures(), ...selectedFixtures().filter((m) => m.id === "codex")];
    assert.throws(
      () => renderHostSkill({ manifests }),
      /duplicate selected host manifest: codex/,
    );
  });
});

describe("notify projection", () => {
  test("rendered rows equal injected mapping fields", () => {
    const fixtures = selectedFixtures();
    const skill = renderHostSkill({ manifests: fixtures });
    const parsed = parseNotifyRows(skill);
    assert.equal(parsed.length, SKILL_HOST_IDS.length);
    for (const fixture of fixtures) {
      const mapping = fixture.material_progress_notify.mapping;
      const rendered = parsed.find((p) => p.id === fixture.id);
      assert.ok(rendered, `missing rendered row for ${fixture.id}`);
      assert.equal(rendered!.surface, mapping.surface);
      assert.equal(rendered!.tools, toolsCell(mapping.tools));
      assert.equal(rendered!.filter, mapping.filter);
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
    const skill = renderHostSkill({ manifests });
    const parsed = parseNotifyRows(skill);
    assert.deepEqual(
      parsed.map((r) => r.id),
      [...SKILL_HOST_IDS],
    );
    for (const id of SKILL_HOST_IDS) {
      const manifest = manifests.find((m) => m.id === id)!;
      const mapping = manifest.material_progress_notify.mapping;
      const rendered = parsed.find((p) => p.id === id)!;
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
    assert.match(skill, /pipeline liveness restore/);
    assert.match(skill, /Advance `run_complete` stops or replaces only that advance follow/);
    assert.match(skill, /Stop the loop-scoped follow set on `loop_run_complete`/);
    assert.match(skill, /terminal reason/);
  });

  test("dead-worker restore points at shared liveness restore, not retry or classify", () => {
    assert.match(skill, /A dead worker is not-live/);
    assert.match(skill, /pipeline liveness restore/);
    assert.match(skill, /Do not retry\n    `pipeline single`/);
    assert.match(skill, /classify a recipe/);
    assert.doesNotMatch(skill, /then retry `pipeline single`/);
    assert.doesNotMatch(skill, /merge because follow stopped/);
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
    assert.match(skill, /starts the durable\none-item drive/);
    assert.match(skill, /the same lifecycle as `pipeline single <N>`/);
    assert.match(skill, /`pipeline <N>` yields `loop_run_id`/);
    const table = skill.split("## Operations")[1]?.split("## Follow")[0] ?? "";
    for (const op of OPERATION_SURFACE) {
      for (const alt of op.usage.split(/\s+\|\s+/)) {
        assert.match(
          table,
          new RegExp(`pipeline ${alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        );
      }
    }
    assert.match(table, /pipeline doctor \[--json\|--is-ok\]/);
    assert.doesNotMatch(table, /pipeline --is-ok/);
    assert.doesNotMatch(table, /pipeline --issues/);
    assert.doesNotMatch(table, /pipeline --label/);
    assert.match(table, /pipeline train --milestone/);
    assert.match(table, /pipeline train --issues/);
    assert.match(table, /pipeline ship --milestone vX\.Y\.Z/);
    assert.match(table, /pipeline ship status --milestone vX\.Y\.Z/);
    assert.doesNotMatch(table, /\| ship status/);
    const usageLines = table
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("pipeline "));
    assert.ok(usageLines.length > 0, "verb table must contain pipeline invocations");
    for (const line of usageLines) {
      const usage = line.replace(/\s{2,}.*$/, "").trim();
      for (const alt of usage.split(/\s+\|\s+/)) {
        assert.match(
          alt.trim(),
          /^pipeline /,
          `top-level alternative must start with pipeline: ${alt}`,
        );
      }
    }
    const loopOp = OPERATION_SURFACE.find((op) => op.name === "loop");
    assert.ok(loopOp);
    const loopAlts = loopOp.usage.split(/\s+\|\s+/);
    for (const alt of loopAlts) {
      assert.match(alt, /^loop /);
      assert.match(table, new RegExp(`pipeline ${alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      const hasSelector =
        /--milestone|--label|--range|--roadmap-slice|<N>/.test(alt);
      const hasResume = /--resume/.test(alt);
      assert.equal(
        hasSelector && hasResume,
        false,
        `loop alternative combines selector with resume: ${alt}`,
      );
    }
    assert.ok(loopAlts.some((alt) => alt.includes("--roadmap-slice")));
    assert.ok(loopAlts.some((alt) => /loop <N>/.test(alt)));
    assert.ok(
      loopAlts.some(
        (alt) =>
          alt.includes("--resume") &&
          !/--milestone|--label|--range|--roadmap-slice|<N>/.test(alt),
      ),
    );
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
    assert.match(skill, new RegExp(PACKAGING_DOC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(skill, new RegExp(CLI_DOC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
    assert.doesNotMatch(skill, /\/pipeline` slash command/);
    assert.doesNotMatch(skill, /use \/review/);
    assert.doesNotMatch(skill, /use \/sweep/);
    assert.match(skill, /Execute catalog operations as `pipeline <verb>`/);
  });

  test("host-neutral discovery includes operator-authorized ship", () => {
    const frontmatter = skill.split("\n---\n")[0] ?? "";
    assert.match(frontmatter, /Ship milestone vX\.Y\.Z/);
    assert.match(frontmatter, /operator-authorized train or ship/);
    assert.match(frontmatter, /Ordinary advance, single, and loop never merge or deploy/);
    assert.doesNotMatch(frontmatter, /deployment is out of scope/);
  });
});

const SKILL_HOST_ID_ALT = "claude|codex|grok|opencode";
const SKILL_HOST_IDS_TUPLE =
  'SKILL_HOST_IDS = ["claude", "codex", "grok", "opencode"] as const';

const HOST_DISPATCH_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "unquoted host-keyed notify map",
    re: /claude:\s*\{\s*(?:surface|tools|filter)\s*:/,
  },
  {
    name: "quoted host-keyed notify map",
    re: /["'](?:claude|codex|grok|opencode)["']\s*:\s*\{\s*(?:surface|tools|filter)/,
  },
  {
    name: "Map literal notify dispatch",
    re: /new Map\(\s*\[\s*\[\s*["'](?:claude|codex|grok|opencode)["']/,
  },
  {
    name: "id equality dispatch",
    re: /if\s*\(\s*(?:id|hostId|host)\s*===?\s*["'](?:claude|codex|grok|opencode)["']/,
  },
  {
    name: "manifest.id equality dispatch",
    re: /(?:manifest|row)\.id\s*===?\s*["'](?:claude|codex|grok|opencode)["']/,
  },
  {
    name: "switch on host id",
    re: /switch\s*\(\s*(?:id|hostId|host)\s*\)/,
  },
  {
    name: "switch on manifest.id",
    re: /switch\s*\(\s*(?:manifest|row)\.id\s*\)/,
  },
  {
    name: "switch(activeHost) with a host case",
    re: /switch\s*\(\s*\w*[Hh]ost\w*\s*\)[\s\S]{0,200}case\s*["'](?:claude|codex|grok|opencode)["']/,
  },
  {
    name: "array-backed host map",
    re: /\[\s*(?:\[\s*)?["'](?:claude|codex|grok|opencode)["']\s*,/,
  },
  {
    name: "unquoted host map without notify-field shape",
    re: /(?:^|[^\w$])(?:claude|codex|grok|opencode)\s*:\s*(?:["'`{\[]|function)/,
  },
  {
    name: "metadata-first host map",
    re: new RegExp(
      String.raw`\{\s*(?:host|id|hostId)\s*:\s*["'](?:${SKILL_HOST_ID_ALT})["']`,
    ),
  },
  {
    name: "bracket-notation host lookup",
    re: new RegExp(String.raw`\[\s*["'](?:${SKILL_HOST_ID_ALT})["']\s*\]`),
  },
  {
    name: "arbitrary host-id comparison",
    re: new RegExp(
      String.raw`(?:===?|!==?)\s*["'](?:${SKILL_HOST_ID_ALT})["']|["'](?:${SKILL_HOST_ID_ALT})["']\s*(?:===?|!==?)`,
    ),
  },
];

/** Membership tuple is the one allowed host-id listing; strip it before scanning. */
function stripSkillHostIdTuple(source: string): string {
  return source.replaceAll(SKILL_HOST_IDS_TUPLE, "SKILL_HOST_IDS = [] as const");
}

function assertNoHostDispatch(source: string, label = "source"): void {
  const scanned = stripSkillHostIdTuple(source);
  for (const pattern of HOST_DISPATCH_PATTERNS) {
    assert.doesNotMatch(scanned, pattern.re, `${label} must not contain ${pattern.name}`);
  }
}

describe("source-of-truth bite", () => {
  test("renderer and orchestration have no second notify-value map or host-id dispatch", () => {
    const sources = [
      readFileSync(HOST_SKILL_SOURCE, "utf8"),
      readFileSync(ORCHESTRATION_SOURCE, "utf8"),
    ];
    for (const source of sources) {
      assertNoHostDispatch(source);
    }
    const renderer = sources[0]!;
    assert.match(renderer, /SKILL_HOST_IDS = \["claude", "codex", "grok", "opencode"\] as const/);
  });

  test("quoted-key, Map, and manifest.id dispatch fixtures fail the guard", () => {
    const quoted = `const m = { "claude": { surface: "x" } };`;
    const mapLiteral = `const m = new Map([["claude", { tools: [] }]]);`;
    const manifestId = `if (manifest.id === "claude") notify();`;
    const metadataFirst = `const rows = [{ host: "claude", surface: "x" }];`;
    const bracket = `notify["codex"] = { tools: [] };`;
    const arbitraryCompare = `if (active === "grok") push();`;
    const switchManifest = `switch (manifest.id) { case "opencode": break; }`;
    const switchActiveHost = `switch (activeHost) { case "claude": notify(); break; }`;
    const arrayBacked = `const rows = [["claude", { surface: "x" }]];`;
    const unquotedMap = `const notify = { claude: "PushNotification", codex: "chat" };`;
    const fixtures: Array<[string, string]> = [
      ["quoted", quoted],
      ["map", mapLiteral],
      ["manifest.id", manifestId],
      ["metadata-first", metadataFirst],
      ["bracket", bracket],
      ["arbitrary-compare", arbitraryCompare],
      ["switch-manifest.id", switchManifest],
      ["switch-activeHost", switchActiveHost],
      ["array-backed", arrayBacked],
      ["unquoted-map", unquotedMap],
    ];
    for (const [label, fixture] of fixtures) {
      assert.throws(
        () => assertNoHostDispatch(fixture, label),
        (err: unknown) => err instanceof assert.AssertionError,
        `${label} must fail the host-dispatch guard`,
      );
    }
  });

  test("SKILL_HOST_IDS membership tuple is exempt from the host-dispatch guard", () => {
    const tupleOnly = `export const ${SKILL_HOST_IDS_TUPLE};`;
    assertNoHostDispatch(tupleOnly, "tuple-only");
    const tuplePlusBracket = `${tupleOnly}\nnotify["claude"] = 1;`;
    assert.throws(
      () => assertNoHostDispatch(tuplePlusBracket, "tuple-plus-bracket"),
      (err: unknown) => err instanceof assert.AssertionError,
    );
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
    const committed = readFileSync(HOST_SKILL_FILES[0]!, "utf8");
    assert.equal(committed, expected);
    const oneByteStale = `${committed.slice(0, -1)}X`;
    assert.notEqual(oneByteStale, expected);
    assert.equal(oneByteStale.length, committed.length);
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
    | { type: "advance_handoff"; advanceRunId: string }
    | { type: "loop_handoff"; loopRunId: string }
    | { type: "loop_item_advance_linked"; pipelineRunId: string }
    | { type: "advance_terminal" }
    | { type: "loop_terminal"; reason: string }
    | { type: "supervisor_exit" },
): FollowState {
  if (state.outcome !== "watching") return state;
  switch (event.type) {
    case "advance_handoff":
      return { ...state, advanceFollow: `pipeline logs ${event.advanceRunId} --events --follow` };
    case "loop_handoff":
      return { ...state, loopFollow: `pipeline loop logs ${event.loopRunId} --events --follow` };
    case "loop_item_advance_linked":
      return {
        ...state,
        loopFollow: state.loopFollow,
        advanceFollow: `pipeline logs ${event.pipelineRunId} --events --follow`,
      };
    case "advance_terminal":
      if (state.loopFollow) {
        return { ...state, advanceFollow: null };
      }
      // Public numeric drive is loop-owned. A child run_complete without a
      // loop follow is not a confirmed terminal for that drive (#1327).
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

/** Renderer-connected follow contract. A reducer-only test cannot catch this. */
function assertRenderedFollowContract(skill: string, label = "skill"): void {
  assert.match(skill, /Launch default drive: `pipeline <N>` or `pipeline single <N>`/, label);
  assert.match(skill, /`pipeline <N>` yields `loop_run_id`/, label);
  assert.match(skill, /Retain\n   `loop_run_id` from the durable handoff/, label);
  assert.match(skill, /pipeline loop logs <loop-run-id> --events --follow/, label);
  assert.match(skill, /pipeline logs <advance-run-id> --events --follow/, label);
  assert.match(
    skill,
    /Advance `run_complete` stops or replaces only that advance follow/,
    label,
  );
  assert.match(skill, /Keep the loop follow active while the loop remains live/, label);
  assert.match(skill, /Stop the loop-scoped follow set on `loop_run_complete`/, label);
  assert.match(skill, /Interrupted follow is non-terminal/, label);
  assert.match(
    skill,
    /`loop_run_stopped`, or supervisor exit, in the same turn/,
    label,
  );
  assert.match(
    skill,
    /Premature supervisor exit is non-terminal failure\/recovery/,
    label,
  );
  assert.match(
    skill,
    /invoke\n    `pipeline liveness restore` or portable follow/,
    label,
  );
  assert.doesNotMatch(
    skill,
    /Stop every run-scoped follow on confirmed terminal \(`run_complete`/,
    `${label} must not tear down loop follow on advance run_complete`,
  );
  assert.doesNotMatch(skill, /Direct numeric launch: `pipeline <N>`/, label);
  assert.doesNotMatch(skill, /starts a direct\nadvance/, label);
  assert.doesNotMatch(
    skill,
    /Retain `advance_run_id` from the\n   `advance_run_handoff`/,
    label,
  );
  assert.doesNotMatch(skill, /terminal direct-advance outcome/, label);
}

describe("semantic follow contract fixtures", () => {
  test("rendered prose matches numeric vs loop follow and advance-vs-loop teardown", () => {
    assertRenderedFollowContract(renderHostSkill());
  });

  test("hostile teardown wording fails the rendered-lifecycle validator", () => {
    const skill = renderHostSkill();
    const hostile = skill.replace(
      /Advance `run_complete` stops or replaces only that advance follow\.\n   Keep the loop follow active while the loop remains live\./,
      "Stop every run-scoped follow on confirmed terminal (`run_complete` / `loop_run_complete` / `loop_run_stopped`).",
    );
    assert.notEqual(hostile, skill);
    assert.throws(
      () => assertRenderedFollowContract(hostile, "hostile-teardown"),
      (err: unknown) => err instanceof assert.AssertionError,
    );
  });

  test("hostile interrupted-follow, same-turn, and premature-exit mutations fail the validator", () => {
    const skill = renderHostSkill();
    const mutations: Array<[string, string, string]> = [
      [
        "interrupted-follow",
        "Interrupted follow is non-terminal. Cancelled wait is not completion.",
        "Interrupted follow is terminal completion.",
      ],
      [
        "same-turn-teardown",
        "`loop_run_stopped`, or supervisor exit, in the same turn.",
        "`loop_run_stopped`, or supervisor exit, on a later turn.",
      ],
      [
        "premature-exit",
        "Premature supervisor exit is non-terminal failure/recovery, never\n    completion. Tear down every run-scoped follow, then invoke\n    `pipeline liveness restore` or portable follow. Do not retry\n    `pipeline single`, classify a recipe, or emit a completion summary.",
        "Premature supervisor exit is completion. Keep follows running.",
      ],
    ];
    for (const [label, from, to] of mutations) {
      const hostile = skill.replace(from, to);
      assert.notEqual(hostile, skill, `${label} mutation must change rendered prose`);
      assert.throws(
        () => assertRenderedFollowContract(hostile, label),
        (err: unknown) => err instanceof assert.AssertionError,
        `${label} mutation must fail the renderer-connected validator`,
      );
    }
  });

  test("numeric drive follows loop handoff; child run_complete does not complete observation while the loop is live", () => {
    const skill = renderHostSkill();
    let state = emptyFollow();
    state = applyFollowEvent(state, { type: "loop_handoff", loopRunId: "loop-n" });
    state = applyFollowEvent(state, {
      type: "loop_item_advance_linked",
      pipelineRunId: "adv-n",
    });
    assert.equal(state.loopFollow, "pipeline loop logs loop-n --events --follow");
    assert.equal(state.advanceFollow, "pipeline logs adv-n --events --follow");
    state = applyFollowEvent(state, { type: "advance_terminal" });
    assert.equal(state.loopFollow, "pipeline loop logs loop-n --events --follow");
    assert.equal(state.advanceFollow, null);
    assert.equal(state.outcome, "watching");
    state = applyFollowEvent(state, { type: "loop_terminal", reason: "all_items_done" });
    assert.equal(state.outcome, "completed");
    assert.match(skill, /`pipeline <N>` yields `loop_run_id`/);
    assert.doesNotMatch(skill, /terminal direct-advance outcome/);
  });

  test("a fixture that completes numeric observation on child run_complete without a loop follow fails the contract", () => {
    const skill = renderHostSkill();
    let state = emptyFollow();
    state = applyFollowEvent(state, { type: "advance_handoff", advanceRunId: "adv-n" });
    state = applyFollowEvent(state, { type: "advance_terminal" });
    assert.equal(state.outcome, "watching", "child run_complete is not numeric terminal");
    assert.doesNotMatch(skill, /terminal direct-advance outcome/);
  });

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
    assert.equal(state.outcome, "watching");
    const skill = renderHostSkill();
    assert.match(skill, /Keep the loop follow active while the loop remains live/);
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
