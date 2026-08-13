// Unit tests for durable human-question handoffs (#647).
// Injectable fs only — no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_CLASSES,
  HANDOFF_ESCALATION_SITES,
  HANDOFF_SCHEMA_VERSION,
  applyHandoffAnswer,
  authorizeHandoffAnswer,
  canCreateHandoff,
  createAndPersistHandoff,
  createInputFromHumanDecisionDeclaration,
  declarationIdentityKey,
  defaultAuthorityModeForClass,
  formatHandoffListHuman,
  formatHandoffShowHuman,
  formatStatusHandoffSection,
  handoffDiscoveryCommentBody,
  handoffEvidenceFromAudit,
  listHandoffs,
  loadHandoff,
  parseHumanQuestionHandoff,
  prepareAuthorityParkCreate,
  projectWaitingHuman,
  resolveHandoffEligibility,
  supersedeAndPersistHandoff,
  supersedeHandoff,
  validateHandoffResume,
  type CreateHandoffInput,
  type HandoffStoreDeps,
  type HumanQuestionHandoff,
} from "../scripts/human-question-handoff.ts";
import { COMMAND_REGISTRY, lookupCommand, validateFlags } from "../scripts/command-registry.ts";
import { ESCALATION_INVENTORY } from "../scripts/escalation-dispositions.ts";
import { buildBatchSummary } from "../scripts/stages/queue.ts";
import { buildStatusPayload } from "../scripts/status-json.ts";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

function memStore(): HandoffStoreDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    appendFile: async (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
    },
    mkdir: async (p) => {
      dirs.add(p);
    },
    readdir: async (p) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name) names.add(name);
        }
      }
      // Also surface issue-* dirs created only via mkdir if needed — keys drive listing.
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name) names.add(name);
        }
      }
      if (names.size === 0 && ![...files.keys()].some((k) => k.startsWith(p))) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return [...names];
    },
    rename: async (from, to) => {
      const v = files.get(from);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, v);
      files.delete(from);
    },
  };
}

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function baseNonAuthority(over: Partial<CreateHandoffInput> = {}): CreateHandoffInput {
  return {
    domain: "test",
    repo: "acme/repo",
    issue_number: 647,
    blocked_stage: "needs-human",
    question: "What is the intended product behavior for edge case X?",
    reason: "missing context from the issue",
    handoff_class: "missing_context",
    authority_mode: "non_authority",
    required_capability: ["domain:product"],
    candidate_sha: SHA,
    tip_present: true,
    resume_target: "implementing",
    resolution_evidence: {
      unresolved: false,
      eligible_actors: ["alice"],
      resolution_summary: "alice",
    },
    ...over,
  };
}

function baseAuthority(over: Partial<CreateHandoffInput> = {}): CreateHandoffInput {
  return {
    domain: "test",
    repo: "acme/repo",
    issue_number: 647,
    blocked_stage: "fix-1",
    question: "Should we keep the public API or break it?",
    reason: "product judgment required",
    handoff_class: "product_judgment",
    authority_mode: "authority",
    required_capability: ["authority"],
    candidate_sha: SHA,
    tip_present: true,
    human_decision_required: {
      finding_key: "abcd1234",
      finding_fingerprint: "0123456789abcdef",
      reviewed_sha: SHA,
      category: "product-decision",
    },
    resolution_evidence: {
      unresolved: false,
      eligible_actors: ["alice"],
      resolution_summary: "alice authorized",
    },
    resume_target: "override-or-unblock",
    declaration_identity: declarationIdentityKey("abcd1234", "0123456789abcdef", SHA),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Schema / classes
// ---------------------------------------------------------------------------

test("complete v1 record validates", () => {
  const created = canCreateHandoff(baseNonAuthority());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const parsed = parseHumanQuestionHandoff(created.handoff);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.handoff.schema_version, HANDOFF_SCHEMA_VERSION);
  assert.equal(parsed.handoff.status, "pending");
});

test("empty question fails validation", () => {
  const created = canCreateHandoff(baseNonAuthority({ question: "   " }));
  assert.equal(created.ok, false);
  if (created.ok) return;
  assert.equal(created.code, "empty_question");
});

test("unknown schema_version fails closed for resume", async () => {
  const created = canCreateHandoff(baseNonAuthority());
  assert.ok(created.ok);
  if (!created.ok) return;
  const raw = { ...created.handoff, schema_version: 99, status: "answered", answer: {
    decision: "answer",
    responder: "alice",
    identity_source: "gh",
    answer_text: "yes",
    answered_at: "2026-01-01T00:00:00Z",
    payload_hash: "x",
  } };
  const resume = await validateHandoffResume(raw, { candidate_sha: SHA });
  assert.equal(resume.ok, false);
  if (resume.ok) return;
  assert.equal(resume.code, "unsupported_schema");
  assert.equal(resume.advances_item, false);
});

test("unknown class rejected; authority/non-authority class matrix", () => {
  const bad = canCreateHandoff(
    baseNonAuthority({ handoff_class: "not-a-class" as "missing_context" }),
  );
  assert.equal(bad.ok, false);

  for (const cls of HANDOFF_CLASSES) {
    const mode = defaultAuthorityModeForClass(cls);
    if (mode === "authority") {
      const r = canCreateHandoff(
        baseAuthority({
          handoff_class: cls,
          authority_mode: "authority",
          human_decision_required: {
            finding_key: "abcd1234",
            finding_fingerprint: "0123456789abcdef",
            reviewed_sha: SHA,
          },
        }),
      );
      assert.equal(r.ok, true, `authority class ${cls} should create with HDR`);
    } else {
      const r = canCreateHandoff(
        baseNonAuthority({ handoff_class: cls, authority_mode: "non_authority" }),
      );
      assert.equal(r.ok, true, `non-authority class ${cls} should create`);
      if (cls === "unknown" && r.ok) {
        assert.equal(r.handoff.authority_mode, "non_authority");
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Create eligibility / authority gate
// ---------------------------------------------------------------------------

test("authority create with human-decision-required succeeds", () => {
  const r = canCreateHandoff(baseAuthority());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.handoff.authority_mode, "authority");
  assert.ok(r.handoff.human_decision_required);
});

test("authority create without diagnostic fails", () => {
  const r = canCreateHandoff(
    baseAuthority({ human_decision_required: null, policy_bound_authority_gate: false }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "authority_evidence_required");
});

test("engine exhaustion without decision is manual_repair non_authority", () => {
  const r = canCreateHandoff(
    baseAuthority({
      engine_exhaustion_without_decision: true,
      question: "Please repair the worktree manually",
      handoff_class: "product_judgment", // attempted masquerade
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.handoff.handoff_class, "manual_repair");
  assert.equal(r.handoff.authority_mode, "non_authority");
});

test("missing candidate_sha fails when tip present", () => {
  const r = canCreateHandoff(baseNonAuthority({ candidate_sha: null, tip_present: true }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "missing_candidate_sha");
});

// ---------------------------------------------------------------------------
// 3. Store + audit
// ---------------------------------------------------------------------------

test("round-trip store, list filters, audit append, no rewrite of prior answer", async () => {
  const deps = memStore();
  const repo = "/tmp/fake-repo-hqh";
  const a = await createAndPersistHandoff(repo, baseNonAuthority({ issue_number: 1 }), deps);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const b = await createAndPersistHandoff(
    repo,
    baseNonAuthority({ issue_number: 2, question: "Other issue question?" }),
    deps,
  );
  assert.equal(b.ok, true);
  if (!b.ok) return;

  const listed = await listHandoffs(repo, { issue: 1 }, deps);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.issue_number, 1);

  const loaded = await loadHandoff(repo, 1, a.handoff.handoff_id, deps);
  assert.equal(loaded.ok, true);

  // Answer then refuse rewrite of body.
  const ans1 = await applyHandoffAnswer({
    handoff: a.handoff,
    decision: "answer",
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
    answerText: "first answer",
  });
  assert.equal(ans1.ok, true);
  if (!ans1.ok) return;
  const ans2 = await applyHandoffAnswer({
    handoff: ans1.handoff,
    decision: "answer",
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
    answerText: "different body",
  });
  assert.equal(ans2.ok, false);
  if (ans2.ok) return;
  assert.equal(ans2.code, "already_answered");
  assert.equal(ans1.handoff.answer?.answer_text, "first answer");
});

// ---------------------------------------------------------------------------
// 4. Eligibility + authorization
// ---------------------------------------------------------------------------

test("eligible answer; unauthorized refuse; unidentified refuse; non-authority not approval", async () => {
  const created = canCreateHandoff(baseAuthority());
  assert.ok(created.ok);
  if (!created.ok) return;

  const ok = await authorizeHandoffAnswer({
    handoff: created.handoff,
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.grants_approval, false);
  assert.equal(ok.grants_attestation, false);
  assert.equal(ok.grants_finding_override, false);

  const unauth = await authorizeHandoffAnswer({
    handoff: created.handoff,
    actor: "bob",
    identitySource: "gh",
    authenticated: true,
  });
  assert.equal(unauth.ok, false);

  const unident = await authorizeHandoffAnswer({
    handoff: created.handoff,
    actor: null,
    identitySource: null,
    authenticated: false,
  });
  assert.equal(unident.ok, false);

  const ctx = canCreateHandoff(baseNonAuthority());
  assert.ok(ctx.ok);
  if (!ctx.ok) return;
  const ctxAns = await authorizeHandoffAnswer({
    handoff: ctx.handoff,
    actor: "carol",
    identitySource: "gh",
    authenticated: true,
  });
  assert.equal(ctxAns.ok, true);
  assert.equal(ctxAns.grants_attestation, false);
  assert.equal(ctxAns.grants_finding_override, false);
});

test("unresolved authority routing fails closed (no invented assignee)", async () => {
  const created = canCreateHandoff(
    baseAuthority({
      resolution_evidence: {
        unresolved: false, // create allowed via park path
        eligible_actors: [],
        resolution_summary: "none",
      },
    }),
  );
  assert.ok(created.ok);
  if (!created.ok) return;
  // At answer time empty eligible + no rules → fail closed.
  const auth = await authorizeHandoffAnswer({
    handoff: created.handoff,
    actor: "anyone",
    identitySource: "gh",
    authenticated: true,
  });
  assert.equal(auth.ok, false);
  assert.match(auth.reason, /unresolved|unauthorized/i);

  const elig = await resolveHandoffEligibility({
    handoff: created.handoff,
  });
  // Without policy inputs on authority → unresolved.
  assert.equal(elig.unresolved, true);
  assert.equal(elig.eligible_actors.length, 0);
});

// ---------------------------------------------------------------------------
// 5. Answer / reject / supersede idempotency
// ---------------------------------------------------------------------------

test("duplicate answer is idempotent; reject no advance; supersede blocks old resume", async () => {
  const created = canCreateHandoff(baseAuthority());
  assert.ok(created.ok);
  if (!created.ok) return;

  const a1 = await applyHandoffAnswer({
    handoff: created.handoff,
    decision: "answer",
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
    answerText: "keep the API",
    clientRequestId: "req-1",
  });
  assert.equal(a1.ok, true);
  if (!a1.ok) return;
  assert.equal(a1.duplicate, false);
  assert.equal(a1.advances_item, false);

  const a2 = await applyHandoffAnswer({
    handoff: a1.handoff,
    decision: "answer",
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
    answerText: "keep the API",
    clientRequestId: "req-1",
  });
  assert.equal(a2.ok, true);
  if (!a2.ok) return;
  assert.equal(a2.duplicate, true);
  assert.equal(a2.advances_item, false);

  const rejBase = canCreateHandoff(baseAuthority({ handoff_id: "hqh_reject1" }));
  assert.ok(rejBase.ok);
  if (!rejBase.ok) return;
  const rej = await applyHandoffAnswer({
    handoff: rejBase.handoff,
    decision: "reject",
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
    answerText: "rejected",
  });
  assert.equal(rej.ok, true);
  if (!rej.ok) return;
  assert.equal(rej.handoff.status, "rejected");
  assert.equal(rej.advances_item, false);

  const h1 = canCreateHandoff(baseNonAuthority({ handoff_id: "hqh_old" }));
  const h2 = canCreateHandoff(baseNonAuthority({ handoff_id: "hqh_new", question: "Updated question?" }));
  assert.ok(h1.ok && h2.ok);
  if (!h1.ok || !h2.ok) return;
  const sup = supersedeHandoff({ prior: h1.handoff, replacement: h2.handoff });
  assert.equal(sup.prior.status, "superseded");
  assert.equal(sup.prior.superseded_by, h2.handoff.handoff_id);

  // Answer old then resume must fail.
  const answeredOld = {
    ...sup.prior,
    status: "answered" as const,
    answer: {
      decision: "answer" as const,
      responder: "alice",
      identity_source: "gh",
      answer_text: "stale",
      answered_at: "2026-01-01T00:00:00Z",
      payload_hash: "p",
    },
  };
  const resume = await validateHandoffResume(answeredOld, { candidate_sha: SHA });
  assert.equal(resume.ok, false);
  if (resume.ok) return;
  assert.equal(resume.code, "superseded");
});

test("concurrent independent handoffs on different issues", async () => {
  const deps = memStore();
  const repo = "/tmp/fake-repo-concurrent";
  const r1 = await createAndPersistHandoff(repo, baseNonAuthority({ issue_number: 10 }), deps);
  const r2 = await createAndPersistHandoff(repo, baseNonAuthority({ issue_number: 11 }), deps);
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  const l1 = await listHandoffs(repo, { issue: 10 }, deps);
  const l2 = await listHandoffs(repo, { issue: 11 }, deps);
  assert.equal(l1.length, 1);
  assert.equal(l2.length, 1);
  assert.notEqual(l1[0]!.handoff_id, l2[0]!.handoff_id);
});

// ---------------------------------------------------------------------------
// 6. Resume revalidation
// ---------------------------------------------------------------------------

test("resume success, stale SHA, dossier/policy change, expired, ambiguous, malformed", async () => {
  const created = canCreateHandoff(
    baseAuthority({
      dossier_hash: "dos1",
      policy_hash: "pol1",
    }),
  );
  assert.ok(created.ok);
  if (!created.ok) return;
  const answered = await applyHandoffAnswer({
    handoff: created.handoff,
    decision: "answer",
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
    answerText: "keep API",
  });
  assert.ok(answered.ok);
  if (!answered.ok) return;

  const ok = await validateHandoffResume(answered.handoff, {
    candidate_sha: SHA,
    dossier_hash: "dos1",
    policy_hash: "pol1",
    known_stage_entries: ["override-or-unblock"],
    stage_preconditions_ok: true,
  });
  assert.equal(ok.ok, true);

  const stale = await validateHandoffResume(answered.handoff, {
    candidate_sha: SHA2,
    dossier_hash: "dos1",
    policy_hash: "pol1",
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "stale_sha");

  const dos = await validateHandoffResume(answered.handoff, {
    candidate_sha: SHA,
    dossier_hash: "dos-changed",
    policy_hash: "pol1",
  });
  assert.equal(dos.ok, false);
  if (!dos.ok) assert.equal(dos.code, "scope_hash_mismatch");

  const expired: HumanQuestionHandoff = {
    ...answered.handoff,
    expires_at: "2020-01-01T00:00:00Z",
  };
  const exp = await validateHandoffResume(expired, {
    candidate_sha: SHA,
    dossier_hash: "dos1",
    policy_hash: "pol1",
    now: "2026-01-01T00:00:00Z",
  });
  assert.equal(exp.ok, false);
  if (!exp.ok) assert.equal(exp.code, "expired");

  const amb = await validateHandoffResume(answered.handoff, {
    candidate_sha: SHA,
    dossier_hash: "dos1",
    policy_hash: "pol1",
    // Target "override-or-unblock" is not in this list → ambiguous / unmapped.
    known_stage_entries: ["review-1", "review-2"],
  });
  assert.equal(amb.ok, false);
  if (!amb.ok) assert.equal(amb.code, "ambiguous_resume_target");

  const mal = await validateHandoffResume(
    { schema_version: 1, handoff_id: "x" }, // missing required fields
    { candidate_sha: SHA },
  );
  assert.equal(mal.ok, false);
  if (!mal.ok) assert.equal(mal.code, "malformed");
});

// ---------------------------------------------------------------------------
// 7. Fix-stage create helpers (idempotent identity)
// ---------------------------------------------------------------------------

test("createInputFromHumanDecisionDeclaration + idempotent re-park", async () => {
  const deps = memStore();
  const repo = "/tmp/fake-repo-park";
  const input = prepareAuthorityParkCreate(
    createInputFromHumanDecisionDeclaration({
      domain: "test",
      repo: "acme/repo",
      issue_number: 99,
      blocked_stage: "fix-1",
      decl: {
        category: "product-decision",
        key: "abcd1234",
        fingerprint: "0123456789abcdef",
        reviewedSha: SHA,
        request: "Which API shape?",
      },
      eligible_actors: ["alice"],
    }),
  );
  const first = await createAndPersistHandoff(repo, input, deps);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.reused, false);
  assert.equal(first.handoff.authority_mode, "authority");

  const second = await createAndPersistHandoff(repo, input, deps);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.reused, true);
  assert.equal(second.handoff.handoff_id, first.handoff.handoff_id);
});

// ---------------------------------------------------------------------------
// 8. Command registry
// ---------------------------------------------------------------------------

test("command registry: handoff entry allowlists and non-merge", () => {
  const entry = COMMAND_REGISTRY.handoff;
  assert.ok(entry);
  assert.equal(entry.supportsJson, true);
  assert.notEqual(entry.allowedFlags, "all");
  if (entry.allowedFlags === "all") return;
  for (const f of ["json", "issue", "filterStatus", "text", "batch"]) {
    assert.ok(entry.allowedFlags.has(f), `missing flag ${f}`);
  }
  assert.equal(lookupCommand("handoff"), entry);
  // Unknown flag rejected.
  const bad = validateFlags(entry, {
    options: [{ attributeName: () => "merge", long: "--merge" }],
    getOptionValueSource: () => "cli",
  });
  assert.ok(bad.includes("merge"));
});

// ---------------------------------------------------------------------------
// 9. Status + queue projections
// ---------------------------------------------------------------------------

test("status payload includes handoffs when provided; absent otherwise", () => {
  const detail = {
    number: 647,
    title: "t",
    state: "open" as const,
    labels: ["pipeline:needs-human"],
    comments: [],
    url: "https://example.com",
  };
  const without = buildStatusPayload(detail, null, null, { repo: "a/b", domain: "d" });
  assert.equal(without.handoffs, undefined);

  const withH = buildStatusPayload(
    detail,
    null,
    null,
    { repo: "a/b", domain: "d" },
    null,
    new Date(),
    [
      {
        handoff_id: "hqh_1",
        status: "pending",
        handoff_class: "product_judgment",
        authority_mode: "authority",
      },
    ],
  );
  assert.equal(withH.handoffs?.length, 1);
});

test("batch summary exposes waiting_human_count without capacity failure inflation", () => {
  const results = [
    {
      issueNumber: 1,
      finalState: "needs-human",
      costUsd: 0.1,
      durationMs: 1000,
    },
    {
      issueNumber: 2,
      finalState: "ready-to-deploy",
      costUsd: 0.2,
      durationMs: 2000,
    },
    {
      issueNumber: 3,
      finalState: "ready-to-deploy",
      costUsd: 0.1,
      durationMs: 500,
    },
  ];
  const titles = new Map([
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ]);
  const summary = buildBatchSummary(
    results,
    titles,
    {
      batchId: "b1",
      maxIssues: 10,
      budgetDollars: null,
      concurrency: 2,
      maxFailureRate: 0.5,
      repoDir: "/tmp",
    },
    null,
    0,
    0,
    1000,
    { waiting_human_count: 2, waiting_human_oldest_age_seconds: 120 },
  );
  assert.equal(summary.aggregate.waiting_human_count, 2);
  assert.equal(summary.aggregate.waiting_human_oldest_age_seconds, 120);
  // needs-human counts as succeeded — not a capacity failure.
  assert.equal(summary.aggregate.failed, 0);
  assert.equal(summary.aggregate.failure_rate, 0);
});

test("projectWaitingHuman and format helpers", () => {
  const created = canCreateHandoff(baseNonAuthority());
  assert.ok(created.ok);
  if (!created.ok) return;
  const proj = projectWaitingHuman([created.handoff], created.handoff.created_at);
  assert.equal(proj.waiting_human_count, 1);
  assert.ok(formatHandoffListHuman([created.handoff]).includes(created.handoff.handoff_id));
  assert.ok(formatHandoffShowHuman(created.handoff).includes(created.handoff.question));
  assert.ok(formatStatusHandoffSection([created.handoff])?.includes("pending"));
  assert.ok(handoffDiscoveryCommentBody(created.handoff).includes(created.handoff.handoff_id));
});

// ---------------------------------------------------------------------------
// 10. Evidence + escalation inventory
// ---------------------------------------------------------------------------

test("handoff evidence record from audit; inventory handoff sites fail-closed", () => {
  const ev = handoffEvidenceFromAudit(
    {
      schema_version: 1,
      at: "2026-01-01T00:00:00Z",
      op: "resume_refused",
      handoff_id: "hqh_x",
      issue_number: 1,
      detail: "stale",
      evidence: { reason: "sha mismatch", ok: false },
    },
    {
      handoff_class: "product_judgment",
      authority_mode: "authority",
      status: "answered",
      scope: { candidate_sha: SHA },
    },
  );
  assert.equal(ev.op, "resume_refused");
  assert.equal(ev.resume_ok, false);

  const sites = ESCALATION_INVENTORY.handoff_sites ?? [];
  assert.ok(sites.length >= HANDOFF_ESCALATION_SITES.length);
  const unauth = sites.find((s) => s.site_id.includes("unauthorized-answer"));
  assert.ok(unauth);
  assert.equal(unauth!.disposition, "deliberately-fail-closed");
  const pending = sites.find((s) => s.site_id.includes("pending-wait"));
  assert.ok(pending);
  assert.notEqual(pending!.disposition, "transient-retryable");
});

test("missing handoff inventory row would be detectable (drift bite)", () => {
  const known = new Set((ESCALATION_INVENTORY.handoff_sites ?? []).map((s) => s.site_id));
  for (const s of HANDOFF_ESCALATION_SITES) {
    assert.ok(known.has(s.site_id), `missing inventory row for ${s.site_id}`);
  }
  // Simulated missing row fails the check.
  const fake = "human-question-handoff:brand-new-site";
  assert.equal(known.has(fake), false);
});

// ---------------------------------------------------------------------------
// 11. Pre-code attestation composition guard (non-authority answer ≠ approve)
// ---------------------------------------------------------------------------

test("non-authority context answer does not grant attestation or override", async () => {
  const created = canCreateHandoff(baseNonAuthority());
  assert.ok(created.ok);
  if (!created.ok) return;
  const ans = await applyHandoffAnswer({
    handoff: created.handoff,
    decision: "answer",
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
    answerText: "here is the missing context",
  });
  assert.ok(ans.ok);
  if (!ans.ok) return;
  // authorize path stamps grants_* false; answer path never upgrades.
  const auth = await authorizeHandoffAnswer({
    handoff: created.handoff,
    actor: "alice",
    identitySource: "gh",
    authenticated: true,
  });
  assert.equal(auth.grants_attestation, false);
  assert.equal(auth.grants_approval, false);
  assert.equal(auth.grants_finding_override, false);
  // Semantic guard: answered non_authority handoff is still non_authority.
  assert.equal(ans.handoff.authority_mode, "non_authority");
  assert.equal(ans.handoff.handoff_class, "missing_context");
});

// ---------------------------------------------------------------------------
// supersede persist path
// ---------------------------------------------------------------------------

test("supersedeAndPersistHandoff links ids", async () => {
  const deps = memStore();
  const repo = "/tmp/fake-repo-sup";
  const first = await createAndPersistHandoff(
    repo,
    baseNonAuthority({ handoff_id: "hqh_prior", issue_number: 5 }),
    deps,
  );
  assert.ok(first.ok);
  if (!first.ok) return;
  const sup = await supersedeAndPersistHandoff(
    repo,
    5,
    first.handoff.handoff_id,
    baseNonAuthority({ question: "New question after supersession?", issue_number: 5 }),
    deps,
  );
  assert.equal(sup.ok, true);
  if (!sup.ok) return;
  assert.equal(sup.prior.status, "superseded");
  assert.equal(sup.prior.superseded_by, sup.replacement.handoff_id);
  assert.equal(sup.replacement.supersedes, first.handoff.handoff_id);
});
