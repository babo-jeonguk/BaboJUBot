import type { Event, RunEndReason } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  notificationContent,
  notificationOf as notificationOfStored,
  retryDelayMs,
} from "./notification.ts";

/** 저장 전 Event를 종류마다 나눈 것. 종류와 payload가 서로 맞아야 한다. */
type Unstored<E = Event> = E extends unknown
  ? Omit<E, "id" | "createdAt">
  : never;
const notificationOf = (event: Unstored) =>
  notificationOfStored({
    id: 1,
    createdAt: "2026-10-23T00:00:00.000Z",
    ...event,
  });

const org = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const run = "00000000-0000-4000-8000-000000000003";
const source = "00000000-0000-4000-8000-000000000004";

const finished = (stopReason: RunEndReason): Unstored => ({
  organizationId: org,
  type: "run.finished",
  payload: {
    runId: run,
    agentId: agent,
    stopReason,
    summary: null,
    error: "오류",
  },
});

describe("notificationOf", () => {
  it("picks the Lead's conversation messages, not the owner's", () => {
    const message = (author: "agent" | "owner"): Unstored => ({
      organizationId: org,
      type: "message.created",
      payload: {
        messageId: source,
        agentId: agent,
        conversationId: "conversation-1",
        author,
        runId: author === "agent" ? run : null,
      },
    });
    expect(notificationOf(message("agent"))).toEqual({
      kind: "lead_message",
      sourceId: source,
    });
    expect(notificationOf(message("owner"))).toBeNull();
  });

  it("picks both kinds of approval request and result submissions", () => {
    for (const kind of ["initial_research", "add_worker"] as const)
      expect(
        notificationOf({
          organizationId: org,
          type: "approval.requested",
          payload: {
            approvalId: source,
            kind,
            runId: run,
            agentId: agent,
            stage: "awaiting_approval",
          },
        })
      ).toEqual({ kind: "approval_request", sourceId: source });
    expect(
      notificationOf({
        organizationId: org,
        type: "result.submitted",
        payload: {
          submissionId: source,
          runId: run,
          agentId: agent,
          artifactIds: [],
          stage: "result_review",
        },
      })
    ).toEqual({ kind: "result_submission", sourceId: source });
  });

  it("counts only failed runs as failures", () => {
    expect(notificationOf(finished("failed"))).toEqual({
      kind: "run_failure",
      sourceId: run,
    });
    for (const reason of ["completed", "cancelled", "server_restart"] as const)
      expect(notificationOf(finished(reason))).toBeNull();
  });

  it("ignores other Events", () => {
    expect(
      notificationOf({
        organizationId: org,
        type: "approval.decided",
        payload: {
          approvalId: source,
          kind: "add_worker",
          by: "owner",
          decision: "approve",
          note: null,
          stage: "researching",
          createdAgentIds: [],
          wokenAgentId: agent,
        },
      })
    ).toBeNull();
  });
});

describe("notificationContent", () => {
  it("links a Lead message to the conversation it belongs to", () => {
    expect(
      notificationContent("org-1", "msg-1", {
        kind: "lead_message",
        body: "보고",
        conversationId: "conversation-2",
      })
    ).toEqual({
      title: "Research Lead 메시지",
      body: "보고",
      link: "/orgs/org-1/chat/conversation-2",
    });
  });
});

describe("retryDelayMs", () => {
  it("doubles from one second and stops growing at five minutes", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    expect(retryDelayMs(30)).toBe(300_000);
  });
});
