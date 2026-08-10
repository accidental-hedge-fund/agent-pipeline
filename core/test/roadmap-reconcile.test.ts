// Full SemVer milestone reconciliation (#910) — injected GitHub seams only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReconciliationManifest,
  applySemverReconciliation,
  computeLiveStateFingerprint,
  computeManifestIdentity,
  manifestIdentityMatches,
  resolveMilestoneIdentity,
  parseShippedSemverTitles,
  saveReviewedManifest,
  loadReviewedManifest,
  validateSemverApplyReady,
  type ReconcileLiveState,
} from "../scripts/roadmap/reconcile.ts";
import type {
  CompatibilityClassification,
  MilestoneCatalogEntry,
  MilestoneSpec,
  IssueMilestoneSnapshot,
  ReconciliationAction,
  ReconciliationManifest,
  ReconciliationProgress,
} from "../scripts/roadmap/types.ts";
import type { WritebackDeps } from "../scripts/roadmap/writeback.ts";

function snap(
  n: number,
  opts: Partial<IssueMilestoneSnapshot> = {},
): IssueMilestoneSnapshot {
  return {
    number: n,
    state: "open",
    milestone_number: null,
    milestone_title: null,
    updatedAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
    labels: ["semver:minor"],
    ...opts,
  };
}

function ms(
  number: number,
  title: string,
  opts: Partial<MilestoneCatalogEntry> = {},
): MilestoneCatalogEntry {
  return {
    id: number,
    number,
    title,
    state: "open",
    description: "",
    open_issues: 0,
    closed_issues: 0,
    ...opts,
  };
}

function classification(
  n: number,
  impact: "major" | "minor" | "patch" | null,
  status: CompatibilityClassification["status"] = impact ? "resolved" : "unresolved_missing",
): CompatibilityClassification {
  if (status === "unresolved_conflict") {
    return {
      issue_number: n,
      status,
      applied_impact: null,
      source_label: null,
      uncertain: true,
      conflict_labels: ["semver:major", "semver:patch"],
    };
  }
  if (status !== "resolved" || impact === null) {
    return {
      issue_number: n,
      status: "unresolved_missing",
      applied_impact: null,
      source_label: null,
      uncertain: true,
    };
  }
  return {
    issue_number: n,
    status: "resolved",
    applied_impact: impact,
    source_label: `semver:${impact}`,
    uncertain: false,
  };
}

function makeLive(
  milestones: MilestoneCatalogEntry[],
  openIssues: IssueMilestoneSnapshot[],
  shipped: string[] = ["v1.0.0"],
): ReconcileLiveState {
  return {
    milestones,
    openIssues,
    shippedTitles: parseShippedSemverTitles(shipped),
  };
}

function makeDeps(
  live: ReconcileLiveState,
  overrides: Partial<WritebackDeps> = {},
): {
  deps: WritebackDeps;
  files: Map<string, string>;
  created: string[];
  assigned: Array<{ issue: number; title: string }>;
  cleared: number[];
  reopened: number[];
  updated: Array<{ n: number; title?: string; description?: string }>;
} {
  const files = new Map<string, string>();
  const created: string[] = [];
  const assigned: Array<{ issue: number; title: string }> = [];
  const cleared: number[] = [];
  const reopened: number[] = [];
  const updated: Array<{ n: number; title?: string; description?: string }> = [];
  let nextMilestone = 100;

  const deps: WritebackDeps = {
    writeFile: async (p, c) => {
      files.set(p, c);
    },
    readFile: async (p) => files.get(p) ?? null,
    withThrowawayWorktree: async (_a, _b, _c, fn) => fn("/tmp/wt"),
    gitCommit: async () => {},
    gitPushBranch: async () => {},
    findPrByHead: async () => null,
    createPr: async () => "https://example/pr/1",
    createLabel: async () => {},
    applyLabel: async () => {},
    createMilestone: async (_repo, title, description) => {
      created.push(title);
      const number = nextMilestone++;
      live.milestones.push(
        ms(number, title, { description: description ?? "", state: "open" }),
      );
      return number;
    },
    getMilestones: async () =>
      live.milestones.map((m) => ({ id: m.id, number: m.number, title: m.title })),
    listMilestonesDetailed: async () => [...live.milestones],
    listOpenIssueMilestoneSnapshots: async () => [...live.openIssues],
    reopenMilestone: async (_repo, n) => {
      reopened.push(n);
      const m = live.milestones.find((x) => x.number === n);
      if (m) m.state = "open";
    },
    updateMilestone: async (_repo, n, opts) => {
      updated.push({ n, ...opts });
      const m = live.milestones.find((x) => x.number === n);
      if (m) {
        if (opts.title !== undefined) m.title = opts.title;
        if (opts.description !== undefined) m.description = opts.description;
      }
    },
    assignIssueMilestone: async (_repo, issueNumber, milestoneTitle) => {
      assigned.push({ issue: issueNumber, title: milestoneTitle });
      const issue = live.openIssues.find((i) => i.number === issueNumber);
      const m = live.milestones.find((x) => x.title === milestoneTitle);
      if (issue) {
        issue.milestone_title = milestoneTitle;
        issue.milestone_number = m?.number ?? null;
      }
    },
    clearIssueMilestone: async (_repo, issueNumber) => {
      cleared.push(issueNumber);
      const issue = live.openIssues.find((i) => i.number === issueNumber);
      if (issue) {
        issue.milestone_number = null;
        issue.milestone_title = null;
      }
    },
    closeIssue: async () => {},
    addComment: async () => {},
    editIssue: async () => {},
    createIssue: async () => 1,
    getIssueState: async () => "open",
    getIssueComments: async () => [],
    log: () => {},
    ...overrides,
  };

  return { deps, files, created, assigned, cleared, reopened, updated };
}

function buildSimpleManifest(
  live: ReconcileLiveState,
  milestones: MilestoneSpec[],
  classifications: CompatibilityClassification[],
  openNums?: number[],
): ReconciliationManifest {
  return buildReconciliationManifest({
    milestones,
    classifications,
    openIssueNumbers: openNums ?? live.openIssues.map((i) => i.number),
    live,
    generatedAt: "2026-08-10T00:00:00Z",
  });
}

describe("resolveMilestoneIdentity", () => {
  it("5.1 title collision: ambiguous same-title milestones without stable identity fail visibly", () => {
    const catalog = [ms(1, "v1.8.0"), ms(2, "v1.8.0")];
    const result = resolveMilestoneIdentity(
      { title: "v1.8.0", description: "x", issue_numbers: [10] },
      catalog,
      new Set(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.blocker.reason, "title_collision");
      assert.match(result.blocker.detail, /Ambiguous/);
    }
  });

  it("prefers stable milestone number identity", () => {
    const catalog = [ms(7, "v1.8.0"), ms(8, "v1.9.0")];
    const result = resolveMilestoneIdentity(
      { number: 7, title: "v1.8.0", description: "x", issue_numbers: [1] },
      catalog,
      new Set(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mode, "reuse");
      assert.equal(result.entry?.number, 7);
    }
  });
});

describe("buildReconciliationManifest", () => {
  it("5.9 unresolved classification blocks apply; prose does not select version", () => {
    const live = makeLive(
      [],
      [
        snap(1, { labels: [] }), // no semver label; body/prose irrelevant
        snap(2, { labels: ["semver:patch"] }),
      ],
    );
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.1.0", issue_numbers: [2], rationale: "patch", version_impact: "patch" }],
      [classification(1, null), classification(2, "patch")],
    );
    assert.ok(
      manifest.coverage_blockers.some(
        (b) => b.issue_number === 1 && b.reason === "unresolved_missing",
      ),
    );
    assert.ok(
      !manifest.actions.some((a) => a.kind === "assign" && a.issue_number === 1),
      "unresolved issue must not be assigned",
    );
  });

  it("5.10 theme-only labeling does not satisfy the milestoned invariant", () => {
    const live = makeLive([], [snap(5, { labels: ["theme:auth", "epic:platform"] })]);
    const manifest = buildSimpleManifest(
      live,
      [],
      [classification(5, null)],
    );
    assert.ok(
      manifest.coverage_blockers.some(
        (b) =>
          b.issue_number === 5 &&
          (b.reason === "unresolved_missing" || b.reason === "unmilestoned"),
      ),
    );
    assert.ok(
      manifest.coverage_blockers.some((b) => /theme\/epic/i.test(b.detail)),
      "blocker must mention theme/epic do not satisfy invariant",
    );
  });

  it("dry-run action list includes create, assign, and clear_stale", () => {
    const live = makeLive(
      [ms(1, "v1.0.0", { state: "closed", closed_issues: 3 })],
      [snap(10, { milestone_number: 1, milestone_title: "v1.0.0" }), snap(11)],
      ["v1.0.0"],
    );
    const manifest = buildSimpleManifest(
      live,
      [
        {
          title: "v1.1.0",
          issue_numbers: [10, 11],
          rationale: "next minor",
          version_impact: "minor",
        },
      ],
      [classification(10, "minor"), classification(11, "minor")],
    );
    const kinds = new Set(manifest.actions.map((a) => a.kind));
    assert.ok(kinds.has("create"), "missing milestone should create");
    assert.ok(kinds.has("assign"), "should assign");
    assert.ok(kinds.has("clear_stale"), "stale assignment should clear");
  });
});

describe("applySemverReconciliation", () => {
  it("5.2 stale assignment removal moves an issue from the wrong milestone to the target", async () => {
    const live = makeLive(
      [ms(1, "v1.7.0"), ms(2, "v1.8.0")],
      [snap(42, { milestone_number: 1, milestone_title: "v1.7.0", labels: ["semver:minor"] })],
    );
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.8.0", issue_numbers: [42], rationale: "r", version_impact: "minor" }],
      [classification(42, "minor")],
    );
    const { deps, cleared, assigned } = makeDeps(live);
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(result.ok, true);
    assert.ok(cleared.includes(42));
    assert.ok(assigned.some((a) => a.issue === 42 && a.title === "v1.8.0"));
    assert.equal(live.openIssues[0].milestone_title, "v1.8.0");
  });

  it("5.3 issue-state drift between preview and apply refuses apply", async () => {
    const live = makeLive([], [snap(1, { labels: ["semver:patch"] })]);
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.0.1", issue_numbers: [1], rationale: "r", version_impact: "patch" }],
      [classification(1, "patch")],
    );
    // Drift: mutate live after preview fingerprint captured
    live.openIssues[0].milestone_title = "someone-else";
    live.openIssues[0].milestone_number = 99;
    const { deps } = makeDeps(live);
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "fingerprint_drift");
  });

  it("5.4 changed manifest identity is rejected at apply", async () => {
    const live = makeLive([], [snap(1, { labels: ["semver:patch"] })]);
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.0.1", issue_numbers: [1], rationale: "r", version_impact: "patch" }],
      [classification(1, "patch")],
    );
    const { deps } = makeDeps(live);
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, {
      live,
      expectedIdentity: "not-the-real-identity",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "manifest_identity_mismatch");
  });

  it("5.5 closed shipped milestones are not renamed, reopened, or description-rewritten", async () => {
    const live = makeLive(
      [
        ms(5, "v1.0.0", {
          state: "closed",
          description: "shipped",
          closed_issues: 10,
          open_issues: 0,
        }),
      ],
      [snap(1, { labels: ["semver:minor"] })],
      ["v1.0.0"],
    );
    // Manifest wrongly tries to bind shipped number 5 to a different title — should block
    const targets = [
      {
        number: 5,
        title: "v2.0.0",
        description: "rewrite shipped",
        version_impact: "major" as const,
        issue_numbers: [1],
      },
    ];
    // Use planner path via resolve
    const resolved = resolveMilestoneIdentity(targets[0], live.milestones, live.shippedTitles);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.blocker.reason, "shipped_immutable");

    // Normal plan targeting new title should create, not touch shipped
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.1.0", issue_numbers: [1], rationale: "next", version_impact: "minor" }],
      [classification(1, "minor")],
    );
    const { deps, reopened, updated, created } = makeDeps(live);
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(result.ok, true);
    assert.equal(reopened.length, 0);
    assert.ok(!updated.some((u) => u.n === 5));
    assert.ok(created.includes("v1.1.0"));
    const shipped = live.milestones.find((m) => m.number === 5)!;
    assert.equal(shipped.title, "v1.0.0");
    assert.equal(shipped.state, "closed");
    assert.equal(shipped.description, "shipped");
  });

  it("5.6 named closed empty unshipped planning milestone can reopen; unnamed is not reopened", async () => {
    const live = makeLive(
      [
        ms(20, "v1.9.0", { state: "closed", open_issues: 0, closed_issues: 0, description: "plan" }),
        ms(21, "v1.10.0", { state: "closed", open_issues: 0, closed_issues: 0, description: "other" }),
      ],
      [snap(3, { labels: ["semver:minor"] })],
      ["v1.0.0"],
    );
    // Preview binds stable number into targets so reopen is named, not opportunistic
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.9.0", issue_numbers: [3], rationale: "reuse plan", version_impact: "minor" }],
      [classification(3, "minor")],
    );
    assert.equal(
      manifest.targets.find((t) => t.title === "v1.9.0")?.number,
      20,
      "reviewed target must name stable milestone identity",
    );
    assert.ok(manifest.actions.some((a) => a.kind === "reopen" && a.milestone_number === 20));
    assert.ok(!manifest.actions.some((a) => a.kind === "reopen" && a.milestone_number === 21));

    const { deps, reopened, created } = makeDeps(live);
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(result.ok, true);
    assert.deepEqual(reopened, [20]);
    assert.equal(created.length, 0);
    assert.equal(live.milestones.find((m) => m.number === 20)?.state, "open");
    assert.equal(live.milestones.find((m) => m.number === 21)?.state, "closed");
  });

  it("5.7 partial apply then retry resumes without duplicate milestones or repeated assignments", async () => {
    const live = makeLive([], [snap(7, { labels: ["semver:minor"] }), snap(8, { labels: ["semver:minor"] })]);
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.9.0", issue_numbers: [7, 8], rationale: "r", version_impact: "minor" }],
      [classification(7, "minor"), classification(8, "minor")],
    );
    let failAfterCreate = true;
    const { deps, created, assigned, files } = makeDeps(live, {
      assignIssueMilestone: async (_repo, issueNumber, milestoneTitle) => {
        if (failAfterCreate) {
          throw new Error("simulated assign failure");
        }
        assigned.push({ issue: issueNumber, title: milestoneTitle });
        const issue = live.openIssues.find((i) => i.number === issueNumber);
        const m = live.milestones.find((x) => x.title === milestoneTitle);
        if (issue) {
          issue.milestone_title = milestoneTitle;
          issue.milestone_number = m?.number ?? null;
        }
      },
    });

    await assert.rejects(
      () => applySemverReconciliation(manifest, "o/r", "/out", deps, { live }),
      /simulated assign failure/,
    );
    assert.equal(created.length, 1);
    assert.equal(created[0], "v1.9.0");
    assert.ok(files.has("/out/reconciliation-progress.json"));
    const progress = JSON.parse(files.get("/out/reconciliation-progress.json")!);
    assert.equal(progress.status, "failed");
    assert.ok(progress.completed.length >= 1);

    // Resume
    failAfterCreate = false;
    // Keep same fingerprint gate path via resume (identity match + failed status)
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.resumed, true);
    assert.equal(created.length, 1, "must not create a second v1.9.0");
    assert.ok(assigned.some((a) => a.issue === 7));
    assert.ok(assigned.some((a) => a.issue === 8));
  });

  it("5.8 exact no-op convergence on second apply against converged state", async () => {
    const live = makeLive([], [snap(1, { labels: ["semver:patch"] })]);
    const milestones: MilestoneSpec[] = [
      { title: "v1.0.1", issue_numbers: [1], rationale: "r", version_impact: "patch" },
    ];
    const classifications = [classification(1, "patch")];
    const manifest1 = buildSimpleManifest(live, milestones, classifications);
    const { deps, created, assigned } = makeDeps(live);
    const r1 = await applySemverReconciliation(manifest1, "o/r", "/out", deps, { live });
    assert.equal(r1.ok, true);
    assert.ok(created.length === 1);

    // Rebuild manifest against converged live
    const manifest2 = buildSimpleManifest(live, milestones, classifications);
    assert.equal(manifest2.actions.filter((a) => a.kind === "create").length, 0);
    assert.equal(manifest2.actions.filter((a) => a.kind === "assign").length, 0);
    const createsBefore = created.length;
    const assignsBefore = assigned.length;
    const r2 = await applySemverReconciliation(manifest2, "o/r", "/out", deps, { live });
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.noop, true);
    assert.equal(created.length, createsBefore);
    assert.equal(assigned.length, assignsBefore);
  });

  it("matching fingerprint allows apply; coverage blockers refuse", async () => {
    const live = makeLive([], [snap(1, { labels: [] })]);
    const manifest = buildSimpleManifest(
      live,
      [],
      [classification(1, null)],
    );
    assert.ok(manifest.coverage_blockers.length > 0);
    const { deps } = makeDeps(live);
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "coverage_blockers");
  });

  it("c33d6a3c: apply uses persisted reviewed manifest, not a regenerated plan", async () => {
    const live = makeLive([], [snap(1, { labels: ["semver:patch"] })]);
    const reviewed = buildSimpleManifest(
      live,
      [{ title: "v1.0.1", issue_numbers: [1], rationale: "reviewed", version_impact: "patch" }],
      [classification(1, "patch")],
    );
    const { deps, files, created } = makeDeps(live);
    await saveReviewedManifest("/out", reviewed, deps);
    const loaded = await loadReviewedManifest("/out", deps);
    assert.ok(loaded);
    assert.equal(loaded!.identity, reviewed.identity);
    assert.ok(files.has("/out/reconciliation-manifest.json"));

    // A regenerated plan with different targets must not be applied silently
    const regenerated = buildSimpleManifest(
      live,
      [{ title: "v9.9.9", issue_numbers: [1], rationale: "regenerated", version_impact: "major" }],
      [classification(1, "patch")],
    );
    assert.notEqual(regenerated.identity, reviewed.identity);

    const result = await applySemverReconciliation(loaded!, "o/r", "/out", deps, {
      live,
      expectedIdentity: reviewed.identity,
    });
    assert.equal(result.ok, true);
    assert.ok(created.includes("v1.0.1"));
    assert.ok(!created.includes("v9.9.9"), "must not execute regenerated plan");

    // Identity mismatch refuses
    const mismatch = await applySemverReconciliation(regenerated, "o/r", "/out2", deps, {
      live: makeLive([], [snap(1, { labels: ["semver:patch"] })]),
      expectedIdentity: reviewed.identity,
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.code, "manifest_identity_mismatch");
  });

  it("49e7f682: title-only resolve never reopens closed milestones; reopen needs number", () => {
    const closed = ms(20, "v1.9.0", {
      state: "closed",
      open_issues: 0,
      closed_issues: 0,
    });
    // Without stable number: create, do not reopen
    const byTitle = resolveMilestoneIdentity(
      { title: "v1.9.0", description: "x", issue_numbers: [1] },
      [closed],
      new Set(["v1.0.0"]),
    );
    assert.equal(byTitle.ok, true);
    if (byTitle.ok) {
      assert.equal(byTitle.mode, "create");
      assert.equal(byTitle.entry, null);
    }
    // With stable number: reopen allowed for empty unshipped
    const byNumber = resolveMilestoneIdentity(
      { number: 20, title: "v1.9.0", description: "x", issue_numbers: [1] },
      [closed],
      new Set(["v1.0.0"]),
    );
    assert.equal(byNumber.ok, true);
    if (byNumber.ok) {
      assert.equal(byNumber.mode, "reopen");
      assert.equal(byNumber.entry?.number, 20);
    }
  });

  it("9ec3c09a: resume refuses after completed action when live state drifts", async () => {
    const live = makeLive([], [
      snap(7, { labels: ["semver:minor"] }),
      snap(8, { labels: ["semver:minor"] }),
    ]);
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.9.0", issue_numbers: [7, 8], rationale: "r", version_impact: "minor" }],
      [classification(7, "minor"), classification(8, "minor")],
    );
    let failAfterCreate = true;
    const { deps, created, files } = makeDeps(live, {
      assignIssueMilestone: async () => {
        if (failAfterCreate) throw new Error("simulated assign failure");
      },
    });

    await assert.rejects(
      () => applySemverReconciliation(manifest, "o/r", "/out", deps, { live }),
      /simulated assign failure/,
    );
    assert.equal(created.length, 1);
    const progress = JSON.parse(files.get("/out/reconciliation-progress.json")!) as ReconciliationProgress;
    assert.equal(progress.status, "failed");
    assert.ok(progress.completed.length >= 1);
    assert.ok(progress.last_fingerprint, "must record post-action fingerprint chain");

    // External drift after partial apply: reassign issue before resume
    live.openIssues[0].milestone_title = "external-hijack";
    live.openIssues[0].milestone_number = 999;
    failAfterCreate = false;
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "fingerprint_drift");
  });

  it("77c17499: shipped title added after preview changes fingerprint and blocks reopen", async () => {
    const closed = ms(20, "v1.9.0", {
      state: "closed",
      open_issues: 0,
      closed_issues: 0,
      description: "plan",
    });
    const live = makeLive(
      [closed],
      [snap(3, { labels: ["semver:minor"] })],
      ["v1.0.0"],
    );
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.9.0", issue_numbers: [3], rationale: "reuse", version_impact: "minor" }],
      [classification(3, "minor")],
    );
    assert.ok(manifest.actions.some((a) => a.kind === "reopen" && a.milestone_number === 20));

    // Tag appears after preview → fingerprint must change
    live.shippedTitles.add("v1.9.0");
    assert.notEqual(
      computeLiveStateFingerprint(live),
      manifest.live_state_fingerprint,
      "shippedTitles must be part of live-state fingerprint",
    );
    const { deps, reopened } = makeDeps(live);
    const result = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "fingerprint_drift");
    assert.equal(reopened.length, 0);

    // Defensive: even if fingerprint were bypassed, executor refuses shipped reopen
    const live2 = makeLive(
      [ms(20, "v1.9.0", { state: "closed", open_issues: 0, closed_issues: 0 })],
      [snap(3, { labels: ["semver:minor"] })],
      ["v1.9.0"],
    );
    const { deps: deps2, reopened: reopened2 } = makeDeps(live2);
    const targets2 = [{ number: 20, title: "v1.9.0", description: "d", issue_numbers: [3] }];
    const actions2: ReconciliationAction[] = [
      {
        id: "001-reopen-20",
        kind: "reopen",
        milestone_number: 20,
        milestone_title: "v1.9.0",
      },
    ];
    const fp2 = computeLiveStateFingerprint(live2);
    await assert.rejects(
      () =>
        applySemverReconciliation(
          {
            identity: computeManifestIdentity(targets2, actions2, [], fp2),
            live_state_fingerprint: fp2,
            targets: targets2,
            actions: actions2,
            coverage_blockers: [],
            generated_at: "2026-08-10T00:00:00Z",
          },
          "o/r",
          "/out-shipped",
          deps2,
          { live: live2 },
        ),
      /shipped milestone/,
    );
    assert.equal(reopened2.length, 0);
  });

  it("66a181f2: closed milestone with completed issues is not reusable empty", () => {
    const closedWithHistory = ms(30, "v1.5.0", {
      state: "closed",
      open_issues: 0,
      closed_issues: 4,
    });
    const result = resolveMilestoneIdentity(
      { number: 30, title: "v1.8.0", description: "rewrite history", issue_numbers: [1] },
      [closedWithHistory],
      new Set(["v1.0.0"]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.blocker.reason, "shipped_immutable");
      assert.match(result.blocker.detail, /not a reusable empty/);
    }

    // Preview must create rather than reopen history-bearing closed milestone by title
    const live = makeLive(
      [closedWithHistory],
      [snap(1, { labels: ["semver:minor"] })],
      ["v1.0.0"],
    );
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.5.0", issue_numbers: [1], rationale: "r", version_impact: "minor" }],
      [classification(1, "minor")],
    );
    assert.ok(
      !manifest.actions.some((a) => a.kind === "reopen"),
      "must not reopen closed milestone that has closed_issues > 0",
    );
    assert.ok(manifest.actions.some((a) => a.kind === "create"));
  });

  it("8420b97a: validateSemverApplyReady gates before any write-back", () => {
    const live = makeLive([], [snap(1, { labels: ["semver:patch"] })]);
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.0.1", issue_numbers: [1], rationale: "r", version_impact: "patch" }],
      [classification(1, "patch")],
    );
    // Matching → ready
    const ok = validateSemverApplyReady(manifest, live, {
      expectedIdentity: manifest.identity,
    });
    assert.equal(ok.ok, true);

    // Drift → refuse (caller must not run hygiene/mutations)
    live.openIssues[0].milestone_title = "drifted";
    const refused = validateSemverApplyReady(manifest, live, {
      expectedIdentity: manifest.identity,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "fingerprint_drift");

    // Coverage blockers → refuse
    const blocked = buildSimpleManifest(
      makeLive([], [snap(2, { labels: [] })]),
      [],
      [classification(2, null)],
    );
    const blockGate = validateSemverApplyReady(blocked, makeLive([], [snap(2)]), {});
    assert.equal(blockGate.ok, false);
    if (!blockGate.ok) assert.equal(blockGate.code, "coverage_blockers");
  });
});

describe("fingerprint and identity", () => {
  it("identity is stable for same full package; fingerprint changes with issue milestone", () => {
    const live1 = makeLive([], [snap(1)]);
    const live2 = makeLive([], [snap(1, { milestone_title: "v1.2.0", milestone_number: 3 })]);
    const targets = [
      { title: "v1.2.0", description: "d", issue_numbers: [1], version_impact: "minor" as const },
    ];
    const actions: ReconciliationAction[] = [
      { id: "001-create-v1.2.0", kind: "create", milestone_title: "v1.2.0" },
    ];
    const fp = "abc123";
    assert.equal(
      computeManifestIdentity(targets, actions, [], fp),
      computeManifestIdentity(targets, actions, [], fp),
    );
    assert.notEqual(
      computeLiveStateFingerprint(live1),
      computeLiveStateFingerprint(live2),
    );
  });

  it("fingerprint changes when shippedTitles change", () => {
    const live1 = makeLive([ms(1, "v1.9.0", { state: "closed" })], [snap(1)], ["v1.0.0"]);
    const live2 = makeLive([ms(1, "v1.9.0", { state: "closed" })], [snap(1)], ["v1.0.0", "v1.9.0"]);
    assert.notEqual(
      computeLiveStateFingerprint(live1),
      computeLiveStateFingerprint(live2),
    );
  });
});

describe("review 2 regressions (#910)", () => {
  it("f33c51de: completed progress refuses silent no-op after later live-state drift", async () => {
    const live = makeLive([], [snap(1, { labels: ["semver:patch"] })]);
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.0.1", issue_numbers: [1], rationale: "r", version_impact: "patch" }],
      [classification(1, "patch")],
    );
    const { deps, files } = makeDeps(live);
    const r1 = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(r1.ok, true);
    const progress = JSON.parse(files.get("/out/reconciliation-progress.json")!) as ReconciliationProgress;
    assert.equal(progress.status, "complete");

    // Post-completion drift: issue unassigned / moved
    live.openIssues[0].milestone_title = null;
    live.openIssues[0].milestone_number = null;
    live.openIssues[0].updatedAt = "2026-08-10T99:00:00Z";

    const r2 = await applySemverReconciliation(manifest, "o/r", "/out", deps, { live });
    assert.equal(r2.ok, false, "must not report successful no-op after drift");
    if (!r2.ok) assert.equal(r2.code, "fingerprint_drift");

    // Gate path agrees
    const gate = validateSemverApplyReady(manifest, live, {
      expectedIdentity: manifest.identity,
      resumeProgress: progress,
    });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.code, "fingerprint_drift");
  });

  it("b2694882: full open-issue snapshot covers issues outside inventory filter", () => {
    // Live snapshot has #99 not present in inventory-scoped openIssueNumbers.
    const live = makeLive(
      [],
      [
        snap(1, { labels: ["semver:patch"] }),
        snap(99, { labels: ["semver:minor"] }), // newly opened / inventory-filtered out
      ],
    );
    // Inventory-only view would pass openIssueNumbers: [1] only
    const inventoryOnly = buildSimpleManifest(
      live,
      [{ title: "v1.0.1", issue_numbers: [1], rationale: "r", version_impact: "patch" }],
      [classification(1, "patch")],
      [1],
    );
    assert.ok(
      !inventoryOnly.coverage_blockers.some((b) => b.issue_number === 99),
      "control: inventory-only openIssueNumbers omits #99 from coverage",
    );

    // Full repository scope: every open issue from the live snapshot
    const full = buildSimpleManifest(
      live,
      [{ title: "v1.0.1", issue_numbers: [1], rationale: "r", version_impact: "patch" }],
      [classification(1, "patch"), classification(99, "minor")],
      live.openIssues.map((i) => i.number),
    );
    assert.ok(
      full.coverage_blockers.some(
        (b) => b.issue_number === 99 && (b.reason === "unmilestoned" || b.reason === "unresolved_missing"),
      ),
      "full open-issue scope must surface #99 as a coverage blocker when not in plan lanes",
    );
    // Fingerprint must include #99
    const without99 = makeLive([], [snap(1, { labels: ["semver:patch"] })]);
    assert.notEqual(
      computeLiveStateFingerprint(live),
      computeLiveStateFingerprint(without99),
      "fingerprint must include newly opened / filter-excluded open issues",
    );
  });

  it("451c582a: identity binds actions; altered action artifact is refused", async () => {
    const live = makeLive([], [snap(1, { labels: ["semver:patch"] })]);
    const reviewed = buildSimpleManifest(
      live,
      [{ title: "v1.0.1", issue_numbers: [1], rationale: "reviewed", version_impact: "patch" }],
      [classification(1, "patch")],
    );
    assert.ok(manifestIdentityMatches(reviewed));

    // Inject an extra assign action without retargeting — identity must change
    const tampered: ReconciliationManifest = {
      ...reviewed,
      actions: [
        ...reviewed.actions,
        {
          id: "999-assign-injected",
          kind: "assign",
          issue_number: 1,
          milestone_title: "v9.9.9",
          detail: "injected",
        },
      ],
    };
    assert.equal(
      manifestIdentityMatches(tampered),
      false,
      "actions are part of identity — injection must break the bind",
    );

    const { deps, files, created } = makeDeps(live);
    // Persist tampered package with its *claimed* (stale) identity
    await deps.writeFile(
      "/out/reconciliation-manifest.json",
      JSON.stringify(tampered, null, 2) + "\n",
    );
    const loaded = await loadReviewedManifest("/out", deps);
    assert.equal(loaded, null, "loadReviewedManifest must reject identity/action mismatch");

    // Even if loaded by force, apply refuses
    const forced = await applySemverReconciliation(tampered, "o/r", "/out2", deps, {
      live,
      expectedIdentity: reviewed.identity,
    });
    assert.equal(forced.ok, false);
    if (!forced.ok) {
      assert.ok(
        forced.code === "manifest_identity_mismatch" || forced.code === "fingerprint_drift",
      );
    }
    assert.equal(created.length, 0);
    assert.ok(!files.has("/out2/reconciliation-progress.json") || forced.ok === false);
  });

  it("bcdee39b: first-action resume uses post-hygiene fingerprint, not pre-hygiene", async () => {
    // Simulate: apply starts with post-hygiene live (updatedAt already advanced by hygiene).
    // First recon action fails before any completion is saved after the first mutation's
    // post-action fp. Retry with the same post-hygiene live must resume, not refuse as drift.
    const live = makeLive([], [
      snap(7, { labels: ["semver:minor"], updatedAt: "2026-08-10T12:00:00Z" }),
      snap(8, { labels: ["semver:minor"], updatedAt: "2026-08-10T12:00:00Z" }),
    ]);
    const manifest = buildSimpleManifest(
      live,
      [{ title: "v1.9.0", issue_numbers: [7, 8], rationale: "r", version_impact: "minor" }],
      [classification(7, "minor"), classification(8, "minor")],
    );

    // Hygiene-like timestamp advance already reflected in the live snapshot used for apply
    live.openIssues[0].updatedAt = "2026-08-10T12:05:00Z";
    live.openIssues[1].updatedAt = "2026-08-10T12:05:00Z";
    // Rebuild fingerprint on the reviewed package is not required for resume — progress
    // seeds apply_start from the live passed to apply (post-hygiene).
    const postHygieneFp = computeLiveStateFingerprint(live);
    // Reviewed artifact still has pre-hygiene fingerprint (preview time).
    assert.notEqual(postHygieneFp, manifest.live_state_fingerprint);

    let failOnce = true;
    const { deps, created, assigned, files } = makeDeps(live, {
      createMilestone: async (_repo, title, description) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated first-action failure after hygiene");
        }
        const number = 100;
        created.push(title);
        live.milestones.push(ms(number, title, { description: description ?? "", state: "open" }));
        return number;
      },
    });

    // First apply with gatesAlreadyChecked (as index does after hygiene refresh)
    await assert.rejects(
      () =>
        applySemverReconciliation(manifest, "o/r", "/out", deps, {
          live,
          gatesAlreadyChecked: true,
        }),
      /simulated first-action failure after hygiene/,
    );
    const progress = JSON.parse(files.get("/out/reconciliation-progress.json")!) as ReconciliationProgress;
    assert.equal(progress.status, "failed");
    // apply_start must be the post-hygiene fingerprint, not the preview fingerprint
    assert.equal(
      progress.apply_start_fingerprint,
      postHygieneFp,
      "progress must seed from post-hygiene live so resume is not poisoned",
    );

    // Retry: same post-hygiene live — must resume, not fingerprint_drift
    const r2 = await applySemverReconciliation(manifest, "o/r", "/out", deps, {
      live,
      gatesAlreadyChecked: true,
    });
    assert.equal(r2.ok, true, "resume must succeed when live still matches post-hygiene apply-start");
    if (r2.ok) assert.equal(r2.resumed, true);
    assert.equal(created.length, 1);
    assert.ok(assigned.some((a) => a.issue === 7));
    assert.ok(assigned.some((a) => a.issue === 8));
  });
});
