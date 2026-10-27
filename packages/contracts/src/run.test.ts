import { describe, expect, it } from "vitest";
import {
  markConversationReadInputSchema,
  sendAgentMessageInputSchema,
  sendOwnerMessageInputSchema,
} from "./message.ts";
import { runResultSchema, runtimeActivitySchema } from "./run.ts";

describe("runtimeActivitySchema", () => {
  it("accepts the public activity kinds", () => {
    expect(
      runtimeActivitySchema.parse({ type: "progress", text: " 읽는 중 " })
    ).toEqual({ type: "progress", text: "읽는 중" });
    expect(
      runtimeActivitySchema.safeParse({
        type: "tool_use",
        tool: "grep",
        summary: "로그 검색",
      }).success
    ).toBe(true);
  });

  it("rejects private or unknown output", () => {
    for (const activity of [
      { type: "thinking", text: "내부 추론" },
      { type: "stdout", text: "raw" },
      { type: "progress", text: "ok", reasoning: "숨긴 추론" },
      { type: "progress", text: "ok", runId: crypto.randomUUID() },
      "progress",
    ])
      expect(
        runtimeActivitySchema.safeParse(activity).success,
        JSON.stringify(activity)
      ).toBe(false);
  });
});

describe("runResultSchema", () => {
  it("requires an explicit stop reason", () => {
    const result = {
      error: null,
      summary: null,
      usage: null,
      nextSession: null,
    };
    expect(runResultSchema.safeParse(result).success).toBe(false);
    expect(
      runResultSchema.safeParse({ ...result, stopReason: "completed" }).success
    ).toBe(true);
    expect(
      runResultSchema.safeParse({ ...result, stopReason: "timed_out" }).success
    ).toBe(false);
  });
});

describe("message inputs", () => {
  it("defaults owner messages to the next run", () => {
    expect(sendOwnerMessageInputSchema.parse({ body: " 안녕 " })).toEqual({
      body: "안녕",
      delivery: "next_run",
    });
  });

  it("has no organization or recipient selector", () => {
    for (const extra of [
      { organizationId: crypto.randomUUID() },
      { agentId: crypto.randomUUID() },
    ]) {
      expect(
        sendOwnerMessageInputSchema.safeParse({ body: "x", ...extra }).success
      ).toBe(false);
      expect(
        sendAgentMessageInputSchema.safeParse({ body: "x", ...extra }).success
      ).toBe(false);
    }
  });

  it("lets the Lead name the conversation it replies to, and the owner pick a conversation only by path", () => {
    const conversationId = crypto.randomUUID();
    expect(
      sendAgentMessageInputSchema.parse({ body: "답", conversationId })
    ).toEqual({ body: "답", conversationId });
    expect(sendAgentMessageInputSchema.parse({ body: "답" })).toEqual({
      body: "답",
    });
    expect(
      sendAgentMessageInputSchema.safeParse({
        body: "답",
        conversationId: "default",
      }).success
    ).toBe(false);
    expect(
      sendOwnerMessageInputSchema.safeParse({ body: "x", conversationId })
        .success
    ).toBe(false);
  });

  it("marks a conversation read only up to a message", () => {
    expect(
      markConversationReadInputSchema.safeParse({
        upToMessageId: crypto.randomUUID(),
      }).success
    ).toBe(true);
    expect(
      markConversationReadInputSchema.safeParse({
        upToMessageId: crypto.randomUUID(),
        unread: true,
      }).success
    ).toBe(false);
  });
});
