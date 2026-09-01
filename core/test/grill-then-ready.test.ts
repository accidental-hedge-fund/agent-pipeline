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
  nodeDefinitionDigest,
  nodeInputDigests,
  unresolvedAuthorityNodes,
  DEPENDENCY_FACT_CODES,
  type DecisionsArtifact,
  type DecisionNode,
  type TypedUnresolvedFact,
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
  hashDependencyClosure,
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
import {
  GRILL_DEP_MAX_DEPTH,
  GRILL_DEP_MAX_ISSUES,
  walkDeclaredDependencyClosure,
} from "../scripts/grill-facts.ts";
import {
  classifyContextProposals,
  recordRequiredContextHashes,
  requiredContextSatisfied,
} from "../scripts/grill-context.ts";
import {
  frontierNodesFromArtifact,
  grillFrontierPath,
  issueGrillFrontier,
  liveMatchesGrillFrontier,
  loadVerifiedGrillFrontier,
  persistGrillFrontier,
  verifyGrillFrontier,
  type GrillFrontierBinding,
} from "../scripts/grill-frontier.ts";
import { validateDecisionsForReady } from "../scripts/grill-ready.ts";
import {
  canCreateHandoff,
  createAndPersistHandoff,
  answerAndPersistHandoff,
  listHandoffs,
  loadHandoff,
  saveHandoff,
  type HandoffStoreDeps,
  type HumanQuestionHandoff,
} from "../scripts/human-question-handoff.ts";
import {
  createPendingGrillHandoffs,
  grillAuthorityCreateInputs,
  materializeGrillAnswer,
  materializeGrillNode,
  isGrillAuthorityDeclaration,
  parseGrillDeclaration,
  supersedeStaleGrillHandoffs,
} from "../scripts/grill-handoff.ts";
import {
  runRefineSpecApply,
  runRefineSpecIssuePreview,
  type GrillIssueApplyDeps,
  type GrillIssuePreviewDeps,
} from "../scripts/grill-issue.ts";
import { runTriage, TriageReadyError, type TriageDeps } from "../scripts/stages/triage.ts";
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
    dependencyClosure: { ids: [], per_id: [], fact_codes: [] },
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
  const definitionSha = nodeDefinitionDigest(node);
  const definitionHex = definitionSha.slice("sha256:".length);
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
    scope: { candidate_sha: null, content_hashes: ["sha256:" + "a".repeat(64), "fp", node.id, definitionSha] },
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
    declaration_identity: `grill-v1:${node.id}:${"b".repeat(64)}:${"a".repeat(64)}:${definitionHex}`,
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

function frontierFor(
  body: string,
  art: DecisionsArtifact,
  repo = "acme/repo",
  issue = 42,
): GrillFrontierBinding {
  return {
    repo,
    issue,
    body_sha256: sha256Prefixed(body),
    nodes: frontierNodesFromArtifact(art),
  };
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
    frontier: frontierFor(body, art),
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

test("grill: parse rejects stored input_digests that do not match live definition fields", () => {
  const spec = "## Summary\nX\n";
  const node = makeNode({
    id: "scope",
    question: "What is in scope?",
    recommendation: "keep it small",
    class: "scope",
  });
  node.input_digests = {
    ...node.input_digests,
    question_sha256: sha256Prefixed("different question"),
  };
  const parsed = parseDecisionsArtifact(artifact([node], spec));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "digest_mismatch");
    assert.match(parsed.reason, /input_digests do not match the live definition/);
  }
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
    listIssueBodyRevisions: async () => [],
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
    fetchDependencyIssue: async () => ({ ok: false, code: "missing" }),
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

function implementerPayload(body: string): string {
  const nodes = canonicalThinIssueNodes();
  return JSON.stringify({
    title: "T",
    body,
    milestone: null,
    nodes: nodes.map((n) => ({
      id: n.id,
      question: n.question,
      recommendation: "rec",
      class: n.class,
    })),
    context_proposals: [],
  });
}

const THIN_SPEC =
  "## Summary\nThin.\n\n## User story\nAs a user, / I want x, / so that y.\n\n## Acceptance criteria\n- [ ] x\n\n## Out of scope\n- y";

async function signedPreview(): Promise<GrillProposalEnvelope> {
  const deps = previewDeps({});
  await withExit(async () => {
    await runRefineSpecIssuePreview(42, deps);
  });
  const raw = deps.writes.find((w) => w.startsWith("stdout:"))!.slice("stdout:".length);
  return JSON.parse(raw) as GrillProposalEnvelope;
}

test("grill: apply persists a MAC-valid canonical frontier that ready requires", async () => {
  const env = await signedPreview();
  const keyDeps = memoryKeyDeps();
  const store = memoryHandoffStore();
  await withExit(async () => {
    const deps = applyDeps(env, { handoffStore: store, keyDeps });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 0);
  });
  const loaded = loadVerifiedGrillFrontier("/tmp/repo", 42, "test-key", env.repo, keyDeps);
  assert.ok(loaded);
  assert.equal(loaded?.issue, 42);
  assert.equal(loaded?.body_sha256, sha256Prefixed(env.proposal.body));
  assert.deepEqual(
    loaded?.nodes.map((n) => n.id).sort(),
    env.proposal.artifact.nodes.map((n) => n.id).sort(),
  );
  const match = liveMatchesGrillFrontier(env.proposal.body, env.proposal.artifact.nodes, loaded!);
  assert.equal(match.ok, true);
  const signed = issueGrillFrontier({
    repo: env.repo,
    issue: 42,
    body: env.proposal.body,
    artifact: env.proposal.artifact,
    now: new Date("2026-01-01T00:00:00Z"),
    key: "test-key",
  });
  const verified = verifyGrillFrontier(signed, "test-key", { repo: env.repo, issue: 42 });
  assert.equal(verified.ok, true);
  const tampered = { ...signed, nodes: signed.nodes.map((n) => ({ ...n, class: "docs-surface" })) };
  const forged = verifyGrillFrontier(tampered, "test-key", { repo: env.repo, issue: 42 });
  assert.equal(forged.ok, false);
});

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
    frontier: frontierFor(env.proposal.body, env.proposal.artifact),
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
    frontier: frontierFor(body, art),
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
    frontier: frontierFor(body, art),
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

test("grill: walker omits root from closure record", async () => {
  const walk = await walkDeclaredDependencyClosure(1, "Root", "Depends on #2", {
    fetchIssue: async (id) => {
      if (id === 2) return { ok: true, title: "Child", body: "leaf" };
      return { ok: false, code: "missing" };
    },
  });
  assert.equal(walk.record.ids.includes(1), false);
  assert.equal(walk.record.per_id.some((p) => p.id === 1), false);
  assert.deepEqual(walk.record.ids, [2]);
  assert.equal(walk.record.per_id.length, 1);
  assert.equal(walk.record.per_id[0]!.id, 2);
  assert.equal(walk.record.per_id[0]!.title_sha256, sha256Prefixed("Child"));
  assert.equal(walk.record.per_id[0]!.body_sha256, sha256Prefixed("leaf"));
});

test("grill: Decisions metadata does not change dependency-closure hash", async () => {
  const spec = "## Summary\nDepends on #2.\n";
  const fetchIssue = async (id: number) => {
    if (id === 2) return { ok: true as const, title: "Child", body: "leaf" };
    return { ok: false as const, code: "missing" as const };
  };
  const before = await walkDeclaredDependencyClosure(10, "T", spec, { fetchIssue });
  const withFence = embedDecisionsInBody(spec, artifact(canonicalThinIssueNodes(), spec, "T"));
  assert.match(withFence, /pipeline-decisions-v1/);
  assert.match(withFence, /## Decisions/);
  const afterFence = await walkDeclaredDependencyClosure(10, "T", withFence, { fetchIssue });
  assert.equal(hashDependencyClosure(afterFence.record), hashDependencyClosure(before.record));
  assert.deepEqual(afterFence.record.ids, before.record.ids);
});

test("grill: root edges come from title and specification core not Decisions text", async () => {
  const spec = "## Summary\nDepends on #2.\n";
  const nodes = canonicalThinIssueNodes().map((n) => {
    const next = { ...n, recommendation: "Depends on #99" };
    next.input_digests = nodeInputDigests(next);
    return next;
  });
  const body = embedDecisionsInBody(spec, artifact(nodes, spec, "Depends on #3"));
  assert.match(body, /Depends on #99/);
  const fetched: number[] = [];
  const walk = await walkDeclaredDependencyClosure(10, "Depends on #3", body, {
    fetchIssue: async (id) => {
      fetched.push(id);
      return { ok: true, title: `I${id}`, body: "leaf" };
    },
  });
  assert.ok(fetched.includes(2), "specification core Depends on #2");
  assert.ok(fetched.includes(3), "title Depends on #3");
  assert.equal(fetched.includes(99), false);
  assert.equal(walk.record.ids.includes(10), false);
});

test("grill: child title or body change changes dependency-closure hash", async () => {
  const walk1 = await walkDeclaredDependencyClosure(1, "R", "Depends on #2", {
    fetchIssue: async () => ({ ok: true, title: "Child", body: "leaf" }),
  });
  const walk2 = await walkDeclaredDependencyClosure(1, "R", "Depends on #2", {
    fetchIssue: async () => ({ ok: true, title: "Child", body: "leaf changed" }),
  });
  const walk3 = await walkDeclaredDependencyClosure(1, "R", "Depends on #2", {
    fetchIssue: async () => ({ ok: true, title: "Child retitled", body: "leaf" }),
  });
  assert.notEqual(hashDependencyClosure(walk1.record), hashDependencyClosure(walk2.record));
  assert.notEqual(hashDependencyClosure(walk1.record), hashDependencyClosure(walk3.record));
});

test("grill: empty declared-dependency set hashes empty closure record", async () => {
  const walk = await walkDeclaredDependencyClosure(1, "R", "no declared deps", {
    fetchIssue: async () => {
      assert.fail("empty closure must not fetch");
    },
  });
  assert.deepEqual(walk.record, { ids: [], per_id: [], fact_codes: [] });
  assert.equal(
    hashDependencyClosure(walk.record),
    hashDependencyClosure({ ids: [], per_id: [], fact_codes: [] }),
  );
});

test("grill: inaccessible dependency is a typed unresolved fact", async () => {
  const walk = await walkDeclaredDependencyClosure(1, "A", "Depends on #8", {
    fetchIssue: async () => ({ ok: false, code: "inaccessible" }),
  });
  assert.ok(walk.facts.some((f) => f.code === "dependency.inaccessible"));
  assert.equal(walk.record.ids.includes(1), false);
});

test("grill: depth and count exhaustion remain fail-closed", async () => {
  const depth = await walkDeclaredDependencyClosure(1, "A", "Depends on #2", {
    fetchIssue: async (id) => ({ ok: true, title: `I${id}`, body: `Depends on #${id + 1}` }),
  });
  assert.ok(depth.facts.some((f) => f.code === "dependency.closure_exhausted"));
  assert.match(depth.facts.find((f) => f.code === "dependency.closure_exhausted")!.message, new RegExp(`depth ${GRILL_DEP_MAX_DEPTH}`));

  const listed = Array.from({ length: GRILL_DEP_MAX_ISSUES + 1 }, (_, i) => `#${i + 2}`).join(" ");
  const count = await walkDeclaredDependencyClosure(1, "A", `## Dependencies\n${listed}\n`, {
    fetchIssue: async (id) => ({ ok: true, title: `I${id}`, body: "leaf" }),
  });
  assert.ok(count.facts.some((f) => f.code === "dependency.closure_exhausted"));
  assert.equal(count.record.ids.includes(1), false);
  assert.ok(count.record.ids.length <= GRILL_DEP_MAX_ISSUES);
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

test("grill: materialize patches one node; drift refuses; already-resolved patched body requires receipt", () => {
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

  const alreadyResolved = materializeGrillNode({
    liveBody: first.body,
    handoff: created.handoff,
    answerText: "ship it",
  });
  assert.equal(alreadyResolved.ok, false);
  if (!alreadyResolved.ok) assert.equal(alreadyResolved.code, "body_hash_drift");
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
  const tamperedNodes = art.nodes.map((n, i) => {
    if (i !== 1) return n;
    const next = { ...n, recommendation: "tampered recommendation" };
    next.input_digests = nodeInputDigests(next);
    return next;
  });
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

function readySnap(
  body: string,
  art: DecisionsArtifact,
  handoffs: HumanQuestionHandoff[],
  frontier?: GrillFrontierBinding | null,
): GrillReadySnapshot {
  return {
    title: "T",
    body,
    comments: [],
    fingerprint: art.fingerprint,
    contextMd: "**Grill**:\nA one-shot intake interview.\n",
    integrationBaseSha: art.fingerprint.integration_base_sha,
    handoffs,
    frontier: frontier === undefined ? frontierFor(body, art) : frontier,
  };
}

test("grill: applied refinement supersedes stale bindings so ready is not stranded", async () => {
  const spec = "## Summary\nX\n";
  const artA = artifact(canonicalThinIssueNodes(), spec);
  const bodyA = embedDecisionsInBody(spec, artA);
  const store = memoryHandoffStore();
  const first = await createPendingGrillHandoffs(
    "/tmp/repo",
    {
      domain: "d",
      repo: "acme/r",
      issueNumber: 42,
      artifact: artA,
      proposedBody: bodyA,
      frontierFp: "fp",
    },
    store,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const nodesB = canonicalThinIssueNodes().map((n) =>
    n.id === "scope" ? makeNode({ id: n.id, question: "Revised scope question?", recommendation: n.recommendation, class: n.class }) : n,
  );
  const artB = artifact(nodesB, spec);
  const bodyB = embedDecisionsInBody(spec, artB);
  const second = await createPendingGrillHandoffs(
    "/tmp/repo",
    {
      domain: "d",
      repo: "acme/r",
      issueNumber: 42,
      artifact: artB,
      proposedBody: bodyB,
      frontierFp: "fp",
    },
    store,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const listedBefore = await listHandoffs("/tmp/repo", { issue: 42 }, store);
  const readyBefore = validateDecisionsForReady(readySnap(bodyB, artB, listedBefore));
  assert.equal(readyBefore.ok, false, "stale pending records must strand ready before supersession");
  if (!readyBefore.ok) assert.equal(readyBefore.code, "invalid_provenance");

  const retired = await supersedeStaleGrillHandoffs(
    "/tmp/repo",
    {
      issueNumber: 42,
      artifact: artB,
      proposedBody: bodyB,
      frontierFp: "fp",
      currentHandoffs: second.created,
    },
    store,
  );
  assert.equal(retired.ok, true, retired.ok ? "" : retired.reason);
  if (!retired.ok) return;
  assert.ok(retired.superseded.length >= 1);

  const listedAfter = await listHandoffs("/tmp/repo", { issue: 42 }, store);
  const readyAfter = validateDecisionsForReady(readySnap(bodyB, artB, listedAfter));
  assert.equal(readyAfter.ok, false);
  if (!readyAfter.ok) assert.equal(readyAfter.code, "unresolved_authority");

  const old = await loadHandoff("/tmp/repo", 42, first.created[0]!.handoff_id, store);
  assert.equal(old.ok, true);
  if (old.ok) {
    assert.equal(old.handoff.status, "superseded");
    assert.ok(old.handoff.superseded_by);
  }
});

test("grill: applied refinement keeps answered handoff that still binds the live node", async () => {
  const spec = "## Summary\nX\n";
  const nodes = settledOperatorNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  for (const n of nodes) {
    await saveHandoff("/tmp/repo", handoffForNode(n), store);
  }
  const retired = await supersedeStaleGrillHandoffs(
    "/tmp/repo",
    {
      issueNumber: 42,
      artifact: art,
      proposedBody: body,
      frontierFp: art.fingerprint.planning_treatment_sha256,
      currentHandoffs: [],
    },
    store,
  );
  assert.equal(retired.ok, true, retired.ok ? "" : retired.reason);
  if (!retired.ok) return;
  assert.equal(retired.superseded.length, 0);
  const loaded = await loadHandoff("/tmp/repo", 42, `hqh_${nodes[0]!.id}`, store);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.handoff.status, "answered");
  const listed = await listHandoffs("/tmp/repo", { issue: 42 }, store);
  const ready = validateDecisionsForReady(readySnap(body, art, listed));
  assert.equal(ready.ok, true, ready.ok ? "" : ready.reason);
});

test("grill: applied refinement retires a dropped-node handoff without a replacement", async () => {
  const spec = "## Summary\nX\n";
  const artA = artifact(canonicalThinIssueNodes(), spec);
  const bodyA = embedDecisionsInBody(spec, artA);
  const store = memoryHandoffStore();
  const first = await createPendingGrillHandoffs(
    "/tmp/repo",
    {
      domain: "d",
      repo: "acme/r",
      issueNumber: 42,
      artifact: artA,
      proposedBody: bodyA,
      frontierFp: "fp",
    },
    store,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const nodesB = canonicalThinIssueNodes().filter((n) => n.id !== "scope");
  const artB = artifact(nodesB, spec);
  const bodyB = embedDecisionsInBody(spec, artB);
  const second = await createPendingGrillHandoffs(
    "/tmp/repo",
    {
      domain: "d",
      repo: "acme/r",
      issueNumber: 42,
      artifact: artB,
      proposedBody: bodyB,
      frontierFp: "fp",
    },
    store,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const scopePrior = first.created.find(
    (h) => parseGrillDeclaration(h.declaration_identity ?? "")?.nodeId === "scope",
  );
  assert.ok(scopePrior);
  const retired = await supersedeStaleGrillHandoffs(
    "/tmp/repo",
    {
      issueNumber: 42,
      artifact: artB,
      proposedBody: bodyB,
      frontierFp: "fp",
      currentHandoffs: second.created,
    },
    store,
  );
  assert.equal(retired.ok, true, retired.ok ? "" : retired.reason);
  if (!retired.ok) return;
  const loaded = await loadHandoff("/tmp/repo", 42, scopePrior!.handoff_id, store);
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.handoff.status, "superseded");
    assert.equal(loaded.handoff.superseded_by, null);
  }
  const listed = await listHandoffs("/tmp/repo", { issue: 42 }, store);
  const ready = validateDecisionsForReady(readySnap(bodyB, artB, listed));
  assert.equal(ready.ok, false);
  if (!ready.ok) assert.equal(ready.code, "unresolved_authority");
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
  const originalDecl = parseGrillDeclaration(siblingCreated.handoff.declaration_identity ?? "");
  assert.equal(reboundDecl?.definitionSha256, originalDecl?.definitionSha256);
  assert.equal(rebound.handoff.scope.content_hashes?.[0], sha256Prefixed(live));
  assert.equal(rebound.handoff.scope.content_hashes?.[3], siblingCreated.handoff.scope.content_hashes?.[3]);
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

test("grill: materialize persists the next authenticated frontier for the written body", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const keyDeps = memoryKeyDeps();
  persistGrillFrontier(
    "/tmp/repo",
    issueGrillFrontier({
      repo: "acme/r",
      issue: 42,
      body,
      artifact: art,
      now: new Date("2026-01-01T00:00:00Z"),
      key: "test-key",
    }),
    keyDeps,
  );
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
  let live = body;
  const result = await materializeGrillAnswer(created.handoff, "yes", {
    getIssueBody: async () => live,
    updateIssueBody: async (_n, next) => {
      live = next;
    },
    repoDir: "/tmp/repo",
    handoffStore: store,
    keyDeps,
    frontierKey: "test-key",
    now: () => new Date("2026-01-01T00:00:01Z"),
  });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  const next = loadVerifiedGrillFrontier("/tmp/repo", 42, "test-key", "acme/r", keyDeps);
  assert.ok(next);
  assert.equal(next?.body_sha256, sha256Prefixed(live));
  assert.notEqual(next?.body_sha256, sha256Prefixed(body));
  assert.deepEqual(
    next?.nodes.map((n) => `${n.id}:${n.class}`).sort(),
    art.nodes.map((n) => `${n.id}:${n.class}`).sort(),
  );
  const match = liveMatchesGrillFrontier(live, result.artifact.nodes, next!);
  assert.equal(match.ok, true);
});

test("grill: persist-after-write failure heals on retry without a second write", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const keyDeps = memoryKeyDeps();
  persistGrillFrontier(
    "/tmp/repo",
    issueGrillFrontier({
      repo: "acme/r",
      issue: 42,
      body,
      artifact: art,
      now: new Date("2026-01-01T00:00:00Z"),
      key: "test-key",
    }),
    keyDeps,
  );
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
      const r = await materializeGrillAnswer(h, text, {
        getIssueBody: async () => live,
        updateIssueBody: async (_n, next) => {
          writes++;
          live = next;
        },
        repoDir: "/tmp/repo",
        handoffStore: store,
        keyDeps,
        frontierKey: "test-key",
        now: () => new Date("2026-01-01T00:00:01Z"),
      });
      return r.ok ? { ok: true as const, wrote: r.wrote } : r;
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

test("grill: sibling-store failure after body write rebinds siblings on receipt retry", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const keyDeps = memoryKeyDeps();
  persistGrillFrontier(
    "/tmp/repo",
    issueGrillFrontier({
      repo: "acme/r",
      issue: 42,
      body,
      artifact: art,
      now: new Date("2026-01-01T00:00:00Z"),
      key: "test-key",
    }),
    keyDeps,
  );
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
  const originalSiblingHash = siblingCreated.handoff.scope.content_hashes?.[0];
  let siblingFailOnce = true;
  const failingStore: HandoffStoreDeps = {
    ...store,
    writeFile: async (p, data) => {
      if (siblingFailOnce && p.endsWith(`${siblingCreated.handoff.handoff_id}.json`)) {
        siblingFailOnce = false;
        throw new Error("sibling store boom");
      }
      await store.writeFile(p, data);
    },
  };
  let writes = 0;
  let live = body;
  const hook = {
    materialize: async (h: HumanQuestionHandoff, text: string) => {
      const r = await materializeGrillAnswer(h, text, {
        getIssueBody: async () => live,
        updateIssueBody: async (_n, next) => {
          writes++;
          live = next;
        },
        repoDir: "/tmp/repo",
        handoffStore: failingStore,
        keyDeps,
        frontierKey: "test-key",
        now: () => new Date("2026-01-01T00:00:01Z"),
      });
      return r.ok ? { ok: true as const, wrote: r.wrote } : r;
    },
  };
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
    hook,
  );
  assert.equal(first.ok, false);
  assert.equal(first.code, "write_failed");
  assert.equal(writes, 1);
  const siblingAfterFail = await loadHandoff(
    "/tmp/repo",
    42,
    siblingCreated.handoff.handoff_id,
    store,
  );
  assert.equal(siblingAfterFail.ok, true);
  if (!siblingAfterFail.ok) return;
  assert.equal(siblingAfterFail.handoff.status, "pending");
  assert.equal(siblingAfterFail.handoff.scope.content_hashes?.[0], originalSiblingHash);
  const targetAfterFail = await loadHandoff(
    "/tmp/repo",
    42,
    firstCreated.handoff.handoff_id,
    store,
  );
  assert.equal(targetAfterFail.ok, true);
  if (targetAfterFail.ok) assert.equal(targetAfterFail.handoff.status, "pending");
  const retry = await answerAndPersistHandoff(
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
    hook,
  );
  assert.equal(retry.ok, true, retry.ok ? "" : retry.reason);
  assert.equal(writes, 1);
  const rebound = await loadHandoff("/tmp/repo", 42, siblingCreated.handoff.handoff_id, store);
  assert.equal(rebound.ok, true);
  if (!rebound.ok) return;
  assert.equal(rebound.handoff.status, "pending");
  const reboundDecl = parseGrillDeclaration(rebound.handoff.declaration_identity ?? "");
  assert.ok(reboundDecl);
  assert.equal(reboundDecl?.bodySha256, sha256Prefixed(live).slice("sha256:".length));
  assert.equal(rebound.handoff.scope.content_hashes?.[0], sha256Prefixed(live));
  const originalDecl = parseGrillDeclaration(siblingCreated.handoff.declaration_identity ?? "");
  assert.equal(reboundDecl?.definitionSha256, originalDecl?.definitionSha256);
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
    hook,
  );
  assert.equal(second.ok, true, second.ok ? "" : second.reason);
  assert.equal(writes, 2);
});

test("grill: receipt recovery does not overwrite a sibling's newer frontier", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const keyDeps = memoryKeyDeps();
  persistGrillFrontier(
    "/tmp/repo",
    issueGrillFrontier({
      repo: "acme/r",
      issue: 42,
      body,
      artifact: art,
      now: new Date("2026-01-01T00:00:00Z"),
      key: "test-key",
    }),
    keyDeps,
  );
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
  let siblingFailOnce = true;
  const failingStore: HandoffStoreDeps = {
    ...store,
    writeFile: async (p, data) => {
      if (siblingFailOnce && p.endsWith(`${siblingCreated.handoff.handoff_id}.json`)) {
        siblingFailOnce = false;
        throw new Error("sibling store boom");
      }
      await store.writeFile(p, data);
    },
  };
  let writes = 0;
  let live = body;
  const makeHook = (handoffStore: HandoffStoreDeps) => ({
    materialize: async (h: HumanQuestionHandoff, text: string) => {
      const r = await materializeGrillAnswer(h, text, {
        getIssueBody: async () => live,
        updateIssueBody: async (_n, next) => {
          writes++;
          live = next;
        },
        repoDir: "/tmp/repo",
        handoffStore,
        keyDeps,
        frontierKey: "test-key",
        now: () => new Date("2026-01-01T00:00:01Z"),
      });
      return r.ok ? { ok: true as const, wrote: r.wrote } : r;
    },
  });
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
    makeHook(failingStore),
  );
  assert.equal(first.ok, false);
  assert.equal(first.code, "write_failed");
  assert.equal(writes, 1);
  const recoveredBody = live;
  let interleaved = false;
  const interleavingStore: HandoffStoreDeps = {
    ...store,
    writeFile: async (p, data) => {
      await store.writeFile(p, data);
      if (interleaved) return;
      if (!p.endsWith(`${siblingCreated.handoff.handoff_id}.json`)) return;
      const parsed = JSON.parse(data) as { status?: string };
      if (parsed.status !== "pending") return;
      interleaved = true;
      const siblingAnswer = await answerAndPersistHandoff(
        "/tmp/repo",
        42,
        siblingCreated.handoff.handoff_id,
        {
          decision: "answer",
          actor: "bob",
          identitySource: "gh",
          authenticated: true,
          answerText: "yes",
        },
        store,
        makeHook(store),
      );
      assert.equal(siblingAnswer.ok, true, siblingAnswer.ok ? "" : siblingAnswer.reason);
    },
  };
  const retry = await answerAndPersistHandoff(
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
    makeHook(interleavingStore),
  );
  assert.equal(retry.ok, true, retry.ok ? "" : retry.reason);
  assert.equal(interleaved, true);
  assert.equal(writes, 2);
  assert.notEqual(sha256Prefixed(live), sha256Prefixed(recoveredBody));
  const frontier = loadVerifiedGrillFrontier("/tmp/repo", 42, "test-key", "acme/r", keyDeps);
  assert.ok(frontier);
  assert.equal(frontier?.body_sha256, sha256Prefixed(live));
  assert.notEqual(frontier?.body_sha256, sha256Prefixed(recoveredBody));
  const parsedLive = parseDecisionsFromBody(live);
  assert.equal(parsedLive.ok, true);
  if (!parsedLive.ok) return;
  const match = liveMatchesGrillFrontier(live, parsedLive.artifact.nodes, frontier!);
  assert.equal(match.ok, true, match.ok ? "" : match.reason);
  const listed = await listHandoffs("/tmp/repo", { issue: 42 }, store);
  const target = listed.find((h) => h.handoff_id === firstCreated.handoff.handoff_id);
  const sibling = listed.find((h) => h.handoff_id === siblingCreated.handoff.handoff_id);
  assert.equal(target?.status, "answered");
  assert.equal(sibling?.status, "answered");
});

test("grill: issue-run lock refuses a nested sibling answer during recovery", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const keyDeps = memoryKeyDeps();
  persistGrillFrontier(
    "/tmp/repo",
    issueGrillFrontier({
      repo: "acme/r",
      issue: 42,
      body,
      artifact: art,
      now: new Date("2026-01-01T00:00:00Z"),
      key: "test-key",
    }),
    keyDeps,
  );
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
  let siblingFailOnce = true;
  const failingStore: HandoffStoreDeps = {
    ...store,
    writeFile: async (p, data) => {
      if (siblingFailOnce && p.endsWith(`${siblingCreated.handoff.handoff_id}.json`)) {
        siblingFailOnce = false;
        throw new Error("sibling store boom");
      }
      await store.writeFile(p, data);
    },
  };
  let writes = 0;
  let live = body;
  let lockHeld = false;
  const withIssueLock = async <T>(
    _domain: string,
    _issueNumber: number,
    fn: () => Promise<T>,
  ): Promise<T> => {
    if (lockHeld) throw new Error("issue-run lock held");
    lockHeld = true;
    try {
      return await fn();
    } finally {
      lockHeld = false;
    }
  };
  const makeHook = (handoffStore: HandoffStoreDeps) => ({
    withIssueLock,
    materialize: async (h: HumanQuestionHandoff, text: string) => {
      const r = await materializeGrillAnswer(h, text, {
        getIssueBody: async () => live,
        updateIssueBody: async (_n, next) => {
          writes++;
          live = next;
        },
        repoDir: "/tmp/repo",
        handoffStore,
        keyDeps,
        frontierKey: "test-key",
        now: () => new Date("2026-01-01T00:00:01Z"),
      });
      return r.ok ? { ok: true as const, wrote: r.wrote } : r;
    },
  });
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
    makeHook(failingStore),
  );
  assert.equal(first.ok, false);
  assert.equal(writes, 1);
  const recoveredBody = live;
  let nested: { ok: boolean; code?: string } | null = null;
  const interleavingStore: HandoffStoreDeps = {
    ...store,
    writeFile: async (p, data) => {
      await store.writeFile(p, data);
      if (nested) return;
      if (!p.endsWith(`${siblingCreated.handoff.handoff_id}.json`)) return;
      const parsed = JSON.parse(data) as { status?: string };
      if (parsed.status !== "pending") return;
      nested = await answerAndPersistHandoff(
        "/tmp/repo",
        42,
        siblingCreated.handoff.handoff_id,
        {
          decision: "answer",
          actor: "bob",
          identitySource: "gh",
          authenticated: true,
          answerText: "yes",
        },
        store,
        makeHook(store),
      );
    },
  };
  const retry = await answerAndPersistHandoff(
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
    makeHook(interleavingStore),
  );
  assert.equal(retry.ok, true, retry.ok ? "" : retry.reason);
  assert.ok(nested);
  assert.equal(nested?.ok, false);
  assert.equal(nested?.code, "lock_held");
  assert.equal(writes, 1);
  const frontier = loadVerifiedGrillFrontier("/tmp/repo", 42, "test-key", "acme/r", keyDeps);
  assert.equal(frontier?.body_sha256, sha256Prefixed(recoveredBody));
  const siblingAfter = await loadHandoff("/tmp/repo", 42, siblingCreated.handoff.handoff_id, store);
  assert.equal(siblingAfter.ok, true);
  if (siblingAfter.ok) assert.equal(siblingAfter.handoff.status, "pending");
});

test("grill: persist-after-write then drifted spec/fingerprint refuses retry without replacing frontier", async () => {
  const spec = "## Summary\nX\n";
  const nodes = canonicalThinIssueNodes();
  const art = artifact(nodes, spec);
  const body = embedDecisionsInBody(spec, art);
  const store = memoryHandoffStore();
  const keyDeps = memoryKeyDeps();
  persistGrillFrontier(
    "/tmp/repo",
    issueGrillFrontier({
      repo: "acme/r",
      issue: 42,
      body,
      artifact: art,
      now: new Date("2026-01-01T00:00:00Z"),
      key: "test-key",
    }),
    keyDeps,
  );
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
      const r = await materializeGrillAnswer(h, text, {
        getIssueBody: async () => live,
        updateIssueBody: async (_n, next) => {
          writes++;
          live = next;
        },
        repoDir: "/tmp/repo",
        handoffStore: store,
        keyDeps,
        frontierKey: "test-key",
        now: () => new Date("2026-01-01T00:00:01Z"),
      });
      return r.ok ? { ok: true as const, wrote: r.wrote } : r;
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
  const patched = parseDecisionsFromBody(live);
  assert.equal(patched.ok, true);
  if (!patched.ok) return;
  const decl = parseGrillDeclaration(created.handoff.declaration_identity ?? "");
  assert.ok(decl);
  const target = patched.artifact.nodes.find((n) => n.id === decl?.nodeId);
  assert.equal(target?.resolution, "resolved");
  assert.equal(target?.provenance.reference, `handoff:${created.handoff.handoff_id}`);
  const driftedSpec = "## Summary\nY\n";
  const driftedArt: DecisionsArtifact = {
    ...patched.artifact,
    fingerprint: {
      ...patched.artifact.fingerprint,
      applied_body_sha256: sha256Prefixed(driftedSpec),
      planning_treatment_sha256: sha256Prefixed("drifted-treatment"),
    },
  };
  const driftedBody = embedDecisionsInBody(driftedSpec, driftedArt);
  assert.notEqual(extractSpecCore(live), extractSpecCore(driftedBody));
  assert.notEqual(
    patched.artifact.fingerprint.planning_treatment_sha256,
    driftedArt.fingerprint.planning_treatment_sha256,
  );
  const driftedParsed = parseDecisionsFromBody(driftedBody);
  assert.equal(driftedParsed.ok, true);
  if (!driftedParsed.ok) return;
  const driftedNode = driftedParsed.artifact.nodes.find((n) => n.id === decl?.nodeId);
  assert.equal(nodeDefinitionDigest(driftedNode!), nodeDefinitionDigest(target!));
  assert.equal(driftedNode?.provenance.reference, `handoff:${created.handoff.handoff_id}`);
  const frontierFile = grillFrontierPath("/tmp/repo", 42);
  const frontierBefore = keyDeps.readFile(frontierFile);
  const verifiedBefore = loadVerifiedGrillFrontier("/tmp/repo", 42, "test-key", "acme/r", keyDeps);
  assert.equal(verifiedBefore?.body_sha256, sha256Prefixed(live));
  live = driftedBody;
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
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "body_hash_drift");
  assert.equal(writes, 1);
  assert.equal(keyDeps.readFile(frontierFile), frontierBefore);
  const verifiedAfter = loadVerifiedGrillFrontier("/tmp/repo", 42, "test-key", "acme/r", keyDeps);
  assert.equal(verifiedAfter?.body_sha256, verifiedBefore?.body_sha256);
  const loaded = await loadHandoff("/tmp/repo", 42, created.handoff.handoff_id, store);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.handoff.status, "pending");
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

function rewriteAuthorityNodeAsReviewerDefault(
  body: string,
  regenerateDigests: boolean,
): string {
  const parsed = parseDecisionsFromBody(body);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  if (!parsed.ok) return body;
  const nodes = parsed.artifact.nodes.map((n) => {
    if (n.id !== "scope") return n;
    const next: DecisionNode = {
      ...n,
      class: "interface-contract",
      resolution: "resolved",
      provenance: {
        settled_by: "reviewer-accept",
        reference: null,
        reviewer_verdict: "accept",
        reviewer_reason: "self-rewritten",
        eligibility_reason: NON_AUTHORITY_ELIGIBILITY_REASON,
      },
    };
    if (regenerateDigests) {
      next.input_digests = nodeInputDigests(next);
    }
    return next;
  });
  return embedDecisionsInBody(extractSpecCore(body), { ...parsed.artifact, nodes });
}

test("grill: rewritten authority class with recomputed fence fails ready without label writes", async () => {
  const spec = "## Summary\nX\n";
  const art = artifact(canonicalThinIssueNodes(), spec);
  const body = embedDecisionsInBody(spec, art);
  const inputs = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 42,
    artifact: art,
    proposedBody: body,
    frontierFp: art.fingerprint.planning_treatment_sha256,
  });
  const created = canCreateHandoff(inputs[0]!);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const pending = inputs.map((input) => {
    const r = canCreateHandoff(input);
    assert.equal(r.ok, true);
    return r.ok ? r.handoff : created.handoff;
  });
  const tampered = rewriteAuthorityNodeAsReviewerDefault(body, false);
  assert.equal(extractSpecCore(body), extractSpecCore(tampered));
  assert.notEqual(sha256Prefixed(body), sha256Prefixed(tampered));
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
      body: tampered,
      comments: [],
      fingerprint: art.fingerprint,
      contextMd: "**Grill**:\nA one-shot intake interview.\n",
      integrationBaseSha: art.fingerprint.integration_base_sha,
      handoffs: pending,
      frontier: frontierFor(body, art),
    }),
  };
  await assert.rejects(() => runTriage({ issueArg: "42", stage: "ready" }, deps), (err: Error) => {
    assert.equal(err instanceof TriageReadyError, true);
    assert.equal((err as TriageReadyError).exitCode, 2);
    return true;
  });
  assert.deepEqual(add, []);
  assert.deepEqual(remove, []);
});

test("grill: rewritten authority class with regenerated digests still fails ready without label writes", async () => {
  const spec = "## Summary\nX\n";
  const art = artifact(canonicalThinIssueNodes(), spec);
  const body = embedDecisionsInBody(spec, art);
  const inputs = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 42,
    artifact: art,
    proposedBody: body,
    frontierFp: art.fingerprint.planning_treatment_sha256,
  });
  const pending = inputs.map((input) => {
    const r = canCreateHandoff(input);
    assert.equal(r.ok, true);
    return r.ok ? r.handoff : (null as unknown as HumanQuestionHandoff);
  });
  const tampered = rewriteAuthorityNodeAsReviewerDefault(body, true);
  const parsed = parseDecisionsFromBody(tampered);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
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
      body: tampered,
      comments: [],
      fingerprint: art.fingerprint,
      contextMd: "**Grill**:\nA one-shot intake interview.\n",
      integrationBaseSha: art.fingerprint.integration_base_sha,
      handoffs: pending,
      frontier: frontierFor(body, art),
    }),
  };
  await assert.rejects(() => runTriage({ issueArg: "42", stage: "ready" }, deps), (err: Error) => {
    assert.equal(err instanceof TriageReadyError, true);
    assert.equal((err as TriageReadyError).exitCode, 2);
    assert.equal((err as TriageReadyError).code, "invalid_provenance");
    return true;
  });
  assert.deepEqual(add, []);
  assert.deepEqual(remove, []);
});

test("grill: rewritten authority node with regenerated body-local values and no handoffs fails ready", async () => {
  const spec = "## Summary\nX\n";
  const art = artifact(canonicalThinIssueNodes(), spec);
  const body = embedDecisionsInBody(spec, art);
  const appliedFrontier = frontierFor(body, art);
  const parsedOrig = parseDecisionsFromBody(body);
  assert.equal(parsedOrig.ok, true);
  if (!parsedOrig.ok) return;
  const rewrittenNodes = parsedOrig.artifact.nodes.map((n) => {
    const next: DecisionNode = {
      ...n,
      class: "docs-surface",
      resolution: "resolved",
      provenance: {
        settled_by: "reviewer-accept",
        reference: null,
        reviewer_verdict: "accept",
        reviewer_reason: "self-rewritten",
        eligibility_reason: NON_AUTHORITY_ELIGIBILITY_REASON,
      },
    };
    next.input_digests = nodeInputDigests(next);
    return next;
  });
  const tampered = embedDecisionsInBody(extractSpecCore(body), {
    ...parsedOrig.artifact,
    nodes: rewrittenNodes,
  });
  const parsed = parseDecisionsFromBody(tampered);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  if (parsed.ok) {
    assert.ok(parsed.artifact.nodes.every((n) => n.class === "docs-surface"));
    assert.ok(parsed.artifact.nodes.every((n) => n.provenance.settled_by === "reviewer-accept"));
  }
  const withoutFrontier = validateDecisionsForReady({
    title: "T",
    body: tampered,
    comments: [],
    fingerprint: art.fingerprint,
    contextMd: "**Grill**:\nA one-shot intake interview.\n",
    integrationBaseSha: art.fingerprint.integration_base_sha,
    handoffs: [],
    frontier: null,
  });
  assert.equal(withoutFrontier.ok, false);
  if (!withoutFrontier.ok) assert.equal(withoutFrontier.code, "invalid_provenance");
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
      body: tampered,
      comments: [],
      fingerprint: art.fingerprint,
      contextMd: "**Grill**:\nA one-shot intake interview.\n",
      integrationBaseSha: art.fingerprint.integration_base_sha,
      handoffs: [],
      frontier: appliedFrontier,
    }),
  };
  await assert.rejects(() => runTriage({ issueArg: "42", stage: "ready" }, deps), (err: Error) => {
    assert.equal(err instanceof TriageReadyError, true);
    assert.equal((err as TriageReadyError).exitCode, 2);
    assert.equal((err as TriageReadyError).code, "invalid_provenance");
    assert.match((err as TriageReadyError).message, /frontier|class does not match/);
    return true;
  });
  assert.deepEqual(add, []);
  assert.deepEqual(remove, []);
});

test("grill: second apply with a changed node definition supersedes first pending handoffs", async () => {
  const env = await signedPreview();
  const store = memoryHandoffStore();
  await withExit(async () => {
    const deps = applyDeps(env, { handoffStore: store });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 0);
  });
  const parsed = parseDecisionsFromBody(env.proposal.body);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  if (!parsed.ok) return;
  const nodes = parsed.artifact.nodes.map((n) => {
    if (n.id !== "scope") return n;
    return makeNode({
      id: n.id,
      question: "Revised live scope question?",
      recommendation: n.recommendation,
      class: n.class,
      term_id: n.term_id,
    });
  });
  const spec = extractSpecCore(env.proposal.body);
  const art2 = { ...parsed.artifact, nodes };
  const body2 = embedDecisionsInBody(spec, art2);
  const signed = issueGrillProposal({
    now: new Date("2026-01-01T00:00:00Z"),
    nonce: "c".repeat(32),
    repo: env.repo,
    issue: env.issue,
    input: {
      title: env.input.title,
      body: env.proposal.body,
      title_sha256: sha256Prefixed(env.input.title),
      body_sha256: sha256Prefixed(env.proposal.body),
      fingerprint: env.input.fingerprint,
    },
    proposal: {
      ...env.proposal,
      body: body2,
      artifact: art2,
    },
    key: "test-key",
  });
  assert.equal(signed.ok, true);
  if (!signed.ok) return;
  await withExit(async () => {
    const deps = applyDeps(signed.envelope, { handoffStore: store });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 0);
  });
  const afterSecond = await listHandoffs("/tmp/repo", { issue: 42 }, store);
  assert.ok(
    afterSecond.some((h) => h.status === "superseded"),
    "first-apply pending records must be superseded",
  );
  assert.ok(afterSecond.some((h) => h.status === "pending"));
  const ready = validateDecisionsForReady(readySnap(body2, art2, afterSecond));
  assert.equal(ready.ok, false);
  if (!ready.ok) assert.equal(ready.code, "unresolved_authority");
});

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
      frontier: frontierFor(body, art),
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

test("grill: ADR names pipeline grill as writer and does not say triage rewrites the body", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const adr = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../docs/adr/0002-decisions-live-in-the-issue-body.md"),
    "utf8",
  );
  assert.match(adr, /pipeline grill/);
  assert.doesNotMatch(adr, /`pipeline refine-spec --issue` \/ `apply` is the grill writer/);
  assert.doesNotMatch(adr, /Bare `pipeline triage N` is one implementer shot that rewrites the body/);
  assert.doesNotMatch(adr, /must not write CONTEXT\.md or ADRs/);
  assert.match(adr, /Root identity is title plus applied specification core/);
  assert.match(adr, /Dependency closure covers declared dependencies only/);
  assert.match(adr, /Pipeline-owned Decisions metadata is not a bound input/);
  const glossary = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../CONTEXT.md"),
    "utf8",
  );
  assert.match(glossary, /\*\*Grill\*\*:/);
  assert.match(glossary, /\*\*Decisions\*\*:/);
  assert.match(glossary, /\*\*Authority node\*\*:/);
  assert.match(glossary, /\*\*auto-accept\*\*:/);
  assert.match(glossary, /\*\*reviewer-accept\*\*:/);
  assert.match(glossary, /not operator authority/i);
  assert.match(glossary, /historical provenance/i);
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

const CONTEXT_MD = "**Grill**:\nA one-shot intake interview.\n";
const INTEGRATION_BASE = "abc123def456";

function childFetch(child: { title: string; body: string }, childId = 7) {
  return async (id: number) => {
    if (id === childId) return { ok: true as const, title: child.title, body: child.body };
    return { ok: false as const, code: "missing" as const };
  };
}

async function snapshotFingerprint(
  issueNumber: number,
  title: string,
  body: string,
  fetchIssue: (id: number) => Promise<{ ok: true; title: string; body: string } | { ok: false; code: "missing" | "inaccessible" }>,
): Promise<GrillFingerprint> {
  const walk = await walkDeclaredDependencyClosure(issueNumber, title, body, { fetchIssue });
  return buildGrillFingerprint({
    title,
    appliedBody: extractSpecCore(body),
    dependencyClosure: walk.record,
    integrationBaseSha: INTEGRATION_BASE,
    contextMd: CONTEXT_MD,
    providerConfig: PROVIDER,
    planningTreatment: TREATMENT,
  });
}

test("grill: preview signs dependency closure from proposed specification core", async () => {
  await withExit(async () => {
    const specWithDep = `${THIN_SPEC}\n\nDepends on #7.\n`;
    const child = { title: "Child seven", body: "leaf seven" };
    const deps = previewDeps({
      getIssue: async () => ({ title: "Thin issue", body: "needs work" }),
      fetchDependencyIssue: childFetch(child),
      implementerJson: implementerPayload(specWithDep),
    });
    await runRefineSpecIssuePreview(42, deps);
    assert.equal(process.exitCode, 0);
    const env = JSON.parse(
      deps.writes.find((w) => w.startsWith("stdout:"))!.slice("stdout:".length),
    ) as GrillProposalEnvelope;
    const signed = env.proposal.artifact.fingerprint.dependency_closure_sha256;
    const proposedWalk = await walkDeclaredDependencyClosure(42, "Thin issue", specWithDep, {
      fetchIssue: childFetch(child),
    });
    const preWalk = await walkDeclaredDependencyClosure(42, "Thin issue", "needs work", {
      fetchIssue: childFetch(child),
    });
    assert.equal(signed, hashDependencyClosure(proposedWalk.record));
    assert.notEqual(signed, hashDependencyClosure(preWalk.record));
    assert.equal(proposedWalk.record.ids.includes(42), false);
    assert.deepEqual(proposedWalk.record.ids, [7]);
  });
});

test("grill: apply walks proposal specification core and refuses mismatch or missing dependency", async () => {
  const specWithDep = `${THIN_SPEC}\n\nDepends on #7.\n`;
  const child = { title: "Child seven", body: "leaf seven" };
  const env = await (async () => {
    const deps = previewDeps({
      getIssue: async () => ({ title: "Thin issue", body: "needs work" }),
      fetchDependencyIssue: childFetch(child),
      implementerJson: implementerPayload(specWithDep),
    });
    await withExit(async () => {
      await runRefineSpecIssuePreview(42, deps);
    });
    return JSON.parse(
      deps.writes.find((w) => w.startsWith("stdout:"))!.slice("stdout:".length),
    ) as GrillProposalEnvelope;
  })();

  await withExit(async () => {
    const deps = applyDeps(env, { fetchDependencyIssue: childFetch(child) });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 0);
    assert.equal(deps.bodies.length, 1);
  });

  await withExit(async () => {
    const deps = applyDeps(env, {
      fetchDependencyIssue: childFetch({ title: "Child seven", body: "leaf mutated" }),
    });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 2);
    assert.equal(deps.bodies.length, 0);
  });

  await withExit(async () => {
    const deps = applyDeps(env, {
      fetchDependencyIssue: async () => ({ ok: false, code: "missing" }),
    });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 2);
    assert.equal(deps.bodies.length, 0);
  });
});

test("grill: ready snapshot ignores Decisions metadata and still stales on child change", async () => {
  const spec = "## Summary\nDepends on #7.\n";
  const child = { title: "Child seven", body: "leaf seven" };
  const specHash = await snapshotFingerprint(42, "T", spec, childFetch(child));
  const withFence = embedDecisionsInBody(spec, artifact(settledOperatorNodes(), spec));
  const fenceHash = await snapshotFingerprint(42, "T", withFence, childFetch(child));
  assert.equal(fenceHash.dependency_closure_sha256, specHash.dependency_closure_sha256);
  const drifted = await snapshotFingerprint(
    42,
    "T",
    withFence,
    childFetch({ title: "Child seven", body: "leaf changed" }),
  );
  assert.ok(
    fingerprintStaleReasons(specHash, drifted).includes("dependency_closure_sha256"),
  );
});

test("grill: handoff materialize does not rewrite dependency_closure_sha256", async () => {
  const spec = "## Summary\nDepends on #7.\n";
  const child = { title: "Child seven", body: "leaf seven" };
  const walk = await walkDeclaredDependencyClosure(42, "T", spec, { fetchIssue: childFetch(child) });
  const fp = buildGrillFingerprint({
    title: "T",
    appliedBody: spec,
    dependencyClosure: walk.record,
    integrationBaseSha: INTEGRATION_BASE,
    contextMd: CONTEXT_MD,
    providerConfig: PROVIDER,
    planningTreatment: TREATMENT,
  });
  const nodes = canonicalThinIssueNodes();
  const art: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes,
    fingerprint: fp,
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
  const body = embedDecisionsInBody(spec, art);
  const signed = parseDecisionsFromBody(body);
  assert.equal(signed.ok, true);
  if (!signed.ok) return;
  const signedHash = signed.artifact.fingerprint.dependency_closure_sha256;
  const input = grillAuthorityCreateInputs({
    domain: "d",
    repo: "acme/r",
    issueNumber: 42,
    artifact: art,
    proposedBody: body,
    frontierFp: "fp",
  })[0]!;
  const created = canCreateHandoff(input);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const patched = materializeGrillNode({
    liveBody: body,
    handoff: created.handoff,
    answerText: "yes",
  });
  assert.equal(patched.ok, true, patched.ok ? "" : patched.reason);
  if (!patched.ok) return;
  const after = parseDecisionsFromBody(patched.body);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.artifact.fingerprint.dependency_closure_sha256, signedHash);
  const node = after.artifact.nodes.find(
    (n) => n.id === parseGrillDeclaration(created.handoff.declaration_identity ?? "")?.nodeId,
  );
  assert.equal(node?.resolution, "resolved");
  assert.equal(node?.provenance.settled_by, "handoff");
});

test("grill: preview apply handoff ready sequence keeps dependency-closure hash", async () => {
  const specWithDep = `${THIN_SPEC}\n\nDepends on #7.\n`;
  const child = { title: "Child seven", body: "leaf seven" };
  const keyDeps = memoryKeyDeps();
  const store = memoryHandoffStore();
  const live = { title: "Thin issue", body: "needs work" };
  const preview = previewDeps({
    getIssue: async () => ({ title: live.title, body: live.body }),
    fetchDependencyIssue: childFetch(child),
    implementerJson: implementerPayload(specWithDep),
    keyDeps,
  });
  await withExit(async () => {
    await runRefineSpecIssuePreview(42, preview);
    assert.equal(process.exitCode, 0);
  });
  const env = JSON.parse(
    preview.writes.find((w) => w.startsWith("stdout:"))!.slice("stdout:".length),
  ) as GrillProposalEnvelope;
  const signedHash = env.proposal.artifact.fingerprint.dependency_closure_sha256;
  const proposedWalk = await walkDeclaredDependencyClosure(42, live.title, specWithDep, {
    fetchIssue: childFetch(child),
  });
  assert.equal(signedHash, hashDependencyClosure(proposedWalk.record));

  await withExit(async () => {
    const deps = applyDeps(env, {
      keyDeps,
      handoffStore: store,
      fetchDependencyIssue: childFetch(child),
    });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 0);
    assert.equal(deps.bodies.length, 1);
    live.body = deps.bodies[0]!;
  });
  const postApply = parseDecisionsFromBody(live.body);
  assert.equal(postApply.ok, true);
  if (!postApply.ok) return;
  assert.equal(postApply.artifact.fingerprint.dependency_closure_sha256, signedHash);
  assert.match(live.body, /pipeline-decisions-v1/);
  assert.match(live.body, /## Decisions/);

  const pending = await listHandoffs("/tmp/repo", { issue: 42, status: "pending" }, store);
  assert.ok(pending.length >= 1);
  for (const seed of pending) {
    const loaded = await loadHandoff("/tmp/repo", 42, seed.handoff_id, store);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const answered = await answerAndPersistHandoff(
      "/tmp/repo",
      42,
      loaded.handoff.handoff_id,
      {
        decision: "answer",
        actor: "alice",
        identitySource: "gh",
        authenticated: true,
        answerText: "yes",
      },
      store,
      {
        materialize: async (handoff, text) => {
          const r = await materializeGrillAnswer(handoff, text, {
            getIssueBody: async () => live.body,
            updateIssueBody: async (_n, next) => {
              live.body = next;
            },
            repoDir: "/tmp/repo",
            handoffStore: store,
            keyDeps,
            frontierKey: "test-key",
            now: () => new Date("2026-01-01T00:00:01Z"),
          });
          return r.ok ? { ok: true as const, wrote: r.wrote } : r;
        },
      },
    );
    assert.equal(answered.ok, true, answered.ok ? "" : answered.reason);
  }
  const postHandoff = parseDecisionsFromBody(live.body);
  assert.equal(postHandoff.ok, true);
  if (!postHandoff.ok) return;
  assert.equal(postHandoff.artifact.fingerprint.dependency_closure_sha256, signedHash);
  assert.ok(postHandoff.artifact.nodes.every((n) => n.provenance.settled_by === "handoff"));

  const recomputed = await snapshotFingerprint(42, live.title, live.body, childFetch(child));
  assert.equal(recomputed.dependency_closure_sha256, signedHash);
  const oldStyle = hashDependencyClosure({
    ids: [42, 7],
    per_id: [
      {
        id: 42,
        title_sha256: sha256Prefixed(live.title),
        body_sha256: sha256Prefixed(live.body),
      },
      {
        id: 7,
        title_sha256: sha256Prefixed(child.title),
        body_sha256: sha256Prefixed(child.body),
      },
    ],
    fact_codes: [],
  });
  assert.notEqual(oldStyle, signedHash);

  const listed = await listHandoffs("/tmp/repo", { issue: 42 }, store);
  const frontier = loadVerifiedGrillFrontier("/tmp/repo", 42, "test-key", env.repo, keyDeps);
  let labels = ["pipeline:backlog"];
  const add: string[] = [];
  const remove: string[] = [];
  const deps: TriageDeps = {
    getIssueLabels: async () => [...labels],
    addLabel: async (_n, l) => {
      add.push(l);
      if (!labels.includes(l)) labels.push(l);
    },
    removeLabel: async (_n, l) => {
      remove.push(l);
      labels = labels.filter((x) => x !== l);
    },
    log: () => {},
    getReadySnapshot: async () => ({
      title: live.title,
      body: live.body,
      comments: [],
      fingerprint: recomputed,
      contextMd: CONTEXT_MD,
      integrationBaseSha: INTEGRATION_BASE,
      handoffs: listed,
      frontier,
    }),
  };
  await runTriage({ issueArg: "42", stage: "ready" }, deps);
  assert.deepEqual(add, ["pipeline:ready"]);
  assert.ok(remove.includes("pipeline:backlog"));
});

test("grill: root-inclusive pre-change artifact recovers via preview apply without new authority", async () => {
  const specWithDep = `${THIN_SPEC}\n\nDepends on #7.\n`;
  const preProposal = "needs work\n\nDepends on #7.\n";
  const child = { title: "Child seven", body: "leaf seven" };
  const title = "Thin issue";
  const keyDeps = memoryKeyDeps();
  const store = memoryHandoffStore();
  const exclusiveWalk = await walkDeclaredDependencyClosure(42, title, specWithDep, {
    fetchIssue: childFetch(child),
  });
  const exclusiveFp = await snapshotFingerprint(42, title, specWithDep, childFetch(child));
  assert.notEqual(preProposal, specWithDep);
  assert.notEqual(preProposal, extractSpecCore(specWithDep));
  const rootInclusiveHash = hashDependencyClosure({
    ids: [42, ...exclusiveWalk.record.ids],
    per_id: [
      {
        id: 42,
        title_sha256: sha256Prefixed(title),
        body_sha256: sha256Prefixed(preProposal),
      },
      ...exclusiveWalk.record.per_id,
    ],
    fact_codes: exclusiveWalk.record.fact_codes,
  });
  const appliedCoreLegacy = hashDependencyClosure({
    ids: [42, ...exclusiveWalk.record.ids],
    per_id: [
      {
        id: 42,
        title_sha256: sha256Prefixed(title),
        body_sha256: sha256Prefixed(extractSpecCore(specWithDep)),
      },
      ...exclusiveWalk.record.per_id,
    ],
    fact_codes: exclusiveWalk.record.fact_codes,
  });
  assert.notEqual(rootInclusiveHash, exclusiveFp.dependency_closure_sha256);
  assert.notEqual(rootInclusiveHash, appliedCoreLegacy);
  const nodes = settledOperatorNodes();
  const art: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes,
    fingerprint: { ...exclusiveFp, dependency_closure_sha256: rootInclusiveHash },
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
  const live = { title, body: embedDecisionsInBody(specWithDep, art) };
  for (const n of nodes) {
    await saveHandoff("/tmp/repo", handoffForNode(n), store);
  }
  persistGrillFrontier(
    "/tmp/repo",
    issueGrillFrontier({
      repo: "acme/repo",
      issue: 42,
      body: live.body,
      artifact: art,
      now: new Date("2026-01-01T00:00:00Z"),
      key: "test-key",
    }),
    keyDeps,
  );
  const answeredBefore = (await listHandoffs("/tmp/repo", { issue: 42 }, store)).filter(
    (h) => h.status === "answered",
  );
  assert.equal(answeredBefore.length, nodes.length);

  const liveExclusive = await snapshotFingerprint(42, live.title, live.body, childFetch(child));
  let labels = ["pipeline:backlog"];
  const add: string[] = [];
  const remove: string[] = [];
  const readyDeps = (body: string, fp: GrillFingerprint): TriageDeps => ({
    getIssueLabels: async () => [...labels],
    addLabel: async (_n, l) => {
      add.push(l);
      if (!labels.includes(l)) labels.push(l);
    },
    removeLabel: async (_n, l) => {
      remove.push(l);
      labels = labels.filter((x) => x !== l);
    },
    log: () => {},
    getReadySnapshot: async () => ({
      title: live.title,
      body,
      comments: [],
      fingerprint: fp,
      contextMd: CONTEXT_MD,
      integrationBaseSha: INTEGRATION_BASE,
      handoffs: await listHandoffs("/tmp/repo", { issue: 42 }, store),
      frontier: loadVerifiedGrillFrontier("/tmp/repo", 42, "test-key", "acme/repo", keyDeps),
    }),
  });
  await assert.rejects(
    () => runTriage({ issueArg: "42", stage: "ready" }, readyDeps(live.body, liveExclusive)),
    (err: Error) => {
      assert.equal(err instanceof TriageReadyError, true);
      assert.equal((err as TriageReadyError).exitCode, 2);
      assert.match(err.message, /stale fingerprints: dependency_closure_sha256/);
      return true;
    },
  );
  assert.deepEqual(add, []);

  const preview = previewDeps({
    getIssue: async () => ({ title: live.title, body: live.body }),
    fetchDependencyIssue: childFetch(child),
    listIssueBodyRevisions: async () => [preProposal],
    keyDeps,
  });
  await withExit(async () => {
    await runRefineSpecIssuePreview(42, preview);
    assert.equal(process.exitCode, 0);
  });
  assert.equal(preview.implementerPrompts.length, 0, "refresh must not re-grill");
  assert.equal(preview.reviewerPrompts.length, 0, "refresh must not re-review");
  const env = JSON.parse(
    preview.writes.find((w) => w.startsWith("stdout:"))!.slice("stdout:".length),
  ) as GrillProposalEnvelope;
  assert.equal(
    env.proposal.artifact.fingerprint.dependency_closure_sha256,
    exclusiveFp.dependency_closure_sha256,
  );
  assert.deepEqual(
    env.proposal.artifact.nodes.map((n) => n.provenance.reference),
    nodes.map((n) => n.provenance.reference),
  );

  await withExit(async () => {
    const deps = applyDeps(env, {
      keyDeps,
      handoffStore: store,
      fetchDependencyIssue: childFetch(child),
    });
    await runRefineSpecApply(42, {}, deps);
    assert.equal(process.exitCode, 0);
    assert.equal(deps.bodies.length, 1);
    live.body = deps.bodies[0]!;
  });
  const post = parseDecisionsFromBody(live.body);
  assert.equal(post.ok, true);
  if (!post.ok) return;
  assert.equal(post.artifact.fingerprint.dependency_closure_sha256, exclusiveFp.dependency_closure_sha256);
  assert.ok(post.artifact.nodes.every((n) => n.provenance.settled_by === "handoff"));
  const listedAfter = await listHandoffs("/tmp/repo", { issue: 42 }, store);
  assert.equal(
    listedAfter.filter((h) => h.status === "answered").length,
    answeredBefore.length,
  );
  assert.equal(
    listedAfter.some((h) => h.status === "pending"),
    false,
  );

  add.length = 0;
  remove.length = 0;
  const recovered = await snapshotFingerprint(42, live.title, live.body, childFetch(child));
  await runTriage({ issueArg: "42", stage: "ready" }, readyDeps(live.body, recovered));
  assert.deepEqual(add, ["pipeline:ready"]);
});

test("grill: root-inclusive recovery fail-closes without a historical pre-proposal snapshot", async () => {
  const specWithDep = `${THIN_SPEC}\n\nDepends on #7.\n`;
  const preProposal = "needs work\n\nDepends on #7.\n";
  const child = { title: "Child seven", body: "leaf seven" };
  const title = "Thin issue";
  const exclusiveWalk = await walkDeclaredDependencyClosure(42, title, specWithDep, {
    fetchIssue: childFetch(child),
  });
  const exclusiveFp = await snapshotFingerprint(42, title, specWithDep, childFetch(child));
  const rootInclusiveHash = hashDependencyClosure({
    ids: [42, ...exclusiveWalk.record.ids],
    per_id: [
      {
        id: 42,
        title_sha256: sha256Prefixed(title),
        body_sha256: sha256Prefixed(preProposal),
      },
      ...exclusiveWalk.record.per_id,
    ],
    fact_codes: exclusiveWalk.record.fact_codes,
  });
  const art: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes: settledOperatorNodes(),
    fingerprint: { ...exclusiveFp, dependency_closure_sha256: rootInclusiveHash },
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
  const live = { title, body: embedDecisionsInBody(specWithDep, art) };
  const preview = previewDeps({
    getIssue: async () => ({ title: live.title, body: live.body }),
    fetchDependencyIssue: childFetch(child),
    implementerJson: implementerPayload(specWithDep),
  });
  await withExit(async () => {
    await runRefineSpecIssuePreview(42, preview);
    assert.equal(process.exitCode, 0);
  });
  assert.equal(preview.implementerPrompts.length, 1, "missing snapshot must re-grill");
  assert.equal(preview.reviewerPrompts.length, 1, "missing snapshot must re-review");
});

test("grill: applied specification core is not the historical signed snapshot", async () => {
  const specWithDep = `${THIN_SPEC}\n\nDepends on #7.\n`;
  const preProposal = "needs work\n\nDepends on #7.\n";
  const child = { title: "Child seven", body: "leaf seven" };
  const title = "Thin issue";
  const exclusiveWalk = await walkDeclaredDependencyClosure(42, title, specWithDep, {
    fetchIssue: childFetch(child),
  });
  const exclusiveFp = await snapshotFingerprint(42, title, specWithDep, childFetch(child));
  const rootInclusiveHash = hashDependencyClosure({
    ids: [42, ...exclusiveWalk.record.ids],
    per_id: [
      {
        id: 42,
        title_sha256: sha256Prefixed(title),
        body_sha256: sha256Prefixed(preProposal),
      },
      ...exclusiveWalk.record.per_id,
    ],
    fact_codes: exclusiveWalk.record.fact_codes,
  });
  const art: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes: settledOperatorNodes(),
    fingerprint: { ...exclusiveFp, dependency_closure_sha256: rootInclusiveHash },
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
  const live = { title, body: embedDecisionsInBody(specWithDep, art) };
  const preview = previewDeps({
    getIssue: async () => ({ title: live.title, body: live.body }),
    fetchDependencyIssue: childFetch(child),
    listIssueBodyRevisions: async () => [extractSpecCore(live.body)],
    implementerJson: implementerPayload(specWithDep),
  });
  await withExit(async () => {
    await runRefineSpecIssuePreview(42, preview);
    assert.equal(process.exitCode, 0);
  });
  assert.equal(preview.implementerPrompts.length, 1, "applied spec core must not authenticate the signed pre-proposal hash");
  assert.equal(preview.reviewerPrompts.length, 1);
});

test("grill: child mutation with closure-only stale does not take the root-inclusive refresh shortcut", async () => {
  const specWithDep = `${THIN_SPEC}\n\nDepends on #7.\n`;
  const child = { title: "Child seven", body: "leaf seven" };
  const title = "Thin issue";
  const exclusiveFp = await snapshotFingerprint(42, title, specWithDep, childFetch(child));
  const nodes = settledOperatorNodes();
  const art: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes,
    fingerprint: exclusiveFp,
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
  const live = { title, body: embedDecisionsInBody(specWithDep, art) };
  const mutated = { title: child.title, body: "leaf mutated" };
  const liveExclusive = await snapshotFingerprint(42, live.title, live.body, childFetch(mutated));
  assert.deepEqual(fingerprintStaleReasons(exclusiveFp, liveExclusive), ["dependency_closure_sha256"]);

  const preview = previewDeps({
    getIssue: async () => ({ title: live.title, body: live.body }),
    fetchDependencyIssue: childFetch(mutated),
    listIssueBodyRevisions: async () => [specWithDep],
    implementerJson: implementerPayload(specWithDep),
  });
  await withExit(async () => {
    await runRefineSpecIssuePreview(42, preview);
    assert.equal(process.exitCode, 0);
  });
  assert.equal(preview.implementerPrompts.length, 1, "real dependency change must re-grill");
  assert.equal(preview.reviewerPrompts.length, 1, "real dependency change must re-review");
  const env = JSON.parse(
    preview.writes.find((w) => w.startsWith("stdout:"))!.slice("stdout:".length),
  ) as GrillProposalEnvelope;
  assert.equal(
    env.proposal.artifact.fingerprint.dependency_closure_sha256,
    liveExclusive.dependency_closure_sha256,
  );
});

test("grill: later dependency change stales closure; root title and spec-core stale their own fingerprints", async () => {
  const specWithDep = `${THIN_SPEC}\n\nDepends on #7.\n`;
  const child = { title: "Child seven", body: "leaf seven" };
  const title = "Thin issue";
  const recordedFp = await snapshotFingerprint(42, title, specWithDep, childFetch(child));
  const art: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes: settledOperatorNodes(),
    fingerprint: recordedFp,
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
  const body = embedDecisionsInBody(specWithDep, art);
  const liveFp = await snapshotFingerprint(42, title, body, childFetch(child));
  assert.equal(liveFp.dependency_closure_sha256, recordedFp.dependency_closure_sha256);
  assert.equal(liveFp.applied_body_sha256, recordedFp.applied_body_sha256);

  const childChanged = await snapshotFingerprint(
    42,
    title,
    body,
    childFetch({ title: child.title, body: "leaf mutated" }),
  );
  assert.deepEqual(fingerprintStaleReasons(recordedFp, childChanged), ["dependency_closure_sha256"]);

  const titleChanged = await snapshotFingerprint(42, "Thin issue retitled", body, childFetch(child));
  assert.ok(fingerprintStaleReasons(recordedFp, titleChanged).includes("title_sha256"));
  assert.equal(
    fingerprintStaleReasons(recordedFp, titleChanged).includes("dependency_closure_sha256"),
    false,
  );

  const newSpec = `${extractSpecCore(body)}\nMore specification core.\n`;
  const coreChangedBody = embedDecisionsInBody(newSpec, art);
  const coreChanged = await snapshotFingerprint(42, title, coreChangedBody, childFetch(child));
  assert.ok(fingerprintStaleReasons(recordedFp, coreChanged).includes("applied_body_sha256"));

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
      title,
      body,
      comments: [],
      fingerprint: childChanged,
      contextMd: CONTEXT_MD,
      integrationBaseSha: INTEGRATION_BASE,
      handoffs: art.nodes
        .filter((n) => n.provenance.settled_by === "handoff")
        .map((n) => handoffForNode(n)),
      frontier: frontierFor(body, art),
    }),
  };
  await assert.rejects(() => runTriage({ issueArg: "42", stage: "ready" }, deps), (err: Error) => {
    assert.equal(err instanceof TriageReadyError, true);
    assert.equal((err as TriageReadyError).exitCode, 2);
    assert.match(err.message, /stale fingerprints: dependency_closure_sha256/);
    return true;
  });
  assert.deepEqual(add, []);
  assert.deepEqual(remove, []);
});

test("grill: fail-closed dependency facts still block ready with no label write", async () => {
  for (const code of DEPENDENCY_FACT_CODES) {
    const spec = "## Summary\nX\n";
    const nodes = settledOperatorNodes();
    const fact: TypedUnresolvedFact = {
      code,
      issue_ids: [99],
      edges: [],
      message: `${code} fixture`,
    };
    const art = artifact(nodes, spec);
    art.unresolved_facts = [fact];
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
      getReadySnapshot: async () => completeReadySnapshot(body),
    };
    await assert.rejects(() => runTriage({ issueArg: "42", stage: "ready" }, deps), (err: Error) => {
      assert.equal(err instanceof TriageReadyError, true);
      assert.equal((err as TriageReadyError).exitCode, 2);
      return true;
    });
    assert.deepEqual(add, []);
    assert.deepEqual(remove, []);
  }
});
