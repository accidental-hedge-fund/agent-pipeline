// Tests for the `pipeline decompose` sub-command (#766).
//
// All tests inject DecomposeDeps — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDecompose,
  parseDecomposePlan,
  detectDependencyCycle,
  checkPlanBounds,
  renderProvenanceMarker,
  parseProvenanceMarker,
  buildChildBody,
  triageLabelForChild,
  topoSort,
  isEpicLabeled,
  resolveChildDependencyNumbers,
  indexProvenanceByKey,
  EPIC_LABEL,
  type DecomposeDeps,
  type DecomposeOpts,
  type DecomposePlan,
  type DecomposeChildPlan,
} from "../scripts/stages/decompose.ts";
import { parseDeclaredDependencyIds } from "../scripts/declared-dependency-grammar.ts";
import { lookupCommand, validateFlags, COMMAND_REGISTRY } from "../scripts/command-registry.ts";
import { resolveSelectorIssues, type SelectorOpenIssue, type SelectorResolveDeps } from "../scripts/pipeline.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROADMAP_FIXTURE = `# Roadmap

## Release plan (sem-ver)

| Release | Bump | Theme | Issues | Why this bump |
|---|---|---|---|---|
| **v1.42.0** | minor | Work breakdown | #766 | Adds decompose. |
| *(none)* | — | Research trackers | #14 | Research only. |

Per-issue sem-ver detail:

| # | Impact | Config | Theme | → Release | Depends on |
|---|--------|--------|-------|-----------|------------|
| #766 | minor | new sub-command | work breakdown | v1.42.0 | — |
| #14 | none | — | research | *(none)* | — |

## Remaining work — detail

### v1.42.0 — work breakdown (minor)

- **#766** — Epic decompose.
`;

const FAKE_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function samplePlan(overrides: Partial<DecomposeChildPlan>[] = []): DecomposePlan {
  const base: DecomposeChildPlan[] = [
    {
      key: "cli-dispatch",
      title: "Add decompose CLI dispatch",
      summary: "Operators can invoke pipeline decompose against an epic.",
      user_story: "As an operator,\nI want a decompose command,\nso that I can break down epics.",
      acceptance_criteria: [
        "Running pipeline decompose --epic N prints a child plan without writes.",
        "pipeline --help lists decompose.",
      ],
      out_of_scope: ["Desk UI"],
      effort: "S",
      depends_on_keys: [],
      depends_on_issue_numbers: [],
    },
    {
      key: "child-create",
      title: "Create child issues under apply",
      summary: "Apply creates labeled children with dependency edges.",
      user_story: "As an operator,\nI want children created with deps,\nso that loop can schedule them.",
      acceptance_criteria: [
        "pipeline decompose --epic N --apply creates child issues.",
        "Each child body references the parent epic.",
      ],
      out_of_scope: ["Auto-merge"],
      effort: "M",
      depends_on_keys: ["cli-dispatch"],
      depends_on_issue_numbers: [],
    },
  ];
  return {
    children: overrides.length
      ? overrides.map((o, i) => ({
          ...base[Math.min(i, base.length - 1)]!,
          ...o,
          key: o.key ?? `k${i}`,
          depends_on_issue_numbers: o.depends_on_issue_numbers ?? [],
        }))
      : base,
  };
}

function planJson(plan: DecomposePlan = samplePlan()): string {
  return JSON.stringify(plan, null, 2);
}

function makeDeps(overrides: Partial<DecomposeDeps> = {}): DecomposeDeps & {
  _createIssueCalls: Array<{ title: string; body: string; labels: string[] }>;
  _createPRCalls: Array<{ title: string; body: string; base: string; head: string }>;
  _addLabelsCalls: Array<{ issue: number; labels: string[] }>;
  _ensureLabelCalls: Array<{ name: string; color: string }>;
  _logLines: string[];
  _existingChildren: Array<{ number: number; body: string }>;
  _lockCalls: Array<{ domain: string; epic: number }>;
} {
  const createIssueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const createPRCalls: Array<{ title: string; body: string; base: string; head: string }> = [];
  const addLabelsCalls: Array<{ issue: number; labels: string[] }> = [];
  const ensureLabelCalls: Array<{ name: string; color: string }> = [];
  const logLines: string[] = [];
  const lockCalls: Array<{ domain: string; epic: number }> = [];
  let nextIssue = 1000;
  const existingChildren: Array<{ number: number; body: string }> = [];
  // Simple mutex for concurrent-apply tests (injectable, no real /tmp lock).
  let lockHeld = false;

  const base: DecomposeDeps = {
    getIssue: async (n) => ({
      number: n,
      title: "Epic: work breakdown capability",
      body: "Multi-capability feature that needs splitting into small children.",
      labels: [],
      state: "open",
    }),
    createIssue: async (title, body, labels) => {
      createIssueCalls.push({ title, body, labels });
      const num = nextIssue++;
      existingChildren.push({ number: num, body });
      return num;
    },
    addLabels: async (issue, labels) => {
      addLabelsCalls.push({ issue, labels });
    },
    ensureLabel: async (_dir, name, color) => {
      ensureLabelCalls.push({ name, color });
    },
    listOpenIssues: async () =>
      existingChildren.map((c) => ({
        number: c.number,
        title: "child",
        body: c.body,
        labels: [],
      })),
    runHarness: async () => ({ success: true, output: planJson() }),
    gitResolveBaseSha: () => FAKE_BASE_SHA,
    readFileAtBase: (_dir, _ref, relPath) => {
      if (relPath === "ROADMAP.md") return ROADMAP_FIXTURE;
      throw new Error(`readFileAtBase not mocked for ${relPath}`);
    },
    readFile: (p) => {
      if (p.endsWith("ROADMAP.md")) return ROADMAP_FIXTURE;
      throw new Error(`readFile not mocked for ${p}`);
    },
    writeFile: () => {},
    withEpicApplyLock: async (domain, epic, fn) => {
      lockCalls.push({ domain, epic });
      if (lockHeld) {
        throw new Error(
          `Pipeline lock held by another process for #${epic} (test mutex)`,
        );
      }
      lockHeld = true;
      try {
        return await fn();
      } finally {
        lockHeld = false;
      }
    },
    withThrowawayWorktree: async (_repoDir, _branch, _baseRef, fn) =>
      fn("/tmp/decompose-throwaway-wt"),
    reserveRemoteBranch: () => {},
    gitPushBranch: () => {},
    gitCommit: () => {},
    createPR: async (_dir, title, body, base, head) => {
      createPRCalls.push({ title, body, base, head });
      return "https://github.com/owner/repo/pull/77";
    },
    randomToken: () => "tokabc",
    log: (msg) => logLines.push(msg),
    ...overrides,
  };

  const wrapped = base as ReturnType<typeof makeDeps>;
  wrapped._createIssueCalls = createIssueCalls;
  wrapped._createPRCalls = createPRCalls;
  wrapped._addLabelsCalls = addLabelsCalls;
  wrapped._ensureLabelCalls = ensureLabelCalls;
  wrapped._logLines = logLines;
  wrapped._existingChildren = existingChildren;
  wrapped._lockCalls = lockCalls;
  return wrapped;
}

const DEFAULT_CFG = {
  repo_dir: "/fake/repo",
  repo: "owner/repo",
  base_branch: "main",
  domain: "repo",
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("decompose: parseDecomposePlan accepts valid plan", () => {
  const plan = parseDecomposePlan(planJson());
  assert.equal(plan.children.length, 2);
  assert.equal(plan.children[0]!.key, "cli-dispatch");
});

test("decompose: parseDecomposePlan rejects unknown depends_on_keys", () => {
  const bad = samplePlan();
  bad.children[1]!.depends_on_keys = ["missing-key"];
  assert.throws(() => parseDecomposePlan(JSON.stringify(bad)), /unknown key/);
});

test("decompose: parseDecomposePlan accepts depends_on_issue_numbers", () => {
  const plan = samplePlan();
  plan.children[1]!.depends_on_issue_numbers = [42, 99];
  const parsed = parseDecomposePlan(JSON.stringify(plan));
  assert.deepEqual(parsed.children[1]!.depends_on_issue_numbers, [42, 99]);
});

test("decompose: parseDecomposePlan rejects non-positive depends_on_issue_numbers", () => {
  const plan = samplePlan();
  const raw = JSON.parse(JSON.stringify(plan)) as {
    children: Array<Record<string, unknown>>;
  };
  raw.children[0]!.depends_on_issue_numbers = [0];
  assert.throws(
    () => parseDecomposePlan(JSON.stringify(raw)),
    /depends_on_issue_numbers/,
  );
});

test("decompose: detectDependencyCycle names A→B→A", () => {
  const cycle = detectDependencyCycle([
    { key: "a", depends_on_keys: ["b"] },
    { key: "b", depends_on_keys: ["a"] },
  ]);
  assert.ok(cycle);
  assert.ok(cycle!.includes("a") && cycle!.includes("b"));
});

test("decompose: checkPlanBounds refuses max-children overflow", () => {
  const plan = samplePlan([
    { key: "a", effort: "S", depends_on_keys: [] },
    { key: "b", effort: "S", depends_on_keys: [] },
    { key: "c", effort: "S", depends_on_keys: [] },
  ]);
  // samplePlan with overrides still needs full fields — use expanded children
  const full: DecomposePlan = {
    children: Array.from({ length: 3 }, (_, i) => ({
      ...samplePlan().children[0]!,
      key: `k${i}`,
      depends_on_keys: [],
    })),
  };
  const r = checkPlanBounds(full, 2, "M", false);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /max-children/);
});

test("decompose: checkPlanBounds refuses XL without allowXl", () => {
  const plan: DecomposePlan = {
    children: [{ ...samplePlan().children[0]!, effort: "XL" }],
  };
  const r = checkPlanBounds(plan, 12, "M", false);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /XL/);
});

test("decompose: checkPlanBounds allows XL with allowXl", () => {
  const plan: DecomposePlan = {
    children: [{ ...samplePlan().children[0]!, effort: "XL" }],
  };
  const r = checkPlanBounds(plan, 12, "M", true);
  assert.equal(r.ok, true);
});

test("decompose: provenance marker round-trip", () => {
  const marker = renderProvenanceMarker(123, "cli-dispatch");
  const parsed = parseProvenanceMarker(`head\n${marker}\ntail`);
  assert.deepEqual(parsed, { parent: 123, key: "cli-dispatch" });
});

test("decompose: buildChildBody is grammar-legal for depends_on", () => {
  const child = samplePlan().children[1]!;
  const body = buildChildBody(child, 123, [10, 11]);
  assert.ok(body.includes("Parent epic: #123"));
  assert.ok(body.includes(renderProvenanceMarker(123, child.key)));
  const deps = parseDeclaredDependencyIds(body);
  assert.deepEqual(deps, ["10", "11"]);
});

test("decompose: triageLabelForChild ready vs backlog", () => {
  const ready = samplePlan().children[0]!;
  assert.equal(triageLabelForChild(ready), "pipeline:ready");
  assert.equal(
    triageLabelForChild({ ...ready, open_questions: ["Which API?"] }),
    "pipeline:backlog",
  );
});

test("decompose: topoSort puts deps first", () => {
  const ordered = topoSort(samplePlan().children);
  assert.equal(ordered[0]!.key, "cli-dispatch");
  assert.equal(ordered[1]!.key, "child-create");
});

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

test("decompose: dry-run prints plan and performs zero writes", async () => {
  const deps = makeDeps();
  const opts: DecomposeOpts = { epic: 123, apply: false };
  await runDecompose(opts, DEFAULT_CFG, deps);
  assert.equal(deps._createIssueCalls.length, 0);
  assert.equal(deps._createPRCalls.length, 0);
  assert.equal(deps._addLabelsCalls.length, 0);
  assert.equal(deps._ensureLabelCalls.length, 0);
  const log = deps._logLines.join("\n");
  assert.match(log, /dry-run/);
  assert.match(log, /--apply/);
  assert.match(log, /cli-dispatch/);
  assert.match(log, /child-create/);
});

// ---------------------------------------------------------------------------
// Apply happy path
// ---------------------------------------------------------------------------

test("decompose: apply creates children, labels parent, opens ROADMAP PR once", async () => {
  const deps = makeDeps();
  const opts: DecomposeOpts = { epic: 123, apply: true, release: "v1.42.0" };
  await runDecompose(opts, DEFAULT_CFG, deps);

  assert.equal(deps._createIssueCalls.length, 2);
  assert.ok(
    deps._addLabelsCalls.some(
      (c) => c.issue === 123 && c.labels.includes(EPIC_LABEL),
    ),
    "parent should receive pipeline:epic",
  );
  for (const call of deps._createIssueCalls) {
    assert.ok(call.body.includes("Parent epic: #123"));
    assert.ok(parseProvenanceMarker(call.body));
    assert.ok(
      call.labels.includes("pipeline:ready") || call.labels.includes("pipeline:backlog"),
    );
    assert.ok(call.labels.includes("release:v1.42.0"));
  }
  // Second child depends on first — body should reference first issue number.
  const second = deps._createIssueCalls[1]!;
  const firstNum = 1000;
  assert.ok(second.body.includes(`#${firstNum}`));
  assert.equal(deps._createPRCalls.length, 1);
  assert.equal(deps._createPRCalls[0]!.base, "main");
  assert.match(deps._createPRCalls[0]!.title, /decompose/);
});

test("decompose: incomplete child labeled backlog", async () => {
  const plan: DecomposePlan = {
    children: [
      {
        ...samplePlan().children[0]!,
        open_questions: ["Need product decision on auth"],
      },
    ],
  };
  const deps = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(plan) }),
  });
  await runDecompose({ epic: 5, apply: true, release: "1.42.0" }, DEFAULT_CFG, deps);
  assert.equal(deps._createIssueCalls.length, 1);
  assert.ok(deps._createIssueCalls[0]!.labels.includes("pipeline:backlog"));
  assert.ok(!deps._createIssueCalls[0]!.labels.includes("pipeline:ready"));
});

// ---------------------------------------------------------------------------
// Fail-closed paths
// ---------------------------------------------------------------------------

test("decompose: cycle fails dry-run with no creates", async () => {
  const plan: DecomposePlan = {
    children: [
      { ...samplePlan().children[0]!, key: "a", depends_on_keys: ["b"] },
      { ...samplePlan().children[0]!, key: "b", depends_on_keys: ["a"] },
    ],
  };
  const deps = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(plan) }),
  });
  await assert.rejects(
    () => runDecompose({ epic: 1, apply: false }, DEFAULT_CFG, deps),
    /cycle/i,
  );
  assert.equal(deps._createIssueCalls.length, 0);
});

test("decompose: cycle fails apply before creates", async () => {
  const plan: DecomposePlan = {
    children: [
      { ...samplePlan().children[0]!, key: "a", depends_on_keys: ["b"] },
      { ...samplePlan().children[0]!, key: "b", depends_on_keys: ["a"] },
    ],
  };
  const deps = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(plan) }),
  });
  await assert.rejects(
    () => runDecompose({ epic: 1, apply: true }, DEFAULT_CFG, deps),
    /cycle/i,
  );
  assert.equal(deps._createIssueCalls.length, 0);
  assert.equal(deps._createPRCalls.length, 0);
});

test("decompose: max-children exceeded fails before writes", async () => {
  const plan: DecomposePlan = {
    children: Array.from({ length: 5 }, (_, i) => ({
      ...samplePlan().children[0]!,
      key: `c${i}`,
      depends_on_keys: [],
    })),
  };
  const deps = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(plan) }),
  });
  await assert.rejects(
    () =>
      runDecompose(
        { epic: 1, apply: true, maxChildren: 3 },
        DEFAULT_CFG,
        deps,
      ),
    /max-children/,
  );
  assert.equal(deps._createIssueCalls.length, 0);
});

test("decompose: XL without override fails before creates", async () => {
  const plan: DecomposePlan = {
    children: [{ ...samplePlan().children[0]!, effort: "XL" }],
  };
  const deps = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(plan) }),
  });
  await assert.rejects(
    () => runDecompose({ epic: 1, apply: true }, DEFAULT_CFG, deps),
    /XL/,
  );
  assert.equal(deps._createIssueCalls.length, 0);
});

test("decompose: missing epic fails before harness writes", async () => {
  const deps = makeDeps({
    getIssue: async () => {
      throw new Error("gh: Not Found");
    },
  });
  let harnessCalls = 0;
  deps.runHarness = async () => {
    harnessCalls += 1;
    return { success: true, output: planJson() };
  };
  await assert.rejects(
    () => runDecompose({ epic: 99999, apply: true }, DEFAULT_CFG, deps),
    /not found|inaccessible/i,
  );
  assert.equal(harnessCalls, 0);
  assert.equal(deps._createIssueCalls.length, 0);
});

test("decompose: missing epic number in opts throws usage error", async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => runDecompose({ epic: 0, apply: false }, DEFAULT_CFG, deps),
    /--epic/,
  );
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("decompose: second apply does not duplicate children", async () => {
  const deps = makeDeps();
  await runDecompose({ epic: 123, apply: true, release: "1.42.0" }, DEFAULT_CFG, deps);
  assert.equal(deps._createIssueCalls.length, 2);
  const afterFirst = deps._createIssueCalls.length;

  // Seed listOpenIssues from bodies already created (makeDeps already tracks them).
  await runDecompose({ epic: 123, apply: true, release: "1.42.0" }, DEFAULT_CFG, deps);
  assert.equal(
    deps._createIssueCalls.length,
    afterFirst,
    "second apply must not create duplicate children",
  );
  // ROADMAP PR may still open (refresh path).
  assert.ok(deps._createPRCalls.length >= 1);
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("decompose: lookupCommand metadata", () => {
  const entry = lookupCommand("decompose");
  assert.ok(entry);
  assert.equal(entry!.needsIssueNumber, false);
  assert.equal(entry!.mutatesGitHub, true);
  assert.equal(entry!.needsConfig, true);
  assert.equal(entry!.needsGhAuth, true);
  const flags = entry!.allowedFlags as Set<string>;
  for (const f of ["epic", "description", "apply", "release", "maxChildren", "maxEffort", "allowXl"]) {
    assert.ok(flags.has(f), `allowedFlags should include ${f}`);
  }
});

test("decompose: unsupported flag rejected with exit semantics via validateFlags", () => {
  const entry = COMMAND_REGISTRY.decompose;
  const cmd = {
    options: [{ attributeName: () => "json" }],
    getOptionValueSource: (k: string) => (k === "json" ? "cli" : "default"),
  };
  const offending = validateFlags(entry, cmd);
  assert.deepEqual(offending, ["json"]);
});

// ---------------------------------------------------------------------------
// Parent exclusion in loop selectors
// ---------------------------------------------------------------------------

test("decompose: milestone selector excludes pipeline:epic; work-list keeps it", async () => {
  const issues: SelectorOpenIssue[] = [
    { number: 9, labels: [EPIC_LABEL, "pipeline:ready"], milestone: "v1.42.0" },
    { number: 10, labels: ["pipeline:ready"], milestone: "v1.42.0" },
    { number: 11, labels: ["pipeline:ready"], milestone: "v1.42.0" },
  ];
  const deps: SelectorResolveDeps = {
    listOpenIssues: async () => issues,
    readRoadmap: async () => "",
  };
  const cfg = { repo: "acme/w", repo_dir: "/tmp/x" } as unknown as PipelineConfig;

  const milestone = await resolveSelectorIssues(
    cfg,
    { type: "milestone", value: "v1.42.0" },
    deps,
  );
  assert.deepEqual(milestone, ["10", "11"]);

  const workList = await resolveSelectorIssues(
    cfg,
    { type: "work-list", value: ["9"] },
    deps,
  );
  assert.deepEqual(workList, ["9"]);

  const label = await resolveSelectorIssues(
    cfg,
    { type: "label", value: "pipeline:ready" },
    deps,
  );
  assert.deepEqual(label, ["10", "11"]);
  assert.ok(isEpicLabeled([EPIC_LABEL]));
});

test("decompose: apply ROADMAP delivery uses throwaway worktree, not operator repo_dir", async () => {
  const operatorDir = "/fake/repo";
  const throwawayDir = "/tmp/decompose-throwaway-wt";
  const writePaths: string[] = [];
  const commitDirs: string[] = [];
  const pushDirs: string[] = [];
  const prDirs: string[] = [];
  let withWtCalls = 0;

  const deps = makeDeps({
    withThrowawayWorktree: async (repoDir, _branch, _baseRef, fn) => {
      withWtCalls += 1;
      assert.equal(repoDir, operatorDir, "withThrowawayWorktree is rooted at operator repo");
      return fn(throwawayDir);
    },
    writeFile: (p) => {
      writePaths.push(p);
    },
    gitCommit: (dir) => {
      commitDirs.push(dir);
    },
    gitPushBranch: (dir) => {
      pushDirs.push(dir);
    },
    createPR: async (dir, title, body, base, head) => {
      prDirs.push(dir);
      return `https://github.com/owner/repo/pull/77?title=${encodeURIComponent(title)}&base=${base}&head=${head}&body=${body.length}`;
    },
  });

  await runDecompose(
    { epic: 123, apply: true, release: "1.42.0" },
    { ...DEFAULT_CFG, repo_dir: operatorDir },
    deps,
  );

  assert.equal(withWtCalls, 1, "must open a throwaway worktree for ROADMAP delivery");
  assert.ok(
    writePaths.every((p) => p.startsWith(throwawayDir)),
    `ROADMAP writes must be in throwaway, got: ${writePaths.join(", ")}`,
  );
  assert.ok(
    !writePaths.some((p) => p === `${operatorDir}/ROADMAP.md` || p.startsWith(`${operatorDir}/`)),
    "must not write ROADMAP into operator checkout",
  );
  assert.deepEqual(commitDirs, [throwawayDir]);
  assert.deepEqual(pushDirs, [throwawayDir]);
  assert.deepEqual(prDirs, [throwawayDir]);
  assert.equal(deps._createIssueCalls.length, 2);
});

test("decompose: roadmap-slice excludes pipeline:epic parents", async () => {
  const roadmap = [
    "**v1.42.0 — Slice:**",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #9 | Epic umbrella | parent |",
    "| #10 | Child A | work |",
    "| #11 | Child B | work |",
  ].join("\n");
  const deps: SelectorResolveDeps = {
    listOpenIssues: async () => [
      { number: 9, labels: [EPIC_LABEL], milestone: null },
      { number: 10, labels: ["pipeline:ready"], milestone: null },
      { number: 11, labels: ["pipeline:ready"], milestone: null },
    ],
    readRoadmap: async () => roadmap,
  };
  const cfg = { repo: "acme/w", repo_dir: "/tmp/x" } as unknown as PipelineConfig;
  const issues = await resolveSelectorIssues(
    cfg,
    { type: "roadmap-slice", value: "v1.42.0" },
    deps,
  );
  assert.deepEqual(issues, ["10", "11"]);
});

test("decompose: roadmap-slice fails closed when epic inventory cannot load", async () => {
  const roadmap = [
    "**v1.42.0 — Slice:**",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #9 | Epic umbrella | parent |",
    "| #10 | Child A | work |",
  ].join("\n");
  const deps: SelectorResolveDeps = {
    listOpenIssues: async () => {
      throw new Error("gh api rate limited");
    },
    readRoadmap: async () => roadmap,
  };
  const cfg = { repo: "acme/w", repo_dir: "/tmp/x" } as unknown as PipelineConfig;
  await assert.rejects(
    () =>
      resolveSelectorIssues(cfg, { type: "roadmap-slice", value: "v1.42.0" }, deps),
    /cannot load open-issue inventory|pipeline:epic/,
  );
});

// ---------------------------------------------------------------------------
// Existing-issue dependencies (#766 review 2 — 7b2118d6)
// ---------------------------------------------------------------------------

test("decompose: apply writes depends_on_issue_numbers into child body via grammar", async () => {
  const plan: DecomposePlan = {
    children: [
      {
        ...samplePlan().children[0]!,
        key: "follow-on",
        depends_on_keys: [],
        depends_on_issue_numbers: [42, 55],
      },
    ],
  };
  const deps = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(plan) }),
  });
  await runDecompose(
    { epic: 123, apply: true, release: "1.42.0" },
    DEFAULT_CFG,
    deps,
  );
  assert.equal(deps._createIssueCalls.length, 1);
  const body = deps._createIssueCalls[0]!.body;
  const parsed = parseDeclaredDependencyIds(body);
  assert.ok(parsed.includes("42"), `body should declare #42, got ${parsed.join(",")}`);
  assert.ok(parsed.includes("55"), `body should declare #55, got ${parsed.join(",")}`);
});

test("decompose: dry-run prints existing-issue deps", async () => {
  const plan: DecomposePlan = {
    children: [
      {
        ...samplePlan().children[0]!,
        key: "follow-on",
        depends_on_keys: [],
        depends_on_issue_numbers: [42],
      },
    ],
  };
  const deps = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(plan) }),
  });
  await runDecompose({ epic: 123, apply: false }, DEFAULT_CFG, deps);
  const log = deps._logLines.join("\n");
  assert.match(log, /#42/);
  assert.equal(deps._createIssueCalls.length, 0);
});

test("decompose: resolveChildDependencyNumbers merges existing + sibling keys", () => {
  const child: DecomposeChildPlan = {
    ...samplePlan().children[1]!,
    depends_on_keys: ["cli-dispatch"],
    depends_on_issue_numbers: [42],
  };
  const nums = resolveChildDependencyNumbers(
    child,
    new Map([["cli-dispatch", 1000]]),
  );
  assert.deepEqual(nums, [42, 1000]);
});

// ---------------------------------------------------------------------------
// Concurrent apply serialization (#766 review 2 — e9312c5c)
// ---------------------------------------------------------------------------

test("decompose: apply acquires epic lock before provenance discovery", async () => {
  const deps = makeDeps();
  let listCallsDuringLock = 0;
  let insideLock = false;
  deps.withEpicApplyLock = async (domain, epic, fn) => {
    deps._lockCalls.push({ domain, epic });
    assert.equal(epic, 123);
    assert.equal(domain, "repo");
    insideLock = true;
    try {
      return await fn();
    } finally {
      insideLock = false;
    }
  };
  const origList = deps.listOpenIssues.bind(deps);
  deps.listOpenIssues = async () => {
    if (insideLock) listCallsDuringLock += 1;
    return origList();
  };
  await runDecompose(
    { epic: 123, apply: true, release: "1.42.0" },
    DEFAULT_CFG,
    deps,
  );
  assert.ok(deps._lockCalls.length >= 1, "must call withEpicApplyLock");
  assert.ok(
    listCallsDuringLock >= 1,
    "provenance listOpenIssues must run under the epic apply lock",
  );
  assert.equal(deps._createIssueCalls.length, 2);
});

test("decompose: concurrent applies serialize so second reuses first creates", async () => {
  // Shared store + mutex simulates two simultaneous applies for the same epic.
  const sharedChildren: Array<{ number: number; body: string }> = [];
  let nextIssue = 2000;
  let lockHeld = false;
  const waiters: Array<() => void> = [];
  const createCalls: string[] = [];

  const makeConcurrentDeps = (): DecomposeDeps & {
    _creates: string[];
  } => {
    const deps = makeDeps({
      listOpenIssues: async () =>
        sharedChildren.map((c) => ({
          number: c.number,
          title: "child",
          body: c.body,
          labels: [],
        })),
      createIssue: async (title, body, labels) => {
        createCalls.push(title);
        const num = nextIssue++;
        sharedChildren.push({ number: num, body });
        return num;
      },
      withEpicApplyLock: async (_domain, _epic, fn) => {
        // Queue while held — proves serialization, not parallel creates.
        while (lockHeld) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        lockHeld = true;
        try {
          return await fn();
        } finally {
          lockHeld = false;
          const next = waiters.shift();
          if (next) next();
        }
      },
    });
    return Object.assign(deps, { _creates: createCalls });
  };

  const depsA = makeConcurrentDeps();
  const depsB = makeConcurrentDeps();

  // Overlap: start A, let it enter create of first child, then start B.
  // Full concurrent Promise.all with shared lock still serializes creates.
  await Promise.all([
    runDecompose(
      { epic: 123, apply: true, release: "1.42.0" },
      DEFAULT_CFG,
      depsA,
    ),
    runDecompose(
      { epic: 123, apply: true, release: "1.42.0" },
      DEFAULT_CFG,
      depsB,
    ),
  ]);

  // Exactly one create per plan key (2 children), not 4.
  assert.equal(
    createCalls.length,
    2,
    `concurrent applies must not duplicate children; creates=${createCalls.length} titles=${createCalls.join(" | ")}`,
  );
  // Shared store has exactly two provenance children for epic 123.
  const byKey = indexProvenanceByKey(
    sharedChildren.map((c) => ({
      number: c.number,
      title: "c",
      body: c.body,
    })),
    123,
  );
  assert.equal(byKey.size, 2);
});
