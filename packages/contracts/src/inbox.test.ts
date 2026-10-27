import { describe, expect, it } from "vitest";
import type { ApprovalStatus } from "./approval.ts";
import {
  awaitsDecision,
  canArchiveInboxItem,
  inboxFilters,
  needsAttention,
  type InboxItem,
} from "./inbox.ts";
import type { ResultSubmissionStatus } from "./result.ts";

const orgId = "00000000-0000-4000-8000-000000000001";
const at = "2026-10-27T00:00:00.000Z";
const state = { read: false, archived: false };

const approval = (status: ApprovalStatus, s = state): InboxItem => ({
  kind: "approval",
  organizationName: "조직",
  ...s,
  approval: {
    id: "00000000-0000-4000-8000-000000000002",
    organizationId: orgId,
    kind: "initial_research",
    status,
    requestedByAgentId: "00000000-0000-4000-8000-000000000003",
    previousApprovalId: null,
    createdAt: at,
    decidedAt: status === "pending" ? null : at,
  },
});
const submission = (status: ResultSubmissionStatus, s = state): InboxItem => ({
  kind: "result_submission",
  organizationName: "조직",
  ...s,
  submission: {
    id: "00000000-0000-4000-8000-000000000004",
    organizationId: orgId,
    status,
    submittedByAgentId: "00000000-0000-4000-8000-000000000003",
    submittedByRunId: "00000000-0000-4000-8000-000000000005",
    previousSubmissionId: null,
    createdAt: at,
    decidedAt: status === "pending" ? null : at,
  },
});
const failure = (s = state): InboxItem => ({
  kind: "run_failure",
  organizationName: "조직",
  ...s,
  agentName: "Research Lead",
  run: {
    id: "00000000-0000-4000-8000-000000000006",
    organizationId: orgId,
    agentId: "00000000-0000-4000-8000-000000000003",
    status: "failed",
    cancelReason: null,
    wakeCount: 1,
    summary: null,
    error: "사고",
    startedAt: at,
    finishedAt: at,
  },
});

describe("Inbox rules", () => {
  it("only pending approval requests and result submissions await a decision", () => {
    expect(awaitsDecision(approval("pending"))).toBe(true);
    expect(awaitsDecision(submission("pending"))).toBe(true);
    for (const status of ["approved", "rejected", "changes_requested"] as const)
      expect(awaitsDecision(approval(status))).toBe(false);
    for (const status of ["changes_requested", "completed"] as const)
      expect(awaitsDecision(submission(status))).toBe(false);
    expect(awaitsDecision(failure())).toBe(false);
  });

  it("can archive anything that does not await a decision", () => {
    expect(canArchiveInboxItem(approval("pending"))).toBe(false);
    expect(canArchiveInboxItem(submission("pending"))).toBe(false);
    expect(canArchiveInboxItem(approval("rejected"))).toBe(true);
    expect(canArchiveInboxItem(submission("completed"))).toBe(true);
    expect(canArchiveInboxItem(failure())).toBe(true);
  });

  it("keeps decided items in all but not in needs attention, even unread", () => {
    const decided = [approval("approved"), submission("changes_requested")];
    for (const item of decided) {
      expect(needsAttention(item)).toBe(false);
      expect(inboxFilters.all(item)).toBe(true);
      expect(inboxFilters.unread(item)).toBe(true);
      expect(inboxFilters.archived(item)).toBe(false);
    }
    const archived = approval("approved", { read: true, archived: true });
    expect(inboxFilters.all(archived)).toBe(false);
    expect(inboxFilters.archived(archived)).toBe(true);
  });

  it("needs attention for pending decisions even when read, and for unread unarchived failures", () => {
    expect(
      needsAttention(approval("pending", { read: true, archived: false }))
    ).toBe(true);
    expect(needsAttention(submission("pending"))).toBe(true);
    expect(needsAttention(failure())).toBe(true);
    expect(needsAttention(failure({ read: true, archived: false }))).toBe(
      false
    );
    expect(needsAttention(failure({ read: false, archived: true }))).toBe(
      false
    );
  });
});
