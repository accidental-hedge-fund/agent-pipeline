// Unit tests for open-soak-defect preflight (#755). Injected deps only — no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoFileLabelsForCluster,
  BUG_LABEL,
  ENGINE_CLASS_MARKER_LABEL,
  BACKLOG_LABEL,
  formatOpenSoakDefectBlockMessage,
  formatOpenSoakDefectWaiverSection,
  hasEngineClassLabelFallback,
  isEngineClassAutoFileCluster,
  issueHasTypedEngineClassMarkers,
  issueInPostTagWindow,
  issueReferencesSoak,
  runOpenSoakDefectPreflight,
  type SoakDefectCandidateIssue,
  type TypedSoakEvidence,
} from "../scripts/open-soak-defect-preflight.ts";

function openIssue(overrides: Partial<SoakDefectCandidateIssue> & Pick<SoakDefectCandidateIssue, "number" | "title">): SoakDefectCandidateIssue {
  return {
    state: "OPEN",
    labels: [],
    body: "",
    createdAt: "2026-07-30T18:00:00Z",
    ...overrides,
  };
}

const BASE_INPUT = {
  version: "1.29.1",
  frgRunId: "frg-abc",
  loopRunId: "loop-4d2de11c6c029a2f-s1",
  previousTag: "v1.29.0",
  previousTagCreatedAt: "2026-07-29T00:00:00Z",
  overrideReason: null as string | null,
};

test("empty blocking set passes without override", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [],
    listTypedSoakEvidence: async () => [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
  assert.equal(result.waived, undefined);
});

test("open typed terminal engine-class defects block with doctor-grade message", async () => {
  const issues = [
    openIssue({
      number: 712,
      title: "engine crashed mid soak",
      body: "run loop-4d2de11c6c029a2f-s1\nBlocker class: workflow-engine-defect",
      labels: [], // missing bug deliberately
    }),
    openIssue({
      number: 714,
      title: "another engine defect",
      body: "loop-4d2de11c6c029a2f-s1 workflow-engine-defect",
    }),
  ];
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => issues,
    listTypedSoakEvidence: async () => [
      {
        issueNumber: 712,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
      },
      {
        issueNumber: 714,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.ok(result.blocking.some((b) => b.issueNumber === 712 && b.classificationSource === "typed"));
  assert.ok(result.blocking.some((b) => b.issueNumber === 714 && b.classificationSource === "typed"));
  assert.match(result.message, /1\.29\.1/);
  assert.match(result.message, /loop-4d2de11c6c029a2f-s1/);
  assert.match(result.message, /#712/);
  assert.match(result.message, /#714/);
  assert.match(result.message, /--allow-open-soak-defects/);
  assert.match(result.message, /close/i);
});

test("typed hit blocks despite missing bug label", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 712,
        title: "mislabeled enhancement",
        labels: ["enhancement"], // wrong labels
        body: "loop-4d2de11c6c029a2f-s1",
      }),
    ],
    listTypedSoakEvidence: async () => [
      {
        issueNumber: 712,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0]!.classificationSource, "typed");
  assert.equal(result.blocking[0]!.issueNumber, 712);
});

test("closed issues never block", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 712,
        title: "was engine defect",
        state: "CLOSED",
        body: "loop-4d2de11c6c029a2f-s1 Blocker class: workflow-engine-defect",
        labels: [BUG_LABEL, ENGINE_CLASS_MARKER_LABEL],
      }),
    ],
    listTypedSoakEvidence: async () => [
      {
        issueNumber: 712,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("label-fallback selects historical engine-class issues with both markers", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 800,
        title: "historical engine defect",
        labels: [BUG_LABEL, ENGINE_CLASS_MARKER_LABEL, BACKLOG_LABEL],
        body: "no loop id here",
        createdAt: "2026-07-30T12:00:00Z", // after previous tag
      }),
    ],
    listTypedSoakEvidence: async () => [],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0]!.issueNumber, 800);
  assert.equal(result.blocking[0]!.classificationSource, "label-fallback");
});

test("label-fallback does not apply without both markers", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 801,
        title: "only bug",
        labels: [BUG_LABEL],
        createdAt: "2026-07-30T12:00:00Z",
      }),
      openIssue({
        number: 802,
        title: "only engine-class",
        labels: [ENGINE_CLASS_MARKER_LABEL],
        createdAt: "2026-07-30T12:00:00Z",
      }),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("converged intermediate non-terminal events do not block", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [],
    listTypedSoakEvidence: async () => [
      {
        issueNumber: null,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: false,
        recovered: true,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        title: "mid-run recovered engine-adjacent",
        reasonKey: "recovered-intermediate",
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("recovery exhaustion remains blocking while open", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 722,
        title: "recovery exhausted",
        body: "fingerprint=fp-exh loop-4d2de11c6c029a2f-s1",
      }),
    ],
    listTypedSoakEvidence: async () => [
      {
        issueNumber: 722,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        fingerprint: "fp-exh",
        reasonKey: "recovery-exhausted",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.equal(result.blocking[0]!.issueNumber, 722);
  assert.equal(result.blocking[0]!.classificationSource, "typed");
});

test("override with non-empty reason permits pass and returns waived issues", async () => {
  const result = await runOpenSoakDefectPreflight(
    { ...BASE_INPUT, overrideReason: "accepted residual; tracked offline" },
    {
      listOpenIssues: async () => [
        openIssue({
          number: 712,
          title: "open engine",
          body: "loop-4d2de11c6c029a2f-s1 Blocker class: workflow-engine-defect",
        }),
        openIssue({
          number: 714,
          title: "open engine 2",
          body: "loop-4d2de11c6c029a2f-s1 workflow-engine-defect",
        }),
      ],
      listTypedSoakEvidence: async () => [
        {
          issueNumber: 712,
          loopRunId: "loop-4d2de11c6c029a2f-s1",
          terminal: true,
          recovered: false,
          engineClass: true,
          blockerClass: "workflow-engine-defect",
        },
        {
          issueNumber: 714,
          loopRunId: "loop-4d2de11c6c029a2f-s1",
          terminal: true,
          recovered: false,
          engineClass: true,
          blockerClass: "workflow-engine-defect",
        },
      ],
    },
  );
  assert.equal(result.ok, true);
  assert.ok(result.waived);
  assert.deepEqual(result.waived!.issueNumbers, [712, 714]);
  assert.equal(result.waived!.reason, "accepted residual; tracked offline");
  assert.equal(result.blocking.length, 2);
});

test("empty override reason is rejected (fail closed)", async () => {
  const result = await runOpenSoakDefectPreflight(
    { ...BASE_INPUT, overrideReason: "   " },
    {
      listOpenIssues: async () => [
        openIssue({
          number: 712,
          title: "open engine",
          body: "loop-4d2de11c6c029a2f-s1 Blocker class: workflow-engine-defect",
        }),
      ],
      listTypedSoakEvidence: async () => [
        {
          issueNumber: 712,
          loopRunId: "loop-4d2de11c6c029a2f-s1",
          terminal: true,
          recovered: false,
          engineClass: true,
          blockerClass: "workflow-engine-defect",
        },
      ],
    },
  );
  assert.equal(result.ok, false);
});

test("created-since-previous-tag window is considered via label-fallback", async () => {
  // Without soak body linkage, post-tag window still evaluates under engine-class
  // rules: label-fallback (bug + pipeline:engine-class), not uncorroborated body text.
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 900,
        title: "post-tag engine defect without embedded loop id",
        body: "Blocker class: workflow-engine-defect\nterminal exhaustion",
        labels: [BUG_LABEL, ENGINE_CLASS_MARKER_LABEL],
        createdAt: "2026-07-30T10:00:00Z",
      }),
    ],
    listTypedSoakEvidence: async () => [],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.equal(result.blocking[0]!.issueNumber, 900);
  assert.equal(result.blocking[0]!.classificationSource, "label-fallback");
});

test("formatOpenSoakDefectWaiverSection lists issues and reason", () => {
  const section = formatOpenSoakDefectWaiverSection(
    { issueNumbers: [712, 714], reason: "accepted residual; tracked offline" },
    [
      { issueNumber: 712, title: "a", classificationSource: "typed" },
      { issueNumber: 714, title: "b", classificationSource: "label-fallback" },
    ],
  );
  assert.match(section, /#712/);
  assert.match(section, /#714/);
  assert.match(section, /accepted residual; tracked offline/);
  assert.match(section, /Open soak-defect override/);
});

test("formatOpenSoakDefectBlockMessage is doctor-grade", () => {
  const msg = formatOpenSoakDefectBlockMessage(BASE_INPUT, [
    { issueNumber: 712, title: "defect a", classificationSource: "typed", reasonKey: "workflow-engine-defect" },
  ]);
  assert.match(msg, /v1\.29\.1/);
  assert.match(msg, /#712/);
  assert.match(msg, /source: typed/);
  assert.match(msg, /--allow-open-soak-defects/);
});

test("issueReferencesSoak / label helpers", () => {
  const issue = openIssue({
    number: 1,
    title: "x",
    body: "mentions loop-abc",
    labels: [BUG_LABEL, ENGINE_CLASS_MARKER_LABEL],
    createdAt: "2026-07-30T00:00:00Z",
  });
  assert.equal(issueReferencesSoak(issue, ["loop-abc"]), true);
  assert.equal(issueReferencesSoak(issue, ["other"]), false);
  assert.equal(hasEngineClassLabelFallback(issue), true);
  assert.equal(issueInPostTagWindow(issue, "2026-07-29T00:00:00Z"), true);
  assert.equal(issueInPostTagWindow(issue, null), false);
  assert.equal(
    issueHasTypedEngineClassMarkers(
      openIssue({ number: 2, title: "t", body: "Blocker class: workflow-engine-defect" }),
    ),
    true,
  );
});

test("autoFileLabelsForCluster: engine-class durable-run-blocker gets three labels", () => {
  assert.deepEqual(
    autoFileLabelsForCluster({
      category: "durable-run-blocker",
      signal: "workflow-engine-defect",
      durableRunBlocker: {
        blockerClass: "workflow-engine-defect",
        fingerprint: "fp",
        terminal: true,
        itemIds: ["1"],
        suggestedMilestone: "x",
      },
    }),
    [BACKLOG_LABEL, BUG_LABEL, ENGINE_CLASS_MARKER_LABEL],
  );
  assert.equal(
    isEngineClassAutoFileCluster({
      category: "durable-run-blocker",
      signal: "environment-auth",
      durableRunBlocker: {
        blockerClass: "environment-auth",
        fingerprint: "fp",
        terminal: true,
        itemIds: ["1"],
        suggestedMilestone: "x",
      },
    }),
    false,
  );
  assert.deepEqual(
    autoFileLabelsForCluster({
      category: "durable-run-blocker",
      signal: "environment-auth",
      durableRunBlocker: {
        blockerClass: "environment-auth",
        fingerprint: "fp",
        terminal: true,
        itemIds: ["1"],
        suggestedMilestone: "x",
      },
    }),
    [BACKLOG_LABEL],
  );
});

test("autoFileLabelsForCluster: papercut engine signal vs ordinary papercut", () => {
  assert.deepEqual(
    autoFileLabelsForCluster({
      category: "papercut",
      signal: "workflow-engine-defect crash mid dispatch",
    }),
    [BACKLOG_LABEL, BUG_LABEL, ENGINE_CLASS_MARKER_LABEL],
  );
  assert.deepEqual(
    autoFileLabelsForCluster({
      category: "papercut",
      signal: "editor opened slowly",
    }),
    [BACKLOG_LABEL],
  );
});

test("typed evidence without issue number joins open issue by fingerprint", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 723,
        title: "Durable-run blocker: workflow-engine-defect:fp-join",
        body: "Evidence fingerprint: fp-join\nAffected run IDs\n- loop-4d2de11c6c029a2f-s1",
        labels: [], // labels missing — typed path must still block
      }),
    ],
    listTypedSoakEvidence: async (): Promise<TypedSoakEvidence[]> => [
      {
        issueNumber: null,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        fingerprint: "fp-join",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.equal(result.blocking[0]!.issueNumber, 723);
  assert.equal(result.blocking[0]!.classificationSource, "typed");
});

test("ledger join does not attribute terminal evidence via soak id alone", async () => {
  // Regression for b50dce47: terminal typed evidence without issueNumber must not
  // join every open issue that merely mentions the candidate soak run.
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 901,
        title: "unrelated product follow-up from same soak",
        body: [
          "Seen during soak loop-4d2de11c6c029a2f-s1",
          "Not the engine defect — product UX niggle only.",
        ].join("\n"),
        labels: [],
      }),
      openIssue({
        number: 902,
        title: "Durable-run blocker: workflow-engine-defect:fp-real",
        body: [
          "Evidence fingerprint: fp-real",
          "Affected run IDs",
          "- loop-4d2de11c6c029a2f-s1",
          "Blocker class: workflow-engine-defect",
        ].join("\n"),
        labels: [],
      }),
    ],
    listTypedSoakEvidence: async (): Promise<TypedSoakEvidence[]> => [
      {
        issueNumber: null,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        fingerprint: "fp-real",
        reasonKey: "terminal-engine-class",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0]!.issueNumber, 902);
  assert.equal(result.blocking[0]!.classificationSource, "typed");
  assert.ok(!result.blocking.some((b) => b.issueNumber === 901));
});

test("uncorroborated issue body markers for recovered intermediate do not block", async () => {
  // Regression for 6d2381fd: soak-linked open issue text with engine-class markers
  // is non-authoritative unless joined to terminal/recovery-exhaustion evidence.
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 910,
        title: "tracking: mid-run engine-adjacent that recovered",
        body: [
          "loop-4d2de11c6c029a2f-s1",
          "Blocker class: workflow-engine-defect",
          "disposition: engine-class",
          "Recovered in-run; item completed successfully.",
          "Evidence fingerprint: fp-recovered-mid",
        ].join("\n"),
        labels: [], // no label-fallback either
      }),
    ],
    listTypedSoakEvidence: async (): Promise<TypedSoakEvidence[]> => [
      {
        issueNumber: null,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: false,
        recovered: true,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        fingerprint: "fp-recovered-mid",
        title: "mid-run recovered",
        reasonKey: "recovered-intermediate",
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("issue body markers alone without terminal ledger evidence do not block as typed", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 911,
        title: "mentions engine defect markers only",
        body: "loop-4d2de11c6c029a2f-s1 Blocker class: workflow-engine-defect",
      }),
    ],
    listTypedSoakEvidence: async () => [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("closed fingerprint-matched issue clears null-issueNumber ledger evidence (no synthetic blocker)", async () => {
  // Regression for 4fb12f08: production typed projection always sets issueNumber
  // null. When the auto-filed issue was closed, open-list join fails and must
  // NOT fall through to a (no issue number) synthetic block.
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [],
    listClosedIssues: async () => [
      {
        number: 712,
        title: "Durable-run blocker: workflow-engine-defect:fp-closed",
        state: "CLOSED",
        labels: [BUG_LABEL, ENGINE_CLASS_MARKER_LABEL],
        body: [
          "Evidence fingerprint: fp-closed",
          "Affected run IDs",
          "- loop-4d2de11c6c029a2f-s1",
          "Blocker class: workflow-engine-defect",
        ].join("\n"),
        createdAt: "2026-07-28T00:00:00Z",
      },
    ],
    listTypedSoakEvidence: async (): Promise<TypedSoakEvidence[]> => [
      {
        issueNumber: null,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        fingerprint: "fp-closed",
        title: "durable-run blocker workflow-engine-defect:fp-closed",
        reasonKey: "workflow-engine-defect",
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("recovered typed evidence suppresses label-fallback on same issue", async () => {
  // Regression for 6d2381fd: candidate-linked typed evidence with
  // terminal:false recovered:true must suppress bug+engine-class label fallback.
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 920,
        title: "converged intermediate still labeled engine-class",
        body: [
          "Evidence fingerprint: fp-recovered-labels",
          "Affected run IDs",
          "- loop-4d2de11c6c029a2f-s1",
          "Blocker class: workflow-engine-defect",
          "Recovered in-run.",
        ].join("\n"),
        labels: [BUG_LABEL, ENGINE_CLASS_MARKER_LABEL, BACKLOG_LABEL],
        createdAt: "2026-07-30T12:00:00Z",
      }),
    ],
    listTypedSoakEvidence: async (): Promise<TypedSoakEvidence[]> => [
      {
        issueNumber: 920,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: false,
        recovered: true,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        fingerprint: "fp-recovered-labels",
        title: "mid-run recovered",
        reasonKey: "recovered-intermediate",
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("recovered typed evidence by fingerprint suppresses label-fallback without issueNumber", async () => {
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 921,
        title: "labels present after recovery",
        body: "Evidence fingerprint: fp-rec-fp-only\nloop-4d2de11c6c029a2f-s1",
        labels: [BUG_LABEL, ENGINE_CLASS_MARKER_LABEL],
        createdAt: "2026-07-30T12:00:00Z",
      }),
    ],
    listTypedSoakEvidence: async (): Promise<TypedSoakEvidence[]> => [
      {
        issueNumber: null,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: false,
        recovered: true,
        engineClass: true,
        fingerprint: "fp-rec-fp-only",
        title: "recovered",
        reasonKey: "recovered-intermediate",
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("unidentified terminal evidence does not join open issues by blocker class alone", async () => {
  // Regression for 08ff8421: terminal ledger evidence with neither issueNumber
  // nor fingerprint must not project onto soak-linked issues that merely share
  // the same blocker class / disposition (category-level, not defect identity).
  // Unmatched terminal evidence stays synthetic.
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 930,
        title: "earlier recovered same-class defect still open for tracking",
        body: [
          "loop-4d2de11c6c029a2f-s1",
          "Blocker class: workflow-engine-defect",
          "Recovered; tracking only.",
        ].join("\n"),
        labels: [],
        typedDisposition: "workflow-engine-defect",
      }),
      openIssue({
        number: 931,
        title: "unrelated same-class soak note",
        body: "loop-4d2de11c6c029a2f-s1\nBlocker class: workflow-engine-defect",
        labels: [],
      }),
    ],
    listTypedSoakEvidence: async (): Promise<TypedSoakEvidence[]> => [
      {
        issueNumber: null,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        title: "unlinked terminal engine defect",
        reasonKey: "terminal-engine-class",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0]!.issueNumber, null);
  assert.equal(result.blocking[0]!.classificationSource, "typed");
  assert.equal(result.blocking[0]!.title, "unlinked terminal engine defect");
  assert.ok(!result.blocking.some((b) => b.issueNumber === 930));
  assert.ok(!result.blocking.some((b) => b.issueNumber === 931));
});

test("unidentified recovered evidence does not suppress label-fallback by class alone", async () => {
  // Same identity rule for recovery projection: without issueNumber/fingerprint,
  // recovered evidence must not clear label-fallback on every same-class issue.
  const result = await runOpenSoakDefectPreflight(BASE_INPUT, {
    listOpenIssues: async () => [
      openIssue({
        number: 932,
        title: "still open engine-class labeled defect",
        body: "loop-4d2de11c6c029a2f-s1\nBlocker class: workflow-engine-defect",
        labels: [BUG_LABEL, ENGINE_CLASS_MARKER_LABEL],
        createdAt: "2026-07-30T12:00:00Z",
        typedDisposition: "workflow-engine-defect",
      }),
    ],
    listTypedSoakEvidence: async (): Promise<TypedSoakEvidence[]> => [
      {
        issueNumber: null,
        loopRunId: "loop-4d2de11c6c029a2f-s1",
        terminal: false,
        recovered: true,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        title: "recovered intermediate",
        reasonKey: "recovered-intermediate",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0]!.issueNumber, 932);
  assert.equal(result.blocking[0]!.classificationSource, "label-fallback");
});
