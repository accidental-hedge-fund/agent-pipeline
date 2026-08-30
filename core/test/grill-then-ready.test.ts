// Grill-then-ready (#1072): schema, taxonomy, fingerprints, envelope, preview,
// apply, ready gate, and handoff materialize. All I/O injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalThinIssueNodes,
  embedDecisionsInBody,
  extractSpecCore,
  parseDecisionsFromBody,
  parseDecisionsArtifact,
  applyReviewerVerdicts,
  implementerSelfAccepted,
  makeNode,
  unresolvedAuthorityNodes,
  type DecisionsArtifact,
  type DecisionNode,
} from "../scripts/grill-decisions.ts";
import {
  classifyAuthority,
  isNonAuthorityClass,
  isOperatorRequiredClass,
  NON_AUTHORITY_ELIGIBILITY_REASON,
  OPERATOR_REQUIRED_CLASSES,
} from "../scripts/grill-taxonomy.ts";
import {
  buildGrillFingerprint,
  fingerprintStaleReasons,
  type GrillFingerprint,
} from "../scripts/grill-fingerprint.ts";
import { planningTreatmentFromConfig } from "../scripts/grill-issue.ts";
import {
  fileConsumedNonceStore,
  issueGrillProposal,
  parseEnvelopeBytes,
  signGrillProposal,
  verifyGrillProposal,
  type GrillProposalEnvelope,
  type GrillProposalKeyDeps,
} from "../scripts/grill-proposal.ts";
import { walkDeclaredDependencyClosure } from "../scripts/grill-facts.ts";
import {
  classifyContextProposals,
  recordRequiredContextHashes,
  requiredContextSatisfied,
} from "../scripts/grill-context.ts";
import { validateDecisionsForReady } from "../scripts/grill-ready.ts";
import {
  canCreateHandoff,
  createAndPersistHandoff,
  answerAndPersistHandoff,
  loadHandoff,
  type HandoffStoreDeps,
  type HumanQuestionHandoff,
} from "../scripts/human-question-handoff.ts";
import {
  grillAuthorityCreateInputs,
  materializeGrillAnswer,
  materializeGrillNode,
  isGrillAuthorityDeclaration,
  parseGrillDeclaration,
} from "../scripts/grill-handoff.ts";
import {
  runRefineSpecApply,
  runRefineSpecIssuePreview,
  type GrillIssueApplyDeps,
  type GrillIssuePreviewDeps,
} from "../scripts/grill-issue.ts";
import { runTriage, type TriageDeps } from "../scripts/stages/triage.ts";
import { COMMAND_REGISTRY, validateFlags } from "../scripts/command-registry.ts";
import { buildCmd, maxPositionalsFor } from "../scripts/pipeline.ts";
import { sha256Prefixed } from "../scripts/grill-hash.ts";
import { buildGrillImplementerPrompt, buildGrillReviewerPrompt } from "../scripts/prompts/index.ts";
import type { GrillReadySnapshot } from "../scripts/grill-ready.ts";

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

function fingerprint(title: string, spec: string, extra?: Partial<GrillFingerprint>): GrillFingerprint {
  const base = buildGrillFingerprint({
    title,
    appliedBody: spec,
    dependencyClosure: { ids: [42], per_id: [{ id: 42, title_sha256: sha256Prefixed(title), body_sha256: sha256Prefixed(spec) }], fact_codes: [] },
    integrationBaseSha: "abc123def456",
    contextMd: "**Grill**:\nA one-shot intake interview.\n",
    providerConfig: PROVIDER,
    planningTreatment: TREATMENT,
  });
  return { ...base, ...extra };
}

function artifact(nodes: DecisionNode[], spec: string, title = "T"): DecisionsArtifact {
  return {
    schema_version: "decisions.v1",
    nodes,
    fingerprint: fingerprint(title, spec),
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
}

function memoryKeyDeps(key = "test-key"): GrillProposalKeyDeps {
  const files = new Map<string, string>();
  return {
    env: { PIPELINE_GRILL_PROPOSAL_KEY: key },
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

function memoryHandoffStore(): HandoffStoreDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
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
        const rest = key.slice(prefix.length);
        const first = rest.split("/")[0];
        if (first) names.add(first);
      }
      return [...names];
    },
  };
}

function capture(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: string | Uint8Array) => {
      err += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    fn().finally(() => {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = origOut;
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = origErr;
      resolve({ out, err });
    });
  });
}

function withExit(fn: () => Promise<void>): Promise<void> {
  const saved = process.exitCode;
  process.exitCode = undefined;
  return fn().finally(() => {
    process.exitCode = saved;
  });
}

function handoffForNode(node: DecisionNode, issue = 42): HumanQuestionHandoff {
  const id = `hqh_${node.id}`;
  return {
    schema_version: 1,
    handoff_id: id,
    domain: "agent-pipeline",
    repo: "acme/repo",
    issue_number: issue,
    run_id: null,
    attempt_id: null,
    blocked_stage: "triage",
    question: node.question,
    reason: "grill",
    handoff_class: "product_judgment",
    authority_mode: "authority",
    human_decision_required: null,
    policy_bound_authority_gate: true,
    scope: { candidate_sha: null, content_hashes: ["sha256:" + "a".repeat(64), "fp", node.id, "core"] },
    required_capability: ["authority"],
    resolution_evidence: {
      unresolved: false,
      eligible_actors: [],
      resolution_summary: "grill-authority",
    },
    status: "answered",
    created_at: "2026-01-01T00:00:00Z",
    expires_at: null,
    supersedes: null,
    superseded_by: null,
    answer: {
      decision: "answer",
      responder: "alice",
      identity_source: "gh",
      answer_text: "yes",
      answered_at: "2026-01-01T00:00:01Z",
      payload_hash: "x",
    },
    resume_target: "triage",
    resume_preconditions: [],
    declaration_identity: `grill-v1:${node.id}:${"b".repeat(64)}:${"a".repeat(64)}`,
  };
}

function settledOperatorNodes(): DecisionNode[] {
  return OPERATOR_REQUIRED_CLASSES.map((cls) => {
    const n = makeNode({ id: cls, question: `Q ${cls}?`, recommendation: `R ${cls}`, class: cls });
    const h = handoffForNode(n);
    return {
      ...n,
      resolution: "resolved" as const,
      provenance: {
        settled_by: "handoff" as const,
        reference: `handoff:${h.handoff_id}`,
        reviewer_verdict: "accept" as const,
        reviewer_reason: "reviewed",
        eligibility_reason: null,
      },
    };
  });
}

function completeReadySnapshot(body: string, title = "T"): GrillReadySnapshot {
  const spec = extractSpecCore(body);
  const parsed = parseDecisionsFromBody(body);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  const art = (parsed as { ok: true; artifact: DecisionsArtifact }).artifact;
  const handoffs = art.nodes.filter((n) => n.provenance.settled_by === "handoff").map((n) =>
    handoffForNode(n),
  );
  return {
    title,
    body,
    comments: [{ body: "operator said ship it in a comment" }],
    fingerprint: art.fingerprint,
    contextMd: "**Grill**:\nA one-shot intake interview.\n",
    integrationBaseSha: art.fingerprint.integration_base_sha,
    handoffs,
  };
}

// ---------------------------------------------------------------------------
// 1. Schema / taxonomy / fingerprints / envelope
// ---------------------------------------------------------------------------

test("grill: valid artifact embeds, parses, and render matches", () => {
  const spec = "## Summary\nDo the thing.\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const parsed = parseDecisionsFromBody(body);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  if (parsed.ok) {
    assert.equal(parsed.artifact.nodes.length, 5);
    assert.equal(extractSpecCore(body).includes("Do the thing"), true);
  }
});

test("grill: unknown schema version fails closed", () => {
  const spec = "## Summary\nX\n";
  const art = artifact(canonicalThinIssueNodes(), spec);
  const parsed = parseDecisionsArtifact({ ...art, schema_version: "decisions.v9" });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, "unknown_schema");
});

test("grill: duplicate fence fails closed", () => {
  const spec = "## Summary\nX\n";
  const art = artifact(canonicalThinIssueNodes(), spec);
  const body = embedDecisionsInBody(spec, art);
  const parsed = parseDecisionsFromBody(`${body}\n\`\`\`pipeline-decisions-v1\n{}\n\`\`\`\n`);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, "duplicate_fence");
});

test("grill: render divergence fails closed", () => {
  const spec = "## Summary\nX\n";
  const art = artifact(canonicalThinIssueNodes(), spec);
  const body = embedDecisionsInBody(spec, art).replace("## Decisions", "## Decisions\n\nTAMPER");
  const parsed = parseDecisionsFromBody(body);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, "render_divergence");
});

test("grill: unknown class stays unresolved and cannot record reviewer-accept", () => {
  const classified = classifyAuthority("invented-class");
  assert.equal(classified.known, false);
  assert.equal(classified.operatorRequired, true);
  assert.equal(classified.mayAutoDefault, false);
  const node = makeNode({ id: "x", question: "Q?", recommendation: "R", class: "invented-class" });
  const applied = applyReviewerVerdicts([node], [{ node_id: "x", verdict: "accept", reason: "ok" }]);
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(applied.nodes[0]!.resolution, "unresolved");
    assert.equal(applied.nodes[0]!.provenance.settled_by, "none");
  }
});

test("grill: non-authority accept records reviewer-accept", () => {
  assert.equal(isNonAuthorityClass("interface-contract"), true);
  const node = makeNode({
    id: "api",
    question: "Which API?",
    recommendation: "REST",
    class: "interface-contract",
  });
  const applied = applyReviewerVerdicts([node], [{ node_id: "api", verdict: "accept", reason: "fine" }]);
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(applied.nodes[0]!.resolution, "resolved");
    assert.equal(applied.nodes[0]!.provenance.settled_by, "reviewer-accept");
    assert.equal(applied.nodes[0]!.provenance.eligibility_reason, NON_AUTHORITY_ELIGIBILITY_REASON);
  }
});

test("grill: operator-required accept stays unresolved", () => {
  for (const cls of OPERATOR_REQUIRED_CLASSES) {
    assert.equal(isOperatorRequiredClass(cls), true);
    const node = makeNode({ id: cls, question: "Q?", recommendation: "R", class: cls });
    const applied = applyReviewerVerdicts([node], [{ node_id: cls, verdict: "accept", reason: "ok" }]);
    assert.equal(applied.ok, true);
    if (applied.ok) {
      assert.equal(applied.nodes[0]!.resolution, "unresolved");
      assert.equal(applied.nodes[0]!.provenance.settled_by, "none");
      assert.equal(applied.nodes[0]!.provenance.reviewer_verdict, "accept");
    }
  }
});

test("grill: any bound-input fingerprint change is stale", () => {
  const spec = "body";
  const a = fingerprint("T", spec);
  const b = fingerprint("T2", spec);
  assert.ok(fingerprintStaleReasons(a, b).includes("title_sha256"));
  const c = { ...a, integration_base_sha: "other" };
  assert.ok(fingerprintStaleReasons(a, c).includes("integration_base_sha"));
  const d = { ...a, planning_treatment_sha256: sha256Prefixed("other-treatment") };
  assert.ok(fingerprintStaleReasons(a, d).includes("planning_treatment_sha256"));
});

test("grill: envelope tamper / expiry / unknown schema / replay fail closed", () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const now = new Date("2026-01-01T00:00:00Z");
  const signed = issueGrillProposal({
    now,
    nonce: "aa".repeat(16),
    repo: "acme/repo",
    issue: 42,
    input: {
      title: "T",
      body: spec,
      title_sha256: sha256Prefixed("T"),
      body_sha256: sha256Prefixed(spec),
      fingerprint: art.fingerprint,
    },
    proposal: {
      body,
      artifact: art,
      verdicts: nodes.map((n) => ({ node_id: n.id, verdict: "accept" as const, reason: "ok" })),
      advisory_title: "T",
      advisory_milestone: null,
      context_proposals: [],
    },
    key: "test-key",
  });
  assert.equal(signed.ok, true);
  if (!signed.ok) return;
  const env = signed.envelope;
  const tampered = { ...env, proposal: { ...env.proposal, verdicts: env.proposal.verdicts.map((v) => ({ ...v, verdict: "accept" as const })) } };
  tampered.proposal.body = env.proposal.body + " ";
  const mac = verifyGrillProposal(tampered, "test-key", now, { repo: "acme/repo", issue: 42 });
  assert.equal(mac.ok, false);
  if (!mac.ok) assert.equal(mac.code, "mac");

  const expired = verifyGrillProposal(env, "test-key", new Date("2026-01-03T00:00:00Z"), {
    repo: "acme/repo",
    issue: 42,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, "expired");

  const unknown = parseEnvelopeBytes(JSON.stringify({ ...env, schema_version: "9" }));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "unknown_schema");

  const files = memoryKeyDeps();
  const store = fileConsumedNonceStore("/tmp/repo", files);
  assert.equal(store.isConsumed(env.nonce), false);
  store.consume(env.nonce);
  assert.equal(store.isConsumed(env.nonce), true);
});

test("grill: implementer self-accept detector bites", () => {
  const node = makeNode({ id: "scope", question: "Q", recommendation: "R", class: "scope" });
  node.provenance.settled_by = "reviewer-accept";
  assert.equal(implementerSelfAccepted([node]), true);
});

test("grill: implementer self-accept detector bites on pre-resolved non-authority", () => {
  const node = makeNode({
    id: "api",
    question: "Which API?",
    recommendation: "REST",
    class: "interface-contract",
  });
  node.resolution = "resolved";
  assert.equal(node.provenance.settled_by, "none");
  assert.equal(implementerSelfAccepted([node]), true);
});

test("grill: applyReviewerVerdicts rejects omitted verdict for non-authority node", () => {
  const node = makeNode({
    id: "api",
    question: "Which API?",
    recommendation: "REST",
    class: "interface-contract",
  });
  node.resolution = "resolved";
  const applied = applyReviewerVerdicts([node], []);
  assert.equal(applied.ok, false);
  if (!applied.ok) assert.match(applied.reason, /omitted verdict for node api/);
});

test("grill: applyReviewerVerdicts rejects duplicate verdict", () => {
  const node = makeNode({
    id: "api",
    question: "Which API?",
    recommendation: "REST",
    class: "interface-contract",
  });
  const applied = applyReviewerVerdicts(
    [node],
    [
      { node_id: "api", verdict: "accept", reason: "first" },
      { node_id: "api", verdict: "accept", reason: "second" },
    ],
  );
  assert.equal(applied.ok, false);
  if (!applied.ok) assert.match(applied.reason, /duplicate reviewer verdict for node api/);
});

test("grill: parse rejects resolved non-authority without reviewer-accept", () => {
  const spec = "## Summary\nX\n";
  const node = makeNode({
    id: "api",
    question: "Which API?",
    recommendation: "REST",
    class: "interface-contract",
  });
  node.resolution = "resolved";
  const parsed = parseDecisionsArtifact(artifact([node], spec));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /reviewer-accept/);
});

test("grill: parse accepts resolved non-authority with reviewer-accept and eligibility reason", () => {
  const spec = "## Summary\nX\n";
  const node = makeNode({
    id: "api",
    question: "Which API?",
    recommendation: "REST",
    class: "interface-contract",
  });
  node.resolution = "resolved";
  node.provenance = {
    settled_by: "reviewer-accept",
    reference: null,
    reviewer_verdict: "accept",
    reviewer_reason: "fine",
    eligibility_reason: NON_AUTHORITY_ELIGIBILITY_REASON,
  };
  const parsed = parseDecisionsArtifact(artifact([node], spec));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
});

// ---------------------------------------------------------------------------
// 2. CLI registry / help
// ---------------------------------------------------------------------------

test("grill: refine-spec registry allows --issue and --proposal-file; needsIssueNumber false", () => {
  const entry = COMMAND_REGISTRY["refine-spec"];
  assert.equal(entry.needsIssueNumber, false);
  assert.equal(entry.mutatesGitHub, false);
  const flags = entry.allowedFlags as Set<string>;
  assert.equal(flags.has("issue"), true);
  assert.equal(flags.has("proposalFile"), true);
  assert.equal(flags.has("title"), true);
  assert.equal(flags.has("body"), true);
  const bogus = {
    options: [{ attributeName: () => "bogus" }],
    getOptionValueSource: (k: string) => (k === "bogus" ? "cli" : "default"),
  };
  assert.deepEqual(validateFlags(entry, bogus), ["bogus"]);
});

test("grill: refine-spec --help mentions title, body, issue, apply, proposal-file, json", () => {
  const cmd = buildCmd();
  const longs = cmd.options.map((o) => o.long ?? "");
  assert.ok(longs.includes("--title"));
  assert.ok(longs.includes("--body"));
  assert.ok(longs.includes("--issue"));
  assert.ok(longs.includes("--proposal-file"));
  assert.ok(longs.includes("--json"));
  assert.equal(maxPositionalsFor("refine-spec"), 2);
});

test("grill: maxPositionalsFor refine-spec is 2 so apply is a sub-verb", () => {
  assert.ok(["refine-spec", "apply"].length <= maxPositionalsFor("refine-spec"));
  assert.ok(["refine-spec", "apply", "blob"].length > maxPositionalsFor("refine-spec"));
});

// ---------------------------------------------------------------------------
// 4–5. Issue preview and apply
// ---------------------------------------------------------------------------

function previewDeps(overrides: Partial<GrillIssuePreviewDeps> & { implementerJson?: string; reviewerJson?: string }): GrillIssuePreviewDeps & {
  writes: string[];
  implementerPrompts: string[];
  reviewerPrompts: string[];
} {
  const writes: string[] = [];
  const implementerPrompts: string[] = [];
  const reviewerPrompts: string[] = [];
  const nodes = canonicalThinIssueNodes();
  const implementerJson =
    overrides.implementerJson ??
    JSON.stringify({
      title: "T",
      body: "## Summary\nThin.\n\n## User story\nAs a user, / I want x, / so that y.\n\n## Acceptance criteria\n- [ ] x\n\n## Out of scope\n- y",
      milestone: null,
      nodes: nodes.map((n) => ({
        id: n.id,
        question: n.question,
        recommendation: "rec",
        class: n.class,
      })),
      context_proposals: [],
    });
  const reviewerJson =
    overrides.reviewerJson ??
    JSON.stringify({
      verdicts: nodes.map((n) => ({ node_id: n.id, verdict: "accept", reason: "ok" })),
    });
  const deps: GrillIssuePreviewDeps & {
    writes: string[];
    implementerPrompts: string[];
    reviewerPrompts: string[];
  } = {
    writes,
    implementerPrompts,
    reviewerPrompts,
    getIssue: async () => ({ title: "Thin issue", body: "needs work" }),
    fetchDependencyIssue: async () => ({ ok: false, code: "missing" }),
    readContextMd: async () => "**Grill**:\nA one-shot intake interview.\n",
    resolveIntegrationBase: async () => "abc123def456",
    providerConfig: PROVIDER,
    planningTreatment: TREATMENT,
    runImplementer: async (prompt) => {
      implementerPrompts.push(prompt);
      return { success: true, output: implementerJson };
    },
    runReviewer: async (prompt) => {
      reviewerPrompts.push(prompt);
      return { success: true, output: reviewerJson };
    },
    now: () => new Date("2026-01-01T00:00:00Z"),
    repo: "acme/repo",
    domain: "agent-pipeline",
    repoDir: "/tmp/repo",
    keyDeps: memoryKeyDeps(),
    log: () => {},
    writeStdout: (t) => {
      writes.push("stdout:" + t);
    },
    writeStderr: (t) => {
      writes.push("stderr:" + t);
    },
    ...overrides,
  };
  return deps;
}

test("grill: issue preview fetches live issue, two harness calls, writes nothing", async () => {
  await withExit(async () => {
    const deps = previewDeps({});
    let fetched = 0;
    deps.getIssue = async () => {
      fetched++;
      return { title: "Thin issue", body: "needs work" };
    };
    const { out } = await capture(() => runRefineSpecIssuePreview(42, deps).then(() => undefined));
    assert.equal(fetched, 1);
    assert.equal(deps.implementerPrompts.length, 1);
    assert.equal(deps.reviewerPrompts.length, 1);
    assert.match(deps.reviewerPrompts[0]!, /decisions\.v1|schema_version/);
    assert.doesNotMatch(deps.reviewerPrompts[0]!, /You are the Implementer/);
    assert.equal(deps.writes.some((w) => w.startsWith("stdout:")), true);
    const json = JSON.parse(deps.writes.find((w) => w.startsWith("stdout:"))!.slice("stdout:".length));
    assert.equal(json.kind, "grill-proposal");
    assert.equal(json.mac.startsWith("hmac-sha256:"), true);
    assert.equal(process.exitCode, 0);
    void out;
  });
});

test("grill: implementer self-accept skips reviewer and writes nothing", async () => {
  await withExit(async () => {
    const deps = previewDeps({
      implementerJson: JSON.stringify({
        title: "T",
        body: "## Summary\nX\n\n## User story\nAs a, / I want, / so that.\n\n## Acceptance criteria\n- [ ] a\n\n## Out of scope\n- b",
        milestone: null,
        nodes: [
          {
            id: "scope",
            question: "Q",
            recommendation: "R",
            class: "scope",
            provenance: { settled_by: "reviewer-accept" },
          },
        ],
      }),
    });
    await runRefineSpecIssuePreview(42, deps);
    assert.equal(deps.reviewerPrompts.length, 0);
    assert.equal(deps.writes.some((w) => w.startsWith("stdout:")), false);
    assert.notEqual(process.exitCode, 0);
  });
});

test("grill: implementer pre-resolved non-authority skips reviewer and writes nothing", async () => {
  await withExit(async () => {
    const deps = previewDeps({
      implementerJson: JSON.stringify({
        title: "T",
        body: "## Summary\nX\n\n## User story\nAs a, / I want, / so that.\n\n## Acceptance criteria\n- [ ] a\n\n## Out of scope\n- b",
        milestone: null,
        nodes: [
          {
            id: "api",
            question: "Which API?",
            recommendation: "REST",
            class: "interface-contract",
            resolution: "resolved",
            provenance: { settled_by: "none" },
          },
        ],
      }),
    });
    await runRefineSpecIssuePreview(42, deps);
    assert.equal(deps.reviewerPrompts.length, 0);
    assert.equal(deps.writes.some((w) => w.startsWith("stdout:")), false);
    assert.notEqual(process.exitCode, 0);
  });
});

test("grill: omitted reviewer verdict for non-authority node fails preview", async () => {
  await withExit(async () => {
    const operator = canonicalThinIssueNodes();
    const deps = previewDeps({
      implementerJson: JSON.stringify({
        title: "T",
        body: "## Summary\nX\n\n## User story\nAs a, / I want, / so that.\n\n## Acceptance criteria\n- [ ] a\n\n## Out of scope\n- b",
        milestone: null,
        nodes: [
          ...operator.map((n) => ({
            id: n.id,
            question: n.question,
            recommendation: "rec",
            class: n.class,
          })),
          {
            id: "api",
            question: "Which API?",
            recommendation: "REST",
            class: "interface-contract",
          },
        ],
      }),
      reviewerJson: JSON.stringify({
        verdicts: operator.map((n) => ({ node_id: n.id, verdict: "accept", reason: "ok" })),
      }),
    });
    await runRefineSpecIssuePreview(42, deps);
    assert.equal(deps.writes.some((w) => w.startsWith("stdout:")), false);
    assert.notEqual(process.exitCode, 0);
  });
});

test("grill: implementer timeout does not invoke reviewer or write", async () => {
  await withExit(async () => {
    const deps = previewDeps({});
    deps.runImplementer = async () => ({ success: false, output: "", timed_out: true });
    await runRefineSpecIssuePreview(42, deps);
    assert.equal(deps.reviewerPrompts.length, 0);
    assert.notEqual(process.exitCode, 0);
  });
});

function applyDeps(envelope: GrillProposalEnvelope, extra?: Partial<GrillIssueApplyDeps>): GrillIssueApplyDeps & {
  bodies: string[];
  labels: string[];
} {
  const bodies: string[] = [];
  const labels: string[] = [];
  const live = { title: envelope.input.title, body: envelope.input.body };
  return {
    bodies,
    labels,
    getIssue: async () => live,
    updateIssueBody: async (_n, body) => {
      bodies.push(body);
      live.body = body;
    },
    isKillSwitchActive: () => false,
    now: () => new Date("2026-01-01T00:00:00Z"),
    repo: envelope.repo,
    domain: "agent-pipeline",
    repoDir: "/tmp/repo",
    keyDeps: memoryKeyDeps(),
    nonceStore: {
      isConsumed: () => false,
      consume: () => {},
    },
    readStdin: () => JSON.stringify(envelope),
    readFile: () => JSON.stringify(envelope),
    stdinHasBytes: () => true,
    log: () => {},
    writeStderr: () => {},
    ...extra,
  };
}

async function signedPreview(): Promise<GrillProposalEnvelope> {
  const deps = previewDeps({});
  await withExit(async () => {
    await runRefineSpecIssuePreview(42, deps);
  });
  const raw = deps.writes.find((w) => w.startsWith("stdout:"))!.slice("stdout:".length);
  return JSON.parse(raw) as GrillProposalEnvelope;
}

test("grill: apply creates pending grill-authority handoffs; preview creates none", async () => {
  const env = await signedPreview();
  const store = memoryHandoffStore();
  await withExit(async () => {
    const deps = applyDeps(env, { handoffStore: store });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(deps.bodies.length, 1);
    assert.equal(process.exitCode, 0);
  });
  const listed = [...store.files.keys()].filter((k) => k.endsWith(".json") && !k.endsWith("audit.json"));
  assert.ok(listed.length >= 1, "apply should persist pending grill-authority handoffs");
});

test("grill: apply writes body only and refuses challenge / drift / kill-switch", async () => {
  const env = await signedPreview();
  await withExit(async () => {
    const deps = applyDeps(env);
    await runRefineSpecApply(42, {}, deps);
    assert.equal(deps.bodies.length, 1);
    assert.equal(deps.bodies[0], env.proposal.body);
    assert.equal(process.exitCode, 0);
  });

  await withExit(async () => {
    const challenged = structuredClone(env);
    challenged.proposal.verdicts[0]!.verdict = "challenge";
    challenged.proposal.artifact.nodes[0]!.provenance.reviewer_verdict = "challenge";
    const resigned = signGrillProposal(
      (({ mac: _m, ...rest }) => rest)(challenged),
      "test-key",
    );
    const deps = applyDeps(resigned);
    await runRefineSpecApply(42, {}, deps);
    assert.equal(deps.bodies.length, 0);
    assert.equal(process.exitCode, 2);
  });

  await withExit(async () => {
    const deps = applyDeps(env, {
      getIssue: async () => ({ title: "other", body: env.input.body }),
    });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(deps.bodies.length, 0);
    assert.equal(process.exitCode, 2);
  });

  await withExit(async () => {
    const deps = applyDeps(env, { isKillSwitchActive: () => true });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(deps.bodies.length, 0);
    assert.equal(process.exitCode, 2);
  });
});

test("grill: apply refuses empty, dual, and positional proposal input", async () => {
  const env = await signedPreview();
  await withExit(async () => {
    const deps = applyDeps(env, { stdinHasBytes: () => false, readStdin: () => "" });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 2);
    assert.equal(deps.bodies.length, 0);
  });
  await withExit(async () => {
    const deps = applyDeps(env, { stdinHasBytes: () => true });
    await runRefineSpecApply(42, { proposalFile: "/tmp/x.json" }, deps);
    assert.equal(process.exitCode, 2);
    assert.equal(deps.bodies.length, 0);
  });
  await withExit(async () => {
    const deps = applyDeps(env, { stdinHasBytes: () => false });
    await runRefineSpecApply(42, { positionalProposal: "{}" }, deps);
    assert.equal(process.exitCode, 2);
    assert.equal(deps.bodies.length, 0);
  });
});

test("grill: kill-switch does not block preview", async () => {
  await withExit(async () => {
    const deps = previewDeps({});
    await runRefineSpecIssuePreview(42, deps);
    assert.equal(process.exitCode, 0);
    assert.equal(deps.writes.some((w) => w.startsWith("stdout:")), true);
  });
});

test("grill: thin issue artifact is non-ready", async () => {
  const env = await signedPreview();
  const snap = {
    title: "Thin issue",
    body: env.proposal.body,
    comments: [],
    fingerprint: env.proposal.artifact.fingerprint,
    contextMd: "**Grill**:\nA one-shot intake interview.\n",
    integrationBaseSha: env.proposal.artifact.fingerprint.integration_base_sha,
    handoffs: [],
  };
  const ready = validateDecisionsForReady(snap);
  assert.equal(ready.ok, false);
  if (!ready.ok) assert.equal(ready.code, "unresolved_authority");
});

test("grill: comment-only answer does not settle a node", () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const ready = validateDecisionsForReady({
    title: "T",
    body,
    comments: [{ body: "I attest this is in scope." }],
    fingerprint: art.fingerprint,
    contextMd: "**Grill**:\nA one-shot intake interview.\n",
    integrationBaseSha: art.fingerprint.integration_base_sha,
    handoffs: [],
  });
  assert.equal(ready.ok, false);
  if (!ready.ok) assert.equal(ready.code, "unresolved_authority");
});

test("grill: model-authored handoff provenance without ledger fails ready", () => {
  const spec = "## Summary\nX\n";
  const nodes = settledOperatorNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const ready = validateDecisionsForReady({
    title: "T",
    body,
    comments: [],
    fingerprint: art.fingerprint,
    contextMd: "**Grill**:\nA one-shot intake interview.\n",
    integrationBaseSha: art.fingerprint.integration_base_sha,
    handoffs: [],
  });
  assert.equal(ready.ok, false);
  if (!ready.ok) assert.equal(ready.code, "invalid_provenance");
});

test("grill: complete provenanced artifact is ready; comments ignored", () => {
  const spec = "## Summary\nX\n";
  const nodes = settledOperatorNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const snap = completeReadySnapshot(body);
  const ready = validateDecisionsForReady(snap);
  assert.equal(ready.ok, true, ready.ok ? "" : ready.reason);
});

test("grill: required CONTEXT blocks ready; advisory does not", () => {
  const spec = "## Summary\nX\n";
  const nodes = settledOperatorNodes();
  nodes[0]!.term_id = "MissingTerm";
  const classified = classifyContextProposals(
    [{ term_id: "MissingTerm", definition: "x", necessity: "advisory" }],
    nodes,
    "**Grill**:\nA one-shot intake interview.\n",
  );
  assert.equal(classified.proposals[0]!.necessity, "required");
  const recorded = recordRequiredContextHashes(
    classified.required_context,
    "abc123",
    "**Grill**:\nA one-shot intake interview.\n",
  );
  assert.equal(recorded.integration_base_sha, null);
  assert.equal(
    requiredContextSatisfied(recorded, "abc123", "**Grill**:\nA one-shot intake interview.\n"),
    false,
  );
  const advisory = classifyContextProposals(
    [{ term_id: "Grill", definition: "x", necessity: "required" }],
    settledOperatorNodes(),
    "**Grill**:\nA one-shot intake interview.\n",
  );
  assert.equal(advisory.proposals[0]!.necessity, "advisory");
});

test("grill: dependency cycle is a typed unresolved fact", async () => {
  const walk = await walkDeclaredDependencyClosure(1, "A", "Depends on #2", {
    fetchIssue: async (id) => {
      if (id === 2) return { ok: true, title: "B", body: "Depends on #1" };
      return { ok: false, code: "missing" };
    },
  });
  assert.ok(walk.facts.some((f) => f.code === "dependency.cycle"));
});

test("grill: missing dependency is typed; closure exhaustion is typed", async () => {
  const missing = await walkDeclaredDependencyClosure(1, "A", "Depends on #99", {
    fetchIssue: async () => ({ ok: false, code: "missing" }),
  });
  assert.ok(missing.facts.some((f) => f.code === "dependency.missing"));

  let n = 2;
  const chain = await walkDeclaredDependencyClosure(1, "A", "Depends on #2", {
    fetchIssue: async (id) => ({ ok: true, title: `I${id}`, body: `Depends on #${id + 1}` }),
  });
  assert.ok(chain.facts.some((f) => f.code === "dependency.closure_exhausted"));
  void n;
});

// ---------------------------------------------------------------------------
// 6. Handoff
// ---------------------------------------------------------------------------

test("grill: mid-flight HDR create without reviewed SHA still fails closed", () => {
  const r = canCreateHandoff({
    domain: "d",
    repo: "acme/r",
    issue_number: 1,
    blocked_stage: "fix-1",
    question: "product?",
    reason: "hdr",
    handoff_class: "product_judgment",
    authority_mode: "authority",
    required_capability: ["authority"],
    candidate_sha: null,
    tip_present: false,
    policy_bound_authority_gate: false,
    human_decision_required: {
      finding_key: "f1",
      finding_fingerprint: "fp",
      reviewed_sha: "",
    },
    resume_target: "fix-1",
  });
  assert.equal(r.ok, false);
});

test("grill: create succeeds without a PR tip for grill-authority", () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const inputs = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 42,
    artifact: art,
    proposedBody: body,
    frontierFp: art.fingerprint.planning_treatment_sha256,
  });
  assert.ok(inputs.length >= 5);
  const created = canCreateHandoff(inputs[0]!);
  assert.equal(created.ok, true, created.ok ? "" : created.reason);
  if (created.ok) {
    assert.equal(created.handoff.scope.candidate_sha, null);
    assert.equal(created.handoff.policy_bound_authority_gate, true);
    assert.equal(isGrillAuthorityDeclaration(created.handoff.declaration_identity), true);
  }
});

test("grill: materialize patches one node; drift refuses; heal skips rewrite", () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const inputs = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 42,
    artifact: art,
    proposedBody: body,
    frontierFp: "fp",
  });
  const created = canCreateHandoff(inputs[0]!);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const first = materializeGrillNode({
    liveBody: body,
    handoff: created.handoff,
    answerText: "ship it",
  });
  assert.equal(first.ok, true, first.ok ? "" : first.reason);
  if (!first.ok) return;
  assert.equal(first.wrote, true);
  const parsed = parseDecisionsFromBody(first.body);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const node = parsed.artifact.nodes.find(
      (n) => n.id === parseGrillDeclaration(created.handoff.declaration_identity ?? "")?.nodeId,
    );
    assert.equal(node?.resolution, "resolved");
    assert.equal(node?.provenance.settled_by, "handoff");
    const others = parsed.artifact.nodes.filter((n) => n.id !== node?.id);
    assert.ok(others.every((n) => n.resolution === "unresolved"));
  }
  const drifted = materializeGrillNode({
    liveBody: "## Summary\nedited\n" + body,
    handoff: created.handoff,
    answerText: "ship it",
  });
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.equal(drifted.code, "body_hash_drift");

  const heal = materializeGrillNode({
    liveBody: first.body,
    handoff: created.handoff,
    answerText: "ship it",
  });
  assert.equal(heal.ok, true);
  if (heal.ok) assert.equal(heal.wrote, false);
});

test("grill: artifact-only body edit refuses answer with no write and handoff stays pending", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const input = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 42,
    artifact: art,
    proposedBody: body,
    frontierFp: "fp",
  })[0]!;
  const created = await createAndPersistHandoff("/tmp/repo", input, store);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tamperedNodes = art.nodes.map((n, i) =>
    i === 0 ? { ...n, recommendation: "tampered recommendation" } : n,
  );
  const tamperedBody = embedDecisionsInBody(spec, { ...art, nodes: tamperedNodes });
  assert.equal(extractSpecCore(body), extractSpecCore(tamperedBody));
  assert.notEqual(sha256Prefixed(body), sha256Prefixed(tamperedBody));
  let writes = 0;
  const result = await answerAndPersistHandoff(
    "/tmp/repo",
    42,
    created.handoff.handoff_id,
    {
      decision: "answer",
      actor: "alice",
      identitySource: "gh",
      authenticated: true,
      answerText: "yes",
    },
    store,
    {
      materialize: async (h, text) => {
        const r = materializeGrillNode({ liveBody: tamperedBody, handoff: h, answerText: text });
        if (r.ok && r.wrote) writes++;
        return r.ok ? { ok: true as const, wrote: r.wrote } : r;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "body_hash_drift");
  assert.equal(writes, 0);
  const loaded = await loadHandoff("/tmp/repo", 42, created.handoff.handoff_id, store);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.handoff.status, "pending");
});

test("grill: successful materialize rebinds pending siblings to the new body hash", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const inputs = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 42,
    artifact: art,
    proposedBody: body,
    frontierFp: "fp",
  });
  assert.ok(inputs.length >= 2);
  const firstCreated = await createAndPersistHandoff("/tmp/repo", inputs[0]!, store);
  const siblingCreated = await createAndPersistHandoff("/tmp/repo", inputs[1]!, store);
  assert.equal(firstCreated.ok, true);
  assert.equal(siblingCreated.ok, true);
  if (!firstCreated.ok || !siblingCreated.ok) return;
  let live = body;
  let writes = 0;
  const first = await answerAndPersistHandoff(
    "/tmp/repo",
    42,
    firstCreated.handoff.handoff_id,
    {
      decision: "answer",
      actor: "alice",
      identitySource: "gh",
      authenticated: true,
      answerText: "yes",
    },
    store,
    {
      materialize: async (h, text) => {
        const r = await materializeGrillAnswer(h, text, {
          getIssueBody: async () => live,
          updateIssueBody: async (_n, next) => {
            writes++;
            live = next;
          },
          repoDir: "/tmp/repo",
          handoffStore: store,
        });
        return r.ok ? { ok: true as const, wrote: r.wrote } : r;
      },
    },
  );
  assert.equal(first.ok, true, first.ok ? "" : first.reason);
  assert.equal(writes, 1);
  const rebound = await loadHandoff("/tmp/repo", 42, siblingCreated.handoff.handoff_id, store);
  assert.equal(rebound.ok, true);
  if (!rebound.ok) return;
  assert.equal(rebound.handoff.status, "pending");
  const reboundDecl = parseGrillDeclaration(rebound.handoff.declaration_identity ?? "");
  assert.ok(reboundDecl);
  assert.equal(reboundDecl?.bodySha256, sha256Prefixed(live).slice("sha256:".length));
  assert.equal(rebound.handoff.scope.content_hashes?.[0], sha256Prefixed(live));
  const second = await answerAndPersistHandoff(
    "/tmp/repo",
    42,
    siblingCreated.handoff.handoff_id,
    {
      decision: "answer",
      actor: "alice",
      identitySource: "gh",
      authenticated: true,
      answerText: "yes",
    },
    store,
    {
      materialize: async (h, text) => {
        const r = await materializeGrillAnswer(h, text, {
          getIssueBody: async () => live,
          updateIssueBody: async (_n, next) => {
            writes++;
            live = next;
          },
          repoDir: "/tmp/repo",
          handoffStore: store,
        });
        return r.ok ? { ok: true as const, wrote: r.wrote } : r;
      },
    },
  );
  assert.equal(second.ok, true, second.ok ? "" : second.reason);
  assert.equal(writes, 2);
});

test("grill: persist-after-write failure heals on retry without a second write", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const input = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 42,
    artifact: art,
    proposedBody: body,
    frontierFp: "fp",
  })[0]!;
  const created = await createAndPersistHandoff("/tmp/repo", input, store);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  let writes = 0;
  let live = body;
  const hook = {
    materialize: async (h: HumanQuestionHandoff, text: string) => {
      const r = materializeGrillNode({ liveBody: live, handoff: h, answerText: text });
      if (!r.ok) return r;
      if (r.wrote) {
        writes++;
        live = r.body;
      }
      return { ok: true as const, wrote: r.wrote };
    },
  };
  const first = await answerAndPersistHandoff(
    "/tmp/repo",
    42,
    created.handoff.handoff_id,
    {
      decision: "answer",
      actor: "alice",
      identitySource: "gh",
      authenticated: true,
      answerText: "yes",
    },
    {
      ...store,
      writeFile: async (p, data) => {
        if (p.endsWith(`${created.handoff.handoff_id}.json`)) throw new Error("persist boom");
        await store.writeFile(p, data);
      },
    },
    hook,
  );
  assert.equal(first.ok, false);
  assert.equal(writes, 1);
  const retry = await answerAndPersistHandoff(
    "/tmp/repo",
    42,
    created.handoff.handoff_id,
    {
      decision: "answer",
      actor: "alice",
      identitySource: "gh",
      authenticated: true,
      answerText: "yes",
    },
    store,
    hook,
  );
  assert.equal(retry.ok, true, retry.ok ? "" : retry.reason);
  assert.equal(writes, 1);
});

test("grill: answer does not add pipeline:ready", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const input = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 7,
    artifact: art,
    proposedBody: body,
    frontierFp: "fp",
  })[0]!;
  const created = await createAndPersistHandoff("/tmp/repo", { ...input, issue_number: 7 }, store);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const labels: string[] = [];
  await answerAndPersistHandoff(
    "/tmp/repo",
    7,
    created.handoff.handoff_id,
    {
      decision: "answer",
      actor: "alice",
      identitySource: "gh",
      authenticated: true,
      answerText: "yes",
    },
    store,
    {
      materialize: async (h, text) => {
        const r = materializeGrillNode({ liveBody: body, handoff: h, answerText: text });
        return r.ok ? { ok: true, wrote: r.wrote } : r;
      },
    },
  );
  assert.deepEqual(labels, []);
});

// ---------------------------------------------------------------------------
// 7. Ready gate label writes
// ---------------------------------------------------------------------------

test("grill: --stage ready incomplete artifact makes zero label writes", async () => {
  const spec = "## Summary\nX\n";
  const art = artifact(canonicalThinIssueNodes(), spec);
  const body = embedDecisionsInBody(spec, art);
  const add: string[] = [];
  const remove: string[] = [];
  const deps: TriageDeps = {
    getIssueLabels: async () => ["pipeline:backlog"],
    addLabel: async (_n, l) => {
      add.push(l);
    },
    removeLabel: async (_n, l) => {
      remove.push(l);
    },
    log: () => {},
    getReadySnapshot: async () => ({
      title: "T",
      body,
      comments: [],
      fingerprint: art.fingerprint,
      contextMd: "**Grill**:\nA one-shot intake interview.\n",
      integrationBaseSha: art.fingerprint.integration_base_sha,
      handoffs: [],
    }),
  };
  await assert.rejects(() => runTriage({ issueArg: "42", stage: "ready" }, deps));
  assert.deepEqual(add, []);
  assert.deepEqual(remove, []);
});

test("grill: valid ready changes only the stage label and retries extras", async () => {
  const spec = "## Summary\nX\n";
  const nodes = settledOperatorNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const snap = completeReadySnapshot(body);
  let labels = ["pipeline:backlog"];
  const add: string[] = [];
  const remove: string[] = [];
  let fetches = 0;
  const deps: TriageDeps = {
    getIssueLabels: async () => {
      fetches++;
      return [...labels];
    },
    addLabel: async (_n, l) => {
      add.push(l);
      labels.push(l);
    },
    removeLabel: async (_n, l) => {
      remove.push(l);
      labels = labels.filter((x) => x !== l);
    },
    log: () => {},
    getReadySnapshot: async () => snap,
  };
  await runTriage({ issueArg: "42", stage: "ready" }, deps);
  assert.deepEqual(add, ["pipeline:ready"]);
  assert.ok(remove.includes("pipeline:backlog"));
  assert.deepEqual(labels.filter((l) => l.startsWith("pipeline:")), ["pipeline:ready"]);
});

test("grill: already ready with stale artifact exits 2 without label writes", async () => {
  const spec = "## Summary\nX\n";
  const nodes = settledOperatorNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const snap = completeReadySnapshot(body);
  snap.fingerprint = { ...snap.fingerprint, integration_base_sha: "stale-base" };
  const add: string[] = [];
  const remove: string[] = [];
  const deps: TriageDeps = {
    getIssueLabels: async () => ["pipeline:ready"],
    addLabel: async (_n, l) => {
      add.push(l);
    },
    removeLabel: async (_n, l) => {
      remove.push(l);
    },
    log: () => {},
    getReadySnapshot: async () => snap,
  };
  await assert.rejects(() => runTriage({ issueArg: "42", stage: "ready" }, deps));
  assert.deepEqual(add, []);
  assert.deepEqual(remove, []);
});

test("grill: persistent extra labels fail closed without dropping ready", async () => {
  const spec = "## Summary\nX\n";
  const nodes = settledOperatorNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const snap = completeReadySnapshot(body);
  let labels = ["pipeline:backlog"];
  const add: string[] = [];
  const deps: TriageDeps = {
    getIssueLabels: async () => [...labels],
    addLabel: async (_n, l) => {
      add.push(l);
      if (!labels.includes(l)) labels.push(l);
    },
    removeLabel: async () => {
      /* extras persist */
    },
    log: () => {},
    getReadySnapshot: async () => snap,
  };
  await assert.rejects(() => runTriage({ issueArg: "42", stage: "ready" }, deps), (err: Error) => {
    assert.match(err.message, /label_reconciliation_failed/);
    return true;
  });
  assert.ok(add.includes("pipeline:ready"));
  assert.ok(labels.includes("pipeline:ready"));
});

test("grill: ADR names refine-spec as writer and does not say triage rewrites the body", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const adr = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../docs/adr/0002-decisions-live-in-the-issue-body.md"),
    "utf8",
  );
  assert.match(adr, /refine-spec/);
  assert.doesNotMatch(adr, /Bare `pipeline triage N` is one implementer shot that rewrites the body/);
  const glossary = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../CONTEXT.md"),
    "utf8",
  );
  assert.match(glossary, /\*\*Grill\*\*:/);
  assert.match(glossary, /\*\*Decisions\*\*:/);
  assert.match(glossary, /\*\*Authority node\*\*:/);
  assert.match(glossary, /\*\*reviewer-accept\*\*:/);
  assert.match(glossary, /not operator authority/i);
});

test("grill: --stage backlog does not require an artifact", async () => {
  const add: string[] = [];
  const remove: string[] = [];
  const deps: TriageDeps = {
    getIssueLabels: async () => ["pipeline:ready"],
    addLabel: async (_n, l) => {
      add.push(l);
    },
    removeLabel: async (_n, l) => {
      remove.push(l);
    },
    log: () => {},
  };
  await runTriage({ issueArg: "10", stage: "backlog" }, deps);
  assert.deepEqual(add, ["pipeline:backlog"]);
  assert.deepEqual(remove, ["pipeline:ready"]);
});

test("grill: reviewer prompt builders stay Decisions-only", () => {
  const impl = buildGrillImplementerPrompt({
    title: "T",
    body: "SECRET-BODY",
    integrationBaseSha: "abc",
    contextMd: "FULL CONTEXT.md TEXT",
    dependencyFacts: "none",
  });
  const rev = buildGrillReviewerPrompt({
    artifactJson: '{"schema_version":"decisions.v1"}',
    fingerprintJson: '{"schema_version":"grill-fingerprint.v1"}',
  });
  assert.match(impl, /SECRET-BODY/);
  assert.doesNotMatch(rev, /SECRET-BODY/);
  assert.doesNotMatch(rev, /FULL CONTEXT\.md TEXT/);
  assert.doesNotMatch(rev, /You are the Implementer/);
  assert.match(rev, /decisions\.v1/);
});

test("grill: unresolvedAuthorityNodes treats reviewer-accept as non-settling for operator-required", () => {
  const n = makeNode({ id: "scope", question: "Q", recommendation: "R", class: "scope" });
  n.provenance.reviewer_verdict = "accept";
  assert.equal(unresolvedAuthorityNodes([n]).length, 1);
});
