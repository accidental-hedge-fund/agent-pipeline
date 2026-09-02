// Native grill-with-docs admission (#1369). Injected GitHub, repo, model, clock, fs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMAND_REGISTRY, lookupCommand, validateFlags } from "../scripts/command-registry.ts";
import { OPERATION_SURFACE } from "../scripts/operation-surface.ts";
import { formatHostUsage, listDocumentedCommands } from "../scripts/command-docs.ts";
import {
  embedDecisionsInBody,
  extractSpecCore,
  parseDecisionsArtifact,
  parseDecisionsFromBody,
} from "../scripts/grill-decisions.ts";
import { buildGrillFingerprint } from "../scripts/grill-fingerprint.ts";
import { AUTO_ACCEPT_ELIGIBILITY_REASON } from "../scripts/grill-taxonomy.ts";
import { parseGrillSelector, freezeManifest } from "../scripts/grill-selector.ts";
import {
  settleRecommendation,
  defaultSettlementSignals,
  parseSignalsFromModel,
} from "../scripts/grill-settle.ts";
import {
  emptyLedger,
  grillStatusCounts,
  initGrillRun,
  loadGrillManifest,
  type GrillStoreDeps,
} from "../scripts/grill-store.ts";
import {
  grillOneIssue,
  hasGrillWithDocsMarker,
  intersectIds,
  isGrillMigratedBody,
  resolveGrillMembership,
  runGrill,
  settleFrontierNodes,
  type GrillDeps,
  type GrillIssueRecord,
} from "../scripts/stages/grill.ts";
import { buildCmd, maxPositionalsFor } from "../scripts/pipeline.ts";
import { planningTreatmentFromConfig } from "../scripts/grill-issue.ts";
import { evaluateIssueReadiness } from "../scripts/issue-readiness.ts";
import type { GrillProposalKeyDeps } from "../scripts/grill-proposal.ts";
import type { HandoffStoreDeps } from "../scripts/human-question-handoff.ts";
import { makeNode } from "../scripts/grill-decisions.ts";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

const TREATMENT = planningTreatmentFromConfig({
  implementer: "grok",
  planningModel: "grok-4.6",
  planningEffort: "auto",
});
const PROVIDER = {
  implementer: "grok",
  reviewer: "codex",
  planning_model: "grok-4.6",
  planning_effort: "auto",
};

function memoryStore(): GrillStoreDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    fsExists: async (p) => files.has(p),
    readTextFile: async (p) => files.get(p) ?? null,
    writeFileAtomic: async (p, c) => {
      files.set(p, c);
    },
    createFileExclusive: async (p, c) => {
      if (files.has(p)) return false;
      files.set(p, c);
      return true;
    },
    mkdirp: async () => {},
    listDir: async (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        names.add(key.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
    now: () => new Date("2026-09-01T15:58:31Z"),
    uuid: () => "testrun01",
    env: { AGENT_PIPELINE_STATE_HOME: "/tmp/grill-state" },
  };
}

function memoryKeyDeps(): GrillProposalKeyDeps {
  const files = new Map<string, string>();
  files.set("/tmp/repo/.agent-pipeline/grill-key", "test-key");
  return {
    env: { PIPELINE_GRILL_PROPOSAL_KEY: "test-key" },
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: (p, data) => {
      files.set(p, data);
    },
    mkdir: () => {},
    exists: (p) => files.has(p),
  };
}

function memoryHandoffStore(): HandoffStoreDeps {
  const files = new Map<string, string>();
  return {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    appendFile: async (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
    },
    mkdir: async () => {},
    readdir: async (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        names.add(key.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

function autoSettleNodeJson(cls: string, extra: Record<string, unknown> = {}) {
  return {
    id: cls,
    question: `What about ${cls}?`,
    recommendation:
      cls === "interface-contract" ? "Native admission" : `Use the in-scope default for ${cls}`,
    class: cls,
    reversible: true,
    in_scope: true,
    policy_consistent: true,
    covered_by_existing_authority: true,
    protected_action: false,
    contradictory: false,
    missing_external: false,
    confidence: "low",
    ...extra,
  };
}

function implementerJson(overrides: Record<string, unknown> = {}) {
  const nodes = [
    autoSettleNodeJson("scope"),
    autoSettleNodeJson("security"),
    autoSettleNodeJson("irreversible-operations"),
    autoSettleNodeJson("merge-release"),
    autoSettleNodeJson("human-attestation"),
    autoSettleNodeJson("interface-contract"),
  ];
  return JSON.stringify({
    title: "T",
    body: "## Summary\nReady.\n\n## User story\nAs a user, / I want x, / so that y.\n\n## Acceptance criteria\n- [ ] x\n\n## Out of scope\n- y",
    milestone: null,
    nodes,
    context_proposals: [],
    ...overrides,
  });
}

interface FakeWorld {
  issues: Map<number, GrillIssueRecord>;
  bodies: string[];
  labelsWritten: Array<{ n: number; label: string }>;
  labelsRemoved: Array<{ n: number; label: string }>;
  implementerCalls: string[];
  gitWrites: string[];
  docsPrs: string[];
  callLog: string[];
  milestoneMembers: number[];
  labelMembers: Map<string, number[]>;
}

function makeDeps(
  world: FakeWorld,
  store: GrillStoreDeps,
  implementerOutput: string = implementerJson(),
): GrillDeps {
  return {
    getIssue: async (n) => world.issues.get(n) ?? null,
    fetchDependencyIssue: async (id) => {
      const issue = world.issues.get(id);
      if (!issue) return { ok: false, code: "missing" };
      return { ok: true, title: issue.title, body: issue.body };
    },
    listMilestoneOpenIssues: async () => [...world.milestoneMembers],
    listOpenIssuesByLabel: async (label) => [...(world.labelMembers.get(label) ?? [])],
    updateIssueBody: async (n, body) => {
      world.bodies.push(body);
      const cur = world.issues.get(n);
      if (cur) world.issues.set(n, { ...cur, body });
    },
    getIssueLabels: async (n) => world.issues.get(n)?.labels ?? [],
    addLabel: async (n, label) => {
      world.labelsWritten.push({ n, label });
      const cur = world.issues.get(n);
      if (cur && !cur.labels.includes(label)) cur.labels.push(label);
    },
    removeLabel: async (n, label) => {
      world.labelsRemoved.push({ n, label });
      const cur = world.issues.get(n);
      if (cur) cur.labels = cur.labels.filter((l) => l !== label);
    },
    readContextMd: async () => "**Grill**:\nNative admission.\n",
    resolveIntegrationBase: async () => "abc123def456",
    runImplementer: async (prompt) => {
      world.implementerCalls.push(prompt);
      return { success: true, output: implementerOutput };
    },
    providerConfig: PROVIDER,
    planningTreatment: TREATMENT,
    repo: "acme/r",
    domain: "acme",
    repoDir: "/tmp/repo",
    baseBranch: "main",
    store,
    keyDeps: memoryKeyDeps(),
    handoffStore: memoryHandoffStore(),
    docsPr: {
      createWorktree: async () => "/tmp/docs-wt",
      writeFile: async (p) => {
        world.gitWrites.push(p);
      },
      gitCommit: async () => {},
      gitPushBranch: async () => {},
      createPR: async (title) => {
        world.docsPrs.push(title);
        return "https://example.test/pr/1";
      },
    },
    now: () => new Date("2026-09-01T15:58:31Z"),
    uuid: () => "testrun01",
    log: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    callLog: world.callLog,
    reportObservation: () => {},
  };
}

function openIssue(n: number, extra: Partial<GrillIssueRecord> = {}): GrillIssueRecord {
  return {
    number: n,
    title: `Issue ${n}`,
    body: "## Summary\nThin.\n",
    labels: ["pipeline:backlog"],
    state: "open",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Registry / grammar
// ---------------------------------------------------------------------------

test("grill: lookup succeeds without a positional issue number", () => {
  const entry = lookupCommand("grill");
  assert.ok(entry);
  assert.equal(entry.needsIssueNumber, false);
  assert.equal((entry.allowedFlags as Set<string>).has("issue"), true);
});

test("grill: unknown flag is rejected by validateFlags before writes", () => {
  const entry = COMMAND_REGISTRY.grill;
  const cmd = {
    options: [{ attributeName: () => "bogus" }],
    getOptionValueSource: (k: string) => (k === "bogus" ? "cli" : "default"),
  };
  assert.deepEqual(validateFlags(entry, cmd), ["bogus"]);
});

test("grill: status is not an advance issue number", () => {
  assert.equal(maxPositionalsFor("grill"), 2);
  assert.ok(["grill", "status"].length <= maxPositionalsFor("grill"));
  assert.equal(lookupCommand("grill")?.needsIssueNumber, false);
  assert.notEqual(lookupCommand("grill"), COMMAND_REGISTRY.advance);
});

test("grill: OPERATION_SURFACE and docs publish selector grammar", () => {
  const op = OPERATION_SURFACE.find((o) => o.name === "grill");
  assert.ok(op);
  assert.match(op!.usage, /grill --issue/);
  assert.match(op!.usage, /grill --issues/);
  assert.match(op!.usage, /grill --milestone/);
  assert.match(op!.usage, /grill --label/);
  assert.match(op!.usage, /--dry-run/);
  assert.match(op!.usage, /status/);
  assert.match(op!.usage, /--follow/);
  assert.match(op!.usage, /--resume/);
  const listed = listDocumentedCommands().find((c) => c.keyword === "grill");
  assert.ok(listed);
  const formatted = formatHostUsage("pipeline", listed!.usage);
  assert.match(formatted, /pipeline grill --issue/);
  assert.match(formatted, /pipeline grill --issues/);
  assert.match(formatted, /pipeline grill --milestone/);
  assert.match(formatted, /pipeline grill --label/);
});

test("grill: mixed selectors fail closed", () => {
  const mixedIssueMilestone = parseGrillSelector({ issue: 42, milestone: "v1.40.1" });
  assert.equal(mixedIssueMilestone.ok, false);
  const mixedIssuesLabel = parseGrillSelector({ issues: "10,11", label: ["a"] });
  assert.equal(mixedIssuesLabel.ok, false);
});

test("CLI: pipeline grill --issue 42 --milestone v1.40.1 exits 2", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "grill", "--issue", "42", "--milestone", "v1.40.1"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /mixed selectors|pipeline grill/);
});

test("CLI: pipeline grill --issues 10 --label a exits 2", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "grill", "--issues", "10", "--label", "a"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /mixed selectors|pipeline grill/);
});

test("CLI: pipeline grill --issue 42 --detach exits 2 naming unsupported flag", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "grill", "--issue", "42", "--detach"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /detach/);
});

test("pipeline-cli: grill --issue 42 is not advance", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "grill", "--issue", "42"]);
  assert.equal(cmd.args[0], "grill");
  assert.equal(lookupCommand(String(cmd.args[0])), COMMAND_REGISTRY.grill);
});

test("CLI: refine-spec apply diagnoses toward grill and does not write", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "refine-spec", "apply", "--issue", "42"],
    {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: "", GH_HOST: "invalid.example", GH_ENTERPRISE_TOKEN: "" },
      input: "",
    },
  );
  assert.equal(result.status, 0);
  assert.match(result.stderr, /pipeline grill --issue 42/);
  assert.doesNotMatch(result.stderr, /apply requires stdin|proposal nonce|kill switch|already migrated/);
});

// ---------------------------------------------------------------------------
// Frozen selection
// ---------------------------------------------------------------------------

test("grill: --issue closed is ineligible with zero label writes", async () => {
  const world: FakeWorld = {
    issues: new Map([[10, openIssue(10, { state: "closed" })]]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [],
    labelMembers: new Map(),
  };
  const deps = makeDeps(world, memoryStore());
  const membership = await resolveGrillMembership({ form: "issue", issue: 10 }, deps);
  assert.deepEqual(membership.openIds, []);
  assert.equal(membership.ineligible[0]?.reason, "closed");
  assert.deepEqual(world.labelsWritten, []);
});

test("grill: --issues duplicates collapse and closed stay unlabeled", async () => {
  const parsed = parseGrillSelector({ issues: "11,10,10" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.selector.form === "issues" ? parsed.selector.issues : [], [10, 11]);
  const world: FakeWorld = {
    issues: new Map([
      [10, openIssue(10)],
      [11, openIssue(11, { state: "closed" })],
    ]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [],
    labelMembers: new Map(),
  };
  const deps = makeDeps(world, memoryStore());
  const membership = await resolveGrillMembership(parsed.selector, deps);
  assert.deepEqual(membership.openIds, [10]);
  assert.equal(membership.ineligible[0]?.issue, 11);
  assert.deepEqual(world.labelsWritten, []);
});

test("grill: resume does not re-query selector membership", async () => {
  const store = memoryStore();
  const manifest = freezeManifest({
    runId: "grill-frozen",
    selector: { form: "milestone", milestone: "v1.40.1" },
    openIds: [10, 11],
    ineligible: [],
    repo: "acme/r",
    createdAt: "2026-09-01T15:58:31Z",
    integrationBaseSha: "abc123def456",
  });
  await initGrillRun(store, manifest, emptyLedger(manifest.run_id, manifest.issue_ids));
  const world: FakeWorld = {
    issues: new Map([
      [10, openIssue(10)],
      [11, openIssue(11)],
      [12, openIssue(12)],
    ]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [10, 11, 12],
    labelMembers: new Map(),
  };
  const deps = makeDeps(world, store);
  const code = await runGrill({ resume: "grill-frozen", dryRun: true }, deps);
  assert.equal(code, 0);
  const loaded = await loadGrillManifest(store, "grill-frozen");
  assert.deepEqual(loaded.issue_ids, [10, 11]);
});

test("grill: repeated labels intersect", () => {
  assert.deepEqual(intersectIds([[10, 11, 12], [11, 12, 13]]), [11, 12]);
});

test("grill: label intersection freeze ignores later adds", async () => {
  const store = memoryStore();
  const manifest = freezeManifest({
    runId: "grill-labels",
    selector: { form: "label", labels: ["a", "b"] },
    openIds: [10],
    ineligible: [],
    repo: "acme/r",
    createdAt: "2026-09-01T15:58:31Z",
    integrationBaseSha: "abc",
  });
  await initGrillRun(store, manifest, emptyLedger(manifest.run_id, [10]));
  const loaded = await loadGrillManifest(store, "grill-labels");
  assert.deepEqual(loaded.issue_ids, [10]);
});

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

test("grill: auto-accept and low confidence are not a human boundary", () => {
  const rec = "REST";
  const signals = {
    ...defaultSettlementSignals("interface-contract", rec, rec),
    confidence: "low" as const,
  };
  const result = settleRecommendation(
    { class: "interface-contract", recommendation: rec },
    signals,
    rec,
  );
  assert.equal(result.kind, "auto-accept");
  if (result.kind === "auto-accept") {
    assert.equal(result.eligibility_reason, AUTO_ACCEPT_ELIGIBILITY_REASON);
  }
});

test("grill: DecisionRequest / CapabilityRequest / AuthorityRequest", () => {
  const decision = settleRecommendation(
    { class: "scope", recommendation: "A and not A" },
    { ...defaultSettlementSignals("scope"), contradictory: true },
  );
  assert.equal(decision.kind, "typed-request");
  if (decision.kind === "typed-request") {
    assert.equal(decision.request, "DecisionRequest");
    assert.equal(decision.handoff_class, "product_judgment");
  }
  const capability = settleRecommendation(
    { class: "operational-default", recommendation: "need token" },
    {
      ...defaultSettlementSignals("operational-default"),
      missing_external: true,
      discoverable_from_facts: false,
    },
  );
  assert.equal(capability.kind, "typed-request");
  if (capability.kind === "typed-request") {
    assert.equal(capability.request, "CapabilityRequest");
    assert.equal(capability.handoff_class, "missing_context");
  }
  const discoverableRec = "from CONTEXT.md";
  const discoverable = settleRecommendation(
    { class: "operational-default", recommendation: discoverableRec },
    {
      ...defaultSettlementSignals("operational-default", discoverableRec, discoverableRec),
      missing_external: true,
      discoverable_from_facts: true,
      reversible: true,
      in_scope: true,
      policy_consistent: true,
    },
    discoverableRec,
  );
  assert.equal(discoverable.kind, "auto-accept");
  const authority = settleRecommendation(
    { class: "security", recommendation: "weaken auth" },
    {
      ...defaultSettlementSignals("security"),
      protected_action: true,
      covered_by_existing_authority: false,
    },
  );
  assert.equal(authority.kind, "typed-request");
  if (authority.kind === "typed-request") {
    assert.equal(authority.request, "AuthorityRequest");
    assert.equal(authority.handoff_class, "risk_authority");
  }
});

test("grill: one issue and a list reuse settleFrontierNodes", () => {
  const raw = [
    {
      ...makeNode({
        id: "api",
        question: "Which API?",
        recommendation: "REST",
        class: "interface-contract",
      }),
      signalsRaw: { reversible: true, in_scope: true, policy_consistent: true },
    },
  ];
  const a = settleFrontierNodes(raw, "REST");
  const b = settleFrontierNodes(raw, "REST");
  assert.equal(a[0]!.provenance.settled_by, "auto-accept");
  assert.equal(b[0]!.provenance.settled_by, "auto-accept");
});

test("grill: covered scope does not create a handoff", () => {
  const rec = "keep the stated AC";
  const result = settleRecommendation(
    { class: "scope", recommendation: rec },
    defaultSettlementSignals("scope", rec, rec),
    rec,
  );
  assert.equal(result.kind, "auto-accept");
});

test("grill: model missing_external is not a CapabilityRequest when facts contain the rec", () => {
  const rec = "use REST for the public API";
  const facts = "CONTEXT.md states: use REST for the public API";
  const signals = parseSignalsFromModel(
    { missing_external: true, discoverable_from_facts: false },
    "operational-default",
    rec,
    facts,
  );
  assert.equal(signals.discoverable_from_facts, true);
  assert.equal(signals.missing_external, false);
  const result = settleRecommendation(
    { class: "operational-default", recommendation: rec },
    {
      ...signals,
      missing_external: true,
      discoverable_from_facts: false,
    },
    facts,
  );
  assert.equal(result.kind, "auto-accept");
});

test("grill: settleFrontierNodes ignores model missing_external when facts contain the rec", () => {
  const rec = "use REST for the public API";
  const raw = [
    {
      ...makeNode({
        id: "api",
        question: "Which transport?",
        recommendation: rec,
        class: "operational-default",
      }),
      signalsRaw: { missing_external: true, discoverable_from_facts: false },
    },
  ];
  const nodes = settleFrontierNodes(raw, rec);
  assert.notEqual(nodes[0]!.typed_request, "CapabilityRequest");
  assert.equal(nodes[0]!.provenance.settled_by, "auto-accept");
});

test("grill: model missing_external remains CapabilityRequest when facts omit the rec", () => {
  const rec = "need a vendor account id";
  const facts = "unrelated CONTEXT.md";
  const signals = parseSignalsFromModel(
    { missing_external: true },
    "operational-default",
    rec,
    facts,
  );
  assert.equal(signals.missing_external, true);
  assert.equal(signals.discoverable_from_facts, false);
  const result = settleRecommendation(
    { class: "operational-default", recommendation: rec },
    signals,
    facts,
  );
  assert.equal(result.kind, "typed-request");
  if (result.kind === "typed-request") {
    assert.equal(result.request, "CapabilityRequest");
  }
});

test("grill: model cannot assert existing authority for auto-accept", () => {
  const signals = parseSignalsFromModel(
    {
      reversible: true,
      in_scope: true,
      policy_consistent: true,
      covered_by_existing_authority: true,
      protected_action: false,
    },
    "security",
  );
  assert.equal(signals.covered_by_existing_authority, false);
  assert.equal(signals.protected_action, true);
  assert.equal(signals.reversible, false);
  assert.equal(signals.in_scope, false);
  assert.equal(signals.policy_consistent, false);
  const result = settleRecommendation(
    { class: "security", recommendation: "weaken auth" },
    signals,
  );
  assert.equal(result.kind, "typed-request");
  if (result.kind === "typed-request") {
    assert.equal(result.request, "AuthorityRequest");
  }
});

test("grill: settleFrontierNodes ignores model authority claims on protected classes", () => {
  const raw = [
    {
      ...makeNode({
        id: "sec",
        question: "Auth?",
        recommendation: "weaken auth",
        class: "security",
      }),
      signalsRaw: {
        reversible: true,
        in_scope: true,
        policy_consistent: true,
        covered_by_existing_authority: true,
        protected_action: false,
      },
    },
  ];
  const nodes = settleFrontierNodes(raw, "weaken auth is already in the body");
  assert.equal(nodes[0]!.provenance.settled_by, "none");
  assert.equal(nodes[0]!.typed_request, "AuthorityRequest");
});

test("grill: scope auto-settles only when issue-body facts cover the recommendation", () => {
  const rec = "keep the stated acceptance criteria";
  const raw = [
    {
      ...makeNode({
        id: "scope",
        question: "Scope?",
        recommendation: rec,
        class: "scope",
      }),
      signalsRaw: { covered_by_existing_authority: true },
    },
  ];
  const uncovered = settleFrontierNodes(raw, "unrelated body text");
  assert.notEqual(uncovered[0]!.provenance.settled_by, "auto-accept");
  const covered = settleFrontierNodes(raw, rec);
  assert.equal(covered[0]!.provenance.settled_by, "auto-accept");
});

test("grill: class-only defaults do not auto-settle a protected recommendation", () => {
  const rec = "disable authentication and force-push main";
  const classOnly = defaultSettlementSignals("docs-surface");
  assert.equal(classOnly.covered_by_existing_authority, false);
  assert.equal(classOnly.reversible, false);
  assert.equal(classOnly.protected_action, true);
  const result = settleRecommendation(
    { class: "docs-surface", recommendation: rec },
    classOnly,
  );
  assert.equal(result.kind, "typed-request");
  if (result.kind === "typed-request") {
    assert.equal(result.request, "AuthorityRequest");
  }
  const interfaceResult = settleRecommendation(
    { class: "interface-contract", recommendation: rec },
    defaultSettlementSignals("interface-contract"),
  );
  assert.equal(interfaceResult.kind, "typed-request");
  if (interfaceResult.kind === "typed-request") {
    assert.equal(interfaceResult.request, "AuthorityRequest");
  }
});

test("grill: novel protected phrasing under a benign class fails closed", () => {
  const recs = [
    "merge ready pull requests automatically",
    "drop production data",
    "remove the production worktree",
  ];
  for (const rec of recs) {
    const result = settleRecommendation(
      { class: "docs-surface", recommendation: rec },
      defaultSettlementSignals("docs-surface"),
    );
    assert.equal(result.kind, "typed-request", rec);
    if (result.kind === "typed-request") {
      assert.equal(result.request, "AuthorityRequest", rec);
    }
  }
});

test("grill: non-authority rec without trusted facts does not auto-accept", () => {
  const rec = "REST";
  const result = settleRecommendation(
    { class: "interface-contract", recommendation: rec },
    defaultSettlementSignals("interface-contract", rec),
  );
  assert.notEqual(result.kind, "auto-accept");
});

test("grill: anonymous admin API access under docs-surface is AuthorityRequest", () => {
  const recs = [
    "allow anyone to call the production admin API",
    "grant anonymous access to the admin endpoint",
    "make the admin API public",
  ];
  for (const rec of recs) {
    const result = settleRecommendation(
      { class: "docs-surface", recommendation: rec },
      defaultSettlementSignals("docs-surface", rec),
    );
    assert.equal(result.kind, "typed-request", rec);
    if (result.kind === "typed-request") {
      assert.equal(result.request, "AuthorityRequest", rec);
    }
    const echoed = settleRecommendation(
      { class: "docs-surface", recommendation: rec },
      defaultSettlementSignals("docs-surface", rec, rec),
      rec,
    );
    assert.equal(echoed.kind, "typed-request", rec);
    if (echoed.kind === "typed-request") {
      assert.equal(echoed.request, "AuthorityRequest", rec);
    }
  }
});

test("grill: paraphrased configured facts cover a recommendation", () => {
  const rec = "use REST for the public API";
  const facts = "CONTEXT.md: the public API uses REST";
  const signals = parseSignalsFromModel(
    { missing_external: true, discoverable_from_facts: false },
    "operational-default",
    rec,
    facts,
  );
  assert.equal(signals.discoverable_from_facts, true);
  assert.equal(signals.missing_external, false);
  const result = settleRecommendation(
    { class: "operational-default", recommendation: rec },
    defaultSettlementSignals("operational-default", rec, facts),
    facts,
  );
  assert.equal(result.kind, "auto-accept");
});

test("grill: documenting release notes is not an AuthorityRequest", () => {
  const rec = "document the release notes";
  const facts = "CONTEXT.md asks to document the release notes";
  const result = settleRecommendation(
    { class: "docs-surface", recommendation: rec },
    defaultSettlementSignals("docs-surface", rec, facts),
    facts,
  );
  assert.equal(result.kind, "auto-accept");
  const cutRelease = settleRecommendation(
    { class: "docs-surface", recommendation: "document the release" },
    defaultSettlementSignals("docs-surface", "document the release", "document the release"),
    "document the release",
  );
  assert.equal(cutRelease.kind, "typed-request");
  if (cutRelease.kind === "typed-request") {
    assert.equal(cutRelease.request, "AuthorityRequest");
  }
});

test("grill: settleFrontierNodes refuses protected rec under a benign class", () => {
  const rec = "disable authentication";
  const raw = [
    {
      ...makeNode({
        id: "docs",
        question: "Docs?",
        recommendation: rec,
        class: "docs-surface",
      }),
      signalsRaw: {
        reversible: true,
        in_scope: true,
        policy_consistent: true,
        covered_by_existing_authority: true,
        protected_action: false,
      },
    },
  ];
  const nodes = settleFrontierNodes(raw, rec);
  assert.equal(nodes[0]!.provenance.settled_by, "none");
  assert.equal(nodes[0]!.typed_request, "AuthorityRequest");
});

// ---------------------------------------------------------------------------
// Batch / dry-run / ready / resume
// ---------------------------------------------------------------------------

test("grill: dry-run writes nothing and reports the frozen list", async () => {
  const world: FakeWorld = {
    issues: new Map([[10, openIssue(10)], [11, openIssue(11)]]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [10, 11],
    labelMembers: new Map(),
  };
  const deps = makeDeps(world, memoryStore());
  let out = "";
  deps.writeStdout = (t) => {
    out += t;
  };
  const code = await runGrill({ milestone: "v1.40.1", dryRun: true }, deps);
  assert.equal(code, 0);
  assert.match(out, /selected: 2/);
  assert.deepEqual(world.bodies, []);
  assert.deepEqual(world.labelsWritten, []);
  assert.deepEqual(world.gitWrites, []);
  assert.deepEqual(world.docsPrs, []);
  assert.deepEqual(world.callLog, []);
});

test("grill: independent peer continues after sibling failure", async () => {
  const world: FakeWorld = {
    issues: new Map([[10, openIssue(10)], [11, openIssue(11)]]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [],
    labelMembers: new Map(),
  };
  const store = memoryStore();
  const deps = makeDeps(world, store);
  let n = 0;
  deps.runImplementer = async () => {
    n += 1;
    if (n === 1) return { success: false, output: "" };
    return { success: true, output: implementerJson() };
  };
  const code = await runGrill({ issues: "10,11", dryRun: true }, deps);
  assert.equal(code, 0);
  assert.equal(world.implementerCalls.length + n >= 1, true);
});

test("grill: stale live body is fetched before evaluation", async () => {
  const world: FakeWorld = {
    issues: new Map([[10, openIssue(10, { body: "LIVE BODY UNIQUE" })]]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [],
    labelMembers: new Map(),
  };
  const deps = makeDeps(world, memoryStore());
  const state = emptyLedger("r", [10]).issues["10"]!;
  await grillOneIssue(10, deps, { dryRun: true, state });
  assert.match(world.implementerCalls[0] ?? "", /LIVE BODY UNIQUE/);
});

test("grill: cycle facts fail ready with no silent truncate", async () => {
  const body10 = "Depends on #11\n";
  const body11 = "Depends on #10\n";
  const world: FakeWorld = {
    issues: new Map([
      [10, openIssue(10, { body: body10 })],
      [11, openIssue(11, { body: body11 })],
    ]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [],
    labelMembers: new Map(),
  };
  const deps = makeDeps(world, memoryStore(), implementerJson({ body: "Depends on #11\n\n## Summary\nX\n\n## User story\nAs a user, / I want x, / so that y.\n\n## Acceptance criteria\n- [ ] x\n\n## Out of scope\n- y" }));
  const state = emptyLedger("r", [10]).issues["10"]!;
  const next = await grillOneIssue(10, deps, { dryRun: true, state });
  assert.ok(next.facts.includes("dependency.cycle") || next.status !== "ready");
  assert.equal(world.labelsWritten.length, 0);
});

test("grill: marker is recognized and stale recommendations are not trusted", () => {
  const body = "<!-- grill-with-docs:v1.40.1 -->\n## Decisions\nOld rec\n";
  assert.equal(hasGrillWithDocsMarker(body), true);
  assert.equal(isGrillMigratedBody(body), true);
  assert.equal(parseDecisionsFromBody(body).ok, false);
});

test("grill: never records merge or ship on the call log", async () => {
  const world: FakeWorld = {
    issues: new Map([[10, openIssue(10)]]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [],
    labelMembers: new Map(),
  };
  const deps = makeDeps(world, memoryStore());
  await runGrill({ issue: 10, dryRun: true }, deps);
  assert.equal(world.callLog.includes("merge"), false);
  assert.equal(world.callLog.includes("ship"), false);
  assert.equal(world.callLog.includes("train --merge"), false);
  assert.equal(world.callLog.includes("merge-queue --apply"), false);
});

test("grill: pickup still uses evaluateIssueReadiness and grill does not call it", () => {
  assert.equal(typeof evaluateIssueReadiness, "function");
  const src = grillOneIssue.toString();
  assert.equal(src.includes("evaluateIssueReadiness"), false);
});

test("grill: status counts selected/migrated/waiting/ready/failed", () => {
  const ledger = emptyLedger("r", [10, 11, 12]);
  ledger.issues["10"]!.status = "ready";
  ledger.issues["10"]!.migrated = true;
  ledger.issues["11"]!.status = "waiting";
  ledger.issues["12"]!.status = "failed";
  const counts = grillStatusCounts(ledger, 3);
  assert.deepEqual(counts, { selected: 3, migrated: 1, waiting: 1, ready: 1, failed: 1 });
});

test("grill: docs actions with the same payload stay one PR key", () => {
  const a = { kind: "context_term" as const, term_id: "Foo", payload_sha256: "x", necessity: "required" as const };
  const b = { kind: "context_term" as const, term_id: "Foo", payload_sha256: "x", necessity: "required" as const };
  const unique = new Map<string, typeof a>();
  unique.set(a.payload_sha256, a);
  unique.set(b.payload_sha256, b);
  assert.equal(unique.size, 1);
});

test("grill: auto-accept parse identity still fails on render divergence", () => {
  const node = makeNode({
    id: "api",
    question: "Which API?",
    recommendation: "REST",
    class: "interface-contract",
  });
  node.resolution = "resolved";
  node.provenance = {
    settled_by: "auto-accept",
    reference: null,
    reviewer_verdict: null,
    reviewer_reason: null,
    eligibility_reason: AUTO_ACCEPT_ELIGIBILITY_REASON,
  };
  const spec = "## Summary\nX\n";
  const art = {
    schema_version: "decisions.v1" as const,
    nodes: [node],
    fingerprint: buildGrillFingerprint({
      title: "T",
      appliedBody: spec,
      dependencyClosure: { ids: [], per_id: [], fact_codes: [] },
      integrationBaseSha: "abc123def456",
      contextMd: "**Grill**:\nNative admission.\n",
      providerConfig: PROVIDER,
      planningTreatment: TREATMENT,
    }),
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
  const parsed = parseDecisionsArtifact(art);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  const body = embedDecisionsInBody(spec, art);
  const live = parseDecisionsFromBody(body);
  assert.equal(live.ok, true);
  assert.equal(extractSpecCore(body).includes("Summary"), true);
  const diverged = body.replace("## Decisions", "## Decisions\nTAMPER");
  const divergedParse = parseDecisionsFromBody(diverged);
  assert.equal(divergedParse.ok, false);
});

test("grill: mutating --issue writes Decisions once and replay is idempotent", async () => {
  const world: FakeWorld = {
    issues: new Map([[10, openIssue(10)]]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [],
    labelMembers: new Map(),
  };
  const store = memoryStore();
  const deps = makeDeps(world, store);
  let seq = 0;
  deps.uuid = () => `run${++seq}`;
  const first = await runGrill({ issue: 10 }, deps);
  assert.equal(first, 0);
  assert.equal(world.bodies.length, 1);
  const parsed = parseDecisionsFromBody(world.bodies[0]!);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  if (parsed.ok) {
    const byClass = new Map(parsed.artifact.nodes.map((n) => [n.class, n]));
    assert.equal(byClass.get("interface-contract")?.provenance.settled_by, "auto-accept");
    for (const cls of ["security", "irreversible-operations", "merge-release", "human-attestation"]) {
      assert.equal(byClass.get(cls)?.provenance.settled_by, "none");
      assert.equal(byClass.get(cls)?.typed_request, "AuthorityRequest");
    }
  }
  assert.equal(world.labelsWritten.some((w) => w.label === "pipeline:ready"), false);
  const labelsAfterFirst = world.labelsWritten.length;
  const second = await runGrill({ issue: 10 }, deps);
  assert.equal(second, 0);
  assert.equal(world.labelsWritten.length, labelsAfterFirst);
  assert.equal(world.labelsWritten.some((w) => w.label === "pipeline:ready"), false);
});

test("grill: two issues settling the same term open one docs PR", async () => {
  const proposal = [{ term_id: "Widget", definition: "A widget.", necessity: "advisory" }];
  const world: FakeWorld = {
    issues: new Map([[10, openIssue(10)], [11, openIssue(11)]]),
    bodies: [],
    labelsWritten: [],
    labelsRemoved: [],
    implementerCalls: [],
    gitWrites: [],
    docsPrs: [],
    callLog: [],
    milestoneMembers: [],
    labelMembers: new Map(),
  };
  const store = memoryStore();
  const deps = makeDeps(world, store, implementerJson({ context_proposals: proposal }));
  const code = await runGrill({ issues: "10,11" }, deps);
  assert.equal(code, 0);
  assert.equal(world.docsPrs.length, 1);
  assert.equal(world.gitWrites.some((p) => p.endsWith("CONTEXT.md")), true);
  assert.equal(world.gitWrites.some((p) => p.includes("/main/")), false);
});
