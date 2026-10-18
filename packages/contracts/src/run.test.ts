import { describe, expect, it } from "vitest";
import {
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
});
