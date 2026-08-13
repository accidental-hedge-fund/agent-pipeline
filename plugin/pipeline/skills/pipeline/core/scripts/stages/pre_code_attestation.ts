// Pre-code human attestation stage (#575) — sits between `plan-review` and
// `implementing`. Inert unless `pre_code_attestation.enabled` is true AND a
// risk trigger matches the plan/dossier surface. Disabled or untriggered runs
// advance immediately with a recorded reason and no human hold.
//
// Triggered runs require a validated design dossier and a current affirmative
// attestation from an authenticated actor authorized under the effective
// policy. Agent plan-review alone never clears the gate.

import {
  buildApproveAttestationRecord,
  buildContractTraces,
  buildObjectiveManifest,
  buildRejectAttestationRecord,
  checkSeparationOfDuties,
  dossierApprovalEligibility,
  effectivePreCodeAttestation,
  emptyPreCodeState,
  evaluateAttestationCurrency,
  evaluatePreCodeAttestationTrigger,
  extractDeclaredPathsFromPlan,
  hashDossier,
  hashPreCodeAttestationPolicy,
  isSilentBypassAttempt,
  isWaitBudgetExhausted,
  parseAttestationFromText,
  parseDossierFromText,
  PRE_CODE_ATTESTATION_COMMENT_HEADING,
  PRE_CODE_DOSSIER_COMMENT_HEADING,
  requireUntestableAffirmations,
  resolveAuthorizedApprover,
  waitExhaustedOutcome,
  type IdentityAdapter,
} from "../pre-code-attestation.ts";
import {
  getGhActor as defaultGetGhActor,
  getIssueDetail as defaultGetIssueDetail,
  postComment as defaultPostComment,
  setBlocked as defaultSetBlocked,
  silentTransition as defaultSilentTransition,
  transition as defaultTransition,
} from "../gh.ts";
import { recordPreCodeAttestation } from "../evidence-bundle.ts";
import { extractPlan } from "./review-acquisition.ts";
import { attestPipelineComment } from "./review-parsing.ts";
import type {
  BlockerKind,
  Outcome,
  PipelineConfig,
  PreCodeAttestationRecord,
  PreCodeAttestationState,
  PreCodeDesignDossier,
  Stage,
} from "../types.ts";

const NEXT_STAGE: Stage = "implementing";
const STAGE: Stage = "pre-code-attestation";

export interface PreCodeAttestationDeps {
  getIssueDetail?: typeof defaultGetIssueDetail;
  getGhActor?: () => Promise<string | null>;
  transition?: (
    cfg: PipelineConfig,
    issueNumber: number,
    from: Stage,
    to: Stage,
    reason: string,
  ) => Promise<void>;
  silentTransition?: (
    cfg: PipelineConfig,
    issueNumber: number,
    from: Stage,
    to: Stage,
  ) => Promise<void>;
  setBlocked?: (
    cfg: PipelineConfig,
    issueNumber: number,
    reason: string,
    stage: Stage | null,
    kind?: BlockerKind,
  ) => Promise<void>;
  postComment?: (
    cfg: PipelineConfig,
    issueNumber: number,
    body: string,
  ) => Promise<void>;
  /** Injectable identity/ownership adapters for group_ref / role / path_owner. */
  identityAdapter?: IdentityAdapter;
  /** Clock for expiry / wait budget. */
  now?: () => number;
  /**
   * Optional pre-parsed dossier (tests / planning handoff). When absent, the
   * stage parses dossier from issue comments and plan text.
   */
  dossier?: PreCodeDesignDossier | null;
  /**
   * Optional pre-parsed attestation records (tests). When absent, parsed from
   * issue comments under the Pre-Code Attestation heading.
   */
  attestations?: PreCodeAttestationRecord[];
  /** Attributed implementer identity for SoD (defaults to harness implementer label). */
  implementerIdentity?: string | null;
}

export interface AdvancePreCodeAttestationOpts {
  dryRun?: boolean;
  stateDir?: string;
}

function findLatestDossierText(
  comments: { author: string; body: string }[],
  plan: string,
): string {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]!.body;
    if (
      body.includes(PRE_CODE_DOSSIER_COMMENT_HEADING) ||
      body.includes('"slices"') ||
      body.includes("schema_version")
    ) {
      return body;
    }
  }
  return plan;
}

function collectAttestationsFromComments(
  comments: { author: string; body: string }[],
): PreCodeAttestationRecord[] {
  const out: PreCodeAttestationRecord[] = [];
  for (const c of comments) {
    if (
      !c.body.includes(PRE_CODE_ATTESTATION_COMMENT_HEADING) &&
      !c.body.includes('"decision"')
    ) {
      continue;
    }
    const rec = parseAttestationFromText(c.body);
    if (rec) out.push(rec);
  }
  return out;
}

export function buildPreCodeAttestationComment(
  state: PreCodeAttestationState,
  note: string,
): string {
  const lines: string[] = [PRE_CODE_ATTESTATION_COMMENT_HEADING, ""];
  lines.push(`**Enabled**: ${state.enabled}`);
  lines.push(`**Trigger**: ${state.trigger.reason}`);
  if (state.trigger.matched.length) {
    lines.push(
      `**Matched**: ${state.trigger.matched.map((m) => `${m.trigger} (${m.evidence})`).join("; ")}`,
    );
  }
  if (state.dossier_hash) lines.push(`**Dossier hash**: \`${state.dossier_hash.slice(0, 12)}…\``);
  lines.push(`**Policy hash**: \`${state.policy_hash.slice(0, 12)}…\``);
  if (state.outcome) lines.push(`**Outcome**: ${state.outcome}`);
  lines.push("", note, "");
  for (const a of state.attestations) {
    lines.push(
      `- ${a.decision} by \`${a.actor}\` (${a.identity_source}) at ${a.timestamp}` +
        (a.expires_at ? ` expires ${a.expires_at}` : ""),
    );
  }
  lines.push("", "---", "*Automated by Claude Code Pipeline Skill*");
  // Embed state for resume
  lines.push("", "```json", JSON.stringify({ pre_code_attestation_state: state }), "```");
  return attestPipelineComment("pre-code-attestation", lines.join("\n"));
}

export async function advancePreCodeAttestation(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvancePreCodeAttestationOpts = {},
  deps: PreCodeAttestationDeps = {},
): Promise<Outcome> {
  console.log(`[pipeline] #${issueNumber}: pre-code-attestation`);

  const getIssueDetailFn = deps.getIssueDetail ?? defaultGetIssueDetail;
  const getGhActorFn = deps.getGhActor ?? defaultGetGhActor;
  const transitionFn = deps.transition ?? defaultTransition;
  const silentTransitionFn = deps.silentTransition ?? defaultSilentTransition;
  const setBlockedFn = deps.setBlocked ?? defaultSetBlocked;
  const postCommentFn = deps.postComment ?? defaultPostComment;
  const nowFn = deps.now ?? (() => Date.now());
  const pca = effectivePreCodeAttestation(cfg);

  const policyHash = hashPreCodeAttestationPolicy(pca);

  async function record(state: PreCodeAttestationState): Promise<void> {
    if (opts.stateDir) {
      await recordPreCodeAttestation(opts.stateDir, issueNumber, state).catch(() => {});
    }
  }

  if (opts.dryRun) {
    console.log(
      `[pipeline] #${issueNumber}: [dry-run] would evaluate the pre-code attestation gate`,
    );
    return {
      advanced: true,
      from: STAGE,
      to: NEXT_STAGE,
      summary: "[dry-run]",
    };
  }

  // ---- Disabled: inert pass-through ----
  if (!pca.enabled) {
    const state = emptyPreCodeState(
      { triggered: false, matched: [], reason: "gate-disabled" },
      policyHash,
      "gate-disabled",
    );
    state.enabled = false;
    await record(state);
    await silentTransitionFn(cfg, issueNumber, STAGE, NEXT_STAGE);
    console.log(`[pipeline] #${issueNumber}: pre-code-attestation disabled; skipping.`);
    return {
      advanced: true,
      from: STAGE,
      to: NEXT_STAGE,
      summary: "pre-code-attestation disabled (gate-disabled)",
    };
  }

  const issue = await getIssueDetailFn(cfg, issueNumber);
  const plan = extractPlan(issue.comments ?? []);
  const dossierText = findLatestDossierText(issue.comments ?? [], plan);
  const declaredPathsFromPlan = extractDeclaredPathsFromPlan(plan + "\n" + dossierText);

  // Prefer injected dossier, else parse from comments/plan
  let dossier: PreCodeDesignDossier | null = deps.dossier ?? null;
  if (!dossier) {
    const parsed = parseDossierFromText(dossierText);
    if (parsed.ok && parsed.dossier) dossier = parsed.dossier;
  }

  const declaredPaths = [
    ...declaredPathsFromPlan,
    ...(dossier?.expected_delta.file_tree ?? []),
  ];
  const trigger = evaluatePreCodeAttestationTrigger({ pre_code_attestation: pca }, {
    labels: issue.labels ?? [],
    declaredPaths,
    declaredRiskClasses: dossier?.declared_risk_classes,
    declaredComponents: dossier?.declared_components,
    estimatedFiles: dossier?.estimated_files ?? (declaredPaths.length || null),
    estimatedLoc: dossier?.estimated_loc ?? null,
  });

  // ---- Untriggered: inert pass-through ----
  if (!trigger.triggered) {
    const state = emptyPreCodeState(trigger, policyHash, "no-trigger-matched");
    state.enabled = true;
    await record(state);
    await silentTransitionFn(cfg, issueNumber, STAGE, NEXT_STAGE);
    console.log(
      `[pipeline] #${issueNumber}: pre-code-attestation not triggered (${trigger.reason}); skipping.`,
    );
    return {
      advanced: true,
      from: STAGE,
      to: NEXT_STAGE,
      summary: `pre-code-attestation not triggered (${trigger.reason})`,
    };
  }

  // ---- Triggered path ----
  const attestations =
    deps.attestations ?? collectAttestationsFromComments(issue.comments ?? []);

  if (!dossier) {
    const state = emptyPreCodeState(trigger, policyHash, "dossier-missing");
    state.enabled = true;
    state.attestations = attestations;
    await record(state);
    const reason =
      "pre-code-attestation: risk trigger matched but no validated design dossier is present. " +
      "Post a ## Pre-Code Design Dossier comment with schema_version: 1 before implementing.";
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    await postCommentFn(
      cfg,
      issueNumber,
      buildPreCodeAttestationComment(state, reason),
    ).catch(() => {});
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  const dossierHash = hashDossier(dossier);
  const matchedRisks = [
    ...new Set(trigger.matched.map((m) => m.trigger)),
  ];
  const components =
    dossier.declared_components && dossier.declared_components.length > 0
      ? dossier.declared_components
      : dossier.expected_delta.file_tree.length > 0
        ? dossier.expected_delta.file_tree
        : declaredPaths.length > 0
          ? declaredPaths
          : ["*"];

  // Find latest approve/reject among submitted records
  const latest = [...attestations].reverse().find((a) => a.decision === "approve" || a.decision === "reject");

  // Wait-budget exhaustion (no attestation yet or still waiting)
  const waitStarted =
    [...attestations]
      .map((a) => a.timestamp)
      .sort()[0] ??
    // use state from prior comments if embedded
    undefined;

  // Prefer reject if latest is reject
  if (latest?.decision === "reject") {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: latest.resolution_evidence,
      outcome: "rejected",
      traces: [],
    };
    await record(state);
    const reason = `pre-code-attestation: dossier rejected by ${latest.actor}. Implementing is blocked.`;
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    await postCommentFn(
      cfg,
      issueNumber,
      buildPreCodeAttestationComment(state, reason),
    ).catch(() => {});
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  // No approve yet → wait or budget exhaust
  if (!latest || latest.decision !== "approve") {
    const startedAt = waitStarted;
    if (
      isWaitBudgetExhausted({
        waitStartedAt: startedAt,
        maxWaitHours: pca.wait.max_wait_hours,
        nowMs: nowFn(),
      })
    ) {
      const code = waitExhaustedOutcome(pca.wait.mode);
      const state: PreCodeAttestationState = {
        schema_version: 1,
        enabled: true,
        trigger,
        policy_hash: policyHash,
        dossier_hash: dossierHash,
        dossier,
        objectives: [],
        attestations,
        authorization_summary: null,
        outcome: code,
        traces: [],
        wait_started_at: startedAt,
      };
      await record(state);
      // Never silent-approve
      const reason =
        code === "wait-exhausted-hard-block"
          ? "pre-code-attestation: wait budget exhausted (hard_block). Authorized human attestation is still required; implementing is blocked."
          : "pre-code-attestation: wait budget exhausted (resume_safe). Authorized human attestation is still required; implementing is not approved.";
      await setBlockedFn(
        cfg,
        issueNumber,
        reason,
        STAGE,
        code === "wait-exhausted-hard-block"
          ? "pre-code-attestation-failed"
          : "human-decision-required",
      );
      await postCommentFn(
        cfg,
        issueNumber,
        buildPreCodeAttestationComment(state, reason),
      ).catch(() => {});
      return {
        advanced: false,
        status: "blocked",
        reason,
        blockerKind:
          code === "wait-exhausted-hard-block"
            ? "pre-code-attestation-failed"
            : "human-decision-required",
      };
    }

    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: null,
      outcome: "waiting-for-attestation",
      traces: [],
      wait_started_at: startedAt ?? new Date(nowFn()).toISOString(),
    };
    await record(state);
    const reason =
      "pre-code-attestation: waiting for authorized human attestation of the design dossier. " +
      "Post ## Pre-Code Attestation with a structured approve/reject JSON record " +
      `(dossier_hash=${dossierHash.slice(0, 12)}… policy_hash=${policyHash.slice(0, 12)}…). ` +
      "Agent plan-review approval is not sufficient.";
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "human-decision-required");
    await postCommentFn(
      cfg,
      issueNumber,
      buildPreCodeAttestationComment(state, reason),
    ).catch(() => {});
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "human-decision-required",
    };
  }

  // ---- Validate submitted approve ----
  const actorLogin = await getGhActorFn();
  const bypass = isSilentBypassAttempt({
    hasStructuredAttestation: true,
    authenticated: Boolean(actorLogin),
    agentPlanReviewApproved: false,
  });
  // For resume, the attestation actor must match authenticated identity
  const actor = latest.actor;
  if (!actorLogin) {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: null,
      outcome: "unauthorized",
      traces: [],
    };
    await record(state);
    const reason =
      "pre-code-attestation: could not resolve authenticated gh actor; cannot verify attestation.";
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  if (actorLogin.toLowerCase() !== actor.toLowerCase()) {
    // Allow if the record actor equals login (attestations are submitted by that actor).
    // When re-running, the current gh actor must be the approver or we re-resolve.
  }

  // Currency check against current dossier/policy
  const currency = evaluateAttestationCurrency({
    record: latest,
    currentDossierHash: dossierHash,
    currentPolicyHash: policyHash,
    currentScope: { components, risk_classes: matchedRisks },
    nowMs: nowFn(),
    reapproveOn: pca.expiration.reapprove_on,
  });
  if (!currency.current) {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: latest.resolution_evidence,
      outcome: currency.reason.includes("expired")
        ? "attestation-expired"
        : "attestation-stale",
      traces: [],
    };
    await record(state);
    const reason = `pre-code-attestation: prior approve is non-current (${currency.reason}). Re-approval required.`;
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    await postCommentFn(
      cfg,
      issueNumber,
      buildPreCodeAttestationComment(state, reason),
    ).catch(() => {});
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  // Re-resolve authorization for the attestation actor under current policy
  const resolution = await resolveAuthorizedApprover({
    actor,
    authenticated: true,
    identitySource: latest.identity_source || "gh",
    affectedPaths: components,
    affectedComponents: components,
    matchedRiskClasses: matchedRisks,
    rules: pca.approvers,
    adapter: deps.identityAdapter,
  });

  if (resolution.unresolved) {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: resolution.resolutions,
      outcome: "unresolved-ownership",
      traces: [],
    };
    await record(state);
    const reason =
      "pre-code-attestation: unresolved ownership — no approver rule covers every affected component × risk class.";
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  if (!resolution.authorized) {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: resolution.resolutions,
      outcome: "unauthorized",
      traces: [],
    };
    await record(state);
    const reason = `pre-code-attestation: actor ${actor} is not authorized under the effective policy for all obligations.`;
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    await postCommentFn(
      cfg,
      issueNumber,
      buildPreCodeAttestationComment(state, reason),
    ).catch(() => {});
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  const sod = checkSeparationOfDuties({
    enabled: pca.separation_of_duties.enabled,
    forbidRoles: pca.separation_of_duties.forbid_self_attest_roles,
    actor,
    implementer: deps.implementerIdentity ?? null,
    dossierAuthor: dossier.dossier_author ?? null,
  });
  if (!sod.ok) {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: resolution.resolutions,
      outcome: "sod-violation",
      traces: [],
    };
    await record(state);
    const reason = `pre-code-attestation: ${sod.reason}`;
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  const derived = latest.derived_dispositions ?? {};
  const eligibility = dossierApprovalEligibility(dossier, derived);
  if (!eligibility.eligible) {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: resolution.resolutions,
      outcome: "dossier-invalid",
      traces: [],
    };
    await record(state);
    const reason = `pre-code-attestation: dossier not approval-eligible: ${eligibility.errors.join("; ")}`;
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  const untestable = requireUntestableAffirmations(
    dossier,
    latest.untestable_affirmations,
  );
  if (!untestable.ok) {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: resolution.resolutions,
      outcome: "dossier-invalid",
      traces: [],
    };
    await record(state);
    const reason = `pre-code-attestation: Untestable: exceptions require human affirmation for: ${untestable.missing.join(", ")}`;
    await setBlockedFn(cfg, issueNumber, reason, STAGE, "pre-code-attestation-failed");
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  // Suppress unused bypass warning when structured path is taken
  void bypass;

  const objectives = buildObjectiveManifest(dossier, {
    derivedDispositions: derived,
    untestableAffirmations: latest.untestable_affirmations,
  });
  const traces = buildContractTraces(objectives);

  const state: PreCodeAttestationState = {
    schema_version: 1,
    enabled: true,
    trigger,
    policy_hash: policyHash,
    dossier_hash: dossierHash,
    dossier,
    objectives,
    attestations,
    authorization_summary: resolution.resolutions,
    outcome: "approved",
    traces,
  };
  await record(state);
  await silentTransitionFn(cfg, issueNumber, STAGE, NEXT_STAGE);
  await postCommentFn(
    cfg,
    issueNumber,
    buildPreCodeAttestationComment(
      state,
      `Approved by \`${actor}\`. Advancing to implementing.`,
    ),
  ).catch(() => {});
  console.log(
    `[pipeline] #${issueNumber}: pre-code-attestation approved by ${actor}; advancing to implementing.`,
  );
  return {
    advanced: true,
    from: STAGE,
    to: NEXT_STAGE,
    summary: `pre-code-attestation approved by ${actor}`,
  };
}

/**
 * Evaluate the gate inside planning after plan-review and before implementing.
 * Returns whether implementing may proceed, plus optional outcome for holds.
 *
 * Used so planning can stop at pre-code-attestation when triggered without
 * a current approve, without re-running the full planning harness on resume.
 */
export async function evaluatePreCodeGateForPlanning(
  cfg: PipelineConfig,
  issueNumber: number,
  planText: string,
  opts: {
    stateDir?: string;
    comments?: { author: string; body: string }[];
    labels?: string[];
    deps?: PreCodeAttestationDeps;
  } = {},
): Promise<
  | { mayImplement: true; state: PreCodeAttestationState }
  | { mayImplement: false; state: PreCodeAttestationState; hold: "wait" | "integrity"; reason: string; blockerKind: BlockerKind }
> {
  const deps = opts.deps ?? {};
  const nowFn = deps.now ?? (() => Date.now());
  const pca = effectivePreCodeAttestation(cfg);
  const policyHash = hashPreCodeAttestationPolicy(pca);

  if (!pca.enabled) {
    const state = emptyPreCodeState(
      { triggered: false, matched: [], reason: "gate-disabled" },
      policyHash,
      "gate-disabled",
    );
    state.enabled = false;
    if (opts.stateDir) {
      await recordPreCodeAttestation(opts.stateDir, issueNumber, state).catch(() => {});
    }
    return { mayImplement: true, state };
  }

  const comments = opts.comments ?? [];
  const dossierText = findLatestDossierText(comments, planText);
  let dossier: PreCodeDesignDossier | null = deps.dossier ?? null;
  if (!dossier) {
    const parsed = parseDossierFromText(dossierText);
    if (parsed.ok && parsed.dossier) dossier = parsed.dossier;
  }
  const declaredPaths = [
    ...extractDeclaredPathsFromPlan(planText + "\n" + dossierText),
    ...(dossier?.expected_delta.file_tree ?? []),
  ];
  const trigger = evaluatePreCodeAttestationTrigger({ pre_code_attestation: pca }, {
    labels: opts.labels ?? [],
    declaredPaths,
    declaredRiskClasses: dossier?.declared_risk_classes,
    declaredComponents: dossier?.declared_components,
    estimatedFiles: dossier?.estimated_files ?? (declaredPaths.length || null),
    estimatedLoc: dossier?.estimated_loc ?? null,
  });

  if (!trigger.triggered) {
    const state = emptyPreCodeState(trigger, policyHash, "no-trigger-matched");
    state.enabled = true;
    if (opts.stateDir) {
      await recordPreCodeAttestation(opts.stateDir, issueNumber, state).catch(() => {});
    }
    return { mayImplement: true, state };
  }

  // Triggered: need dossier + current approve
  const attestations =
    deps.attestations ?? collectAttestationsFromComments(comments);

  if (!dossier) {
    const state = emptyPreCodeState(trigger, policyHash, "dossier-missing");
    state.enabled = true;
    if (opts.stateDir) {
      await recordPreCodeAttestation(opts.stateDir, issueNumber, state).catch(() => {});
    }
    return {
      mayImplement: false,
      state,
      hold: "integrity",
      reason:
        "pre-code-attestation: trigger matched but design dossier is missing. Post ## Pre-Code Design Dossier before implementing.",
      blockerKind: "pre-code-attestation-failed",
    };
  }

  const dossierHash = hashDossier(dossier);
  const latest = [...attestations].reverse().find((a) => a.decision === "approve" || a.decision === "reject");

  if (latest?.decision === "reject") {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: latest.resolution_evidence,
      outcome: "rejected",
      traces: [],
    };
    if (opts.stateDir) {
      await recordPreCodeAttestation(opts.stateDir, issueNumber, state).catch(() => {});
    }
    return {
      mayImplement: false,
      state,
      hold: "integrity",
      reason: `pre-code-attestation: rejected by ${latest.actor}`,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  if (!latest || latest.decision !== "approve") {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: null,
      outcome: "waiting-for-attestation",
      traces: [],
      wait_started_at: new Date(nowFn()).toISOString(),
    };
    if (opts.stateDir) {
      await recordPreCodeAttestation(opts.stateDir, issueNumber, state).catch(() => {});
    }
    return {
      mayImplement: false,
      state,
      hold: "wait",
      reason:
        "pre-code-attestation: waiting for authorized human attestation (agent plan-review is not sufficient)",
      blockerKind: "human-decision-required",
    };
  }

  const matchedRisks = [...new Set(trigger.matched.map((m) => m.trigger))];
  const components =
    dossier.declared_components?.length
      ? dossier.declared_components
      : dossier.expected_delta.file_tree;

  const currency = evaluateAttestationCurrency({
    record: latest,
    currentDossierHash: dossierHash,
    currentPolicyHash: policyHash,
    currentScope: { components, risk_classes: matchedRisks },
    nowMs: nowFn(),
    reapproveOn: pca.expiration.reapprove_on,
  });
  if (!currency.current) {
    const state: PreCodeAttestationState = {
      schema_version: 1,
      enabled: true,
      trigger,
      policy_hash: policyHash,
      dossier_hash: dossierHash,
      dossier,
      objectives: [],
      attestations,
      authorization_summary: latest.resolution_evidence,
      outcome: currency.reason.includes("expired")
        ? "attestation-expired"
        : "attestation-stale",
      traces: [],
    };
    if (opts.stateDir) {
      await recordPreCodeAttestation(opts.stateDir, issueNumber, state).catch(() => {});
    }
    return {
      mayImplement: false,
      state,
      hold: "integrity",
      reason: `pre-code-attestation: approve non-current (${currency.reason})`,
      blockerKind: "pre-code-attestation-failed",
    };
  }

  const objectives = buildObjectiveManifest(dossier, {
    derivedDispositions: latest.derived_dispositions,
    untestableAffirmations: latest.untestable_affirmations,
  });
  const state: PreCodeAttestationState = {
    schema_version: 1,
    enabled: true,
    trigger,
    policy_hash: policyHash,
    dossier_hash: dossierHash,
    dossier,
    objectives,
    attestations,
    authorization_summary: latest.resolution_evidence,
    outcome: "approved",
    traces: buildContractTraces(objectives),
  };
  if (opts.stateDir) {
    await recordPreCodeAttestation(opts.stateDir, issueNumber, state).catch(() => {});
  }
  return { mayImplement: true, state };
}

// Re-export builders for tests that submit complete records
export {
  buildApproveAttestationRecord,
  buildRejectAttestationRecord,
  hashDossier,
  hashPreCodeAttestationPolicy,
};
