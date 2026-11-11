import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  orgToolNames,
  orgTools,
  ownerFacingFieldNote,
  splitOrgToolInput,
} from "./tools.ts";

const hangul = /[ㄱ-ㆎ가-힣]/;

const inputSchemaOf = (tool: (typeof orgToolNames)[number]) =>
  z.toJSONSchema(orgTools[tool].input, { io: "input" }) as {
    properties?: Record<string, { description?: string }>;
  };

describe("organization tool list", () => {
  it("describes every tool and every input field in English for the model", () => {
    for (const tool of orgToolNames) {
      expect(orgTools[tool].description, tool).not.toBe("");
      expect(orgTools[tool].description, tool).not.toMatch(hangul);
      // 도구 설명은 돌려주는 것을 말한다(#86 「도구 설명과 지침의 분담」).
      expect(orgTools[tool].description, tool).toMatch(/\breturns\b/i);
      for (const [field, schema] of Object.entries(
        inputSchemaOf(tool).properties ?? {}
      )) {
        expect(schema.description, `${tool}.${field}`).toBeTruthy();
        expect(schema.description, `${tool}.${field}`).not.toMatch(hangul);
      }
    }
  });

  it("asks for Korean only in the fields the Owner reads", () => {
    const marked = orgToolNames.flatMap((tool) =>
      Object.entries(inputSchemaOf(tool).properties ?? {}).flatMap(
        ([field, schema]) =>
          schema.description?.endsWith(` ${ownerFacingFieldNote}`)
            ? [`${tool}.${field}`]
            : []
      )
    );
    expect(marked).toEqual(
      orgToolNames.flatMap((tool) =>
        orgTools[tool].ownerFacing.map((field) => `${tool}.${field}`)
      )
    );
    // 에이전트끼리 주고받는 글과 기억은 영어다.
    expect(marked).not.toContain("message_agent.body");
    expect(marked).not.toContain("write_memory.content");
    expect(marked).toContain("send_message.body");
  });

  it("takes the path variables as part of the one input", () => {
    for (const tool of orgToolNames) {
      const { path, params } = orgTools[tool];
      expect(
        [...path.matchAll(/:(\w+)/g)].map((m) => m[1]),
        tool
      ).toEqual(params);
      for (const name of params)
        expect(inputSchemaOf(tool).properties?.[name], tool).toBeDefined();
    }
    const taskId = crypto.randomUUID();
    expect(
      orgTools.complete_task.input.safeParse({ taskId, summary: "done" })
        .success
    ).toBe(true);
    expect(
      orgTools.complete_task.input.safeParse({ summary: "done" }).success
    ).toBe(false);
    expect(
      splitOrgToolInput("complete_task", { taskId: "a/b", summary: "done" })
    ).toEqual({ path: "/tasks/a%2Fb/complete", rest: { summary: "done" } });
  });

  it("derives reads and writes from the HTTP method", () => {
    const reads = orgToolNames.filter((t) => orgTools[t].method === "GET");
    expect(reads.every((t) => /^(get|list|recall)_/.test(t))).toBe(true);
    expect(
      orgToolNames
        .filter((t) => !reads.includes(t))
        .some((t) => /^(get|list|recall)_/.test(t))
    ).toBe(false);
  });
});

// #147: 대상 upstream이 `\0` 표기의 pattern을 담은 도구 정의 요청을 HTTP 400으로 거부했고, 같은 뜻의 `\x00` 표기는 받아들였다.
describe("record_artifact path rule (#147)", () => {
  const input = orgTools.record_artifact.input;
  const base = {
    taskId: "8d0f4c1e-5b7a-4d2e-9a3c-1f2e3d4c5b6a",
    title: "근거",
  };

  it("exports the NUL exclusion in the \\x00 form the target upstream accepts", () => {
    const path = (
      z.toJSONSchema(input) as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.path!;
    expect(path).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 4096,
      pattern: "^[^\\x00]*$",
    });
    expect(JSON.stringify(path.pattern)).toBe(String.raw`"^[^\\x00]*$"`);
    expect(String(path.pattern)).not.toContain("\\0");
  });

  it("still refuses a real NUL and accepts ordinary, absolute, Korean and digit-zero paths", () => {
    for (const path of [
      "out/report.md",
      "/home/user/work/report.md",
      "결과/보고서.md",
      "data/0/v0.0.csv",
      "0",
    ])
      expect(input.safeParse({ ...base, path }).success, path).toBe(true);
    for (const path of ["a\0b", "\0", "report.md\0.txt"])
      expect(input.safeParse({ ...base, path }).success, path).toBe(false);
  });

  it("keeps the length and field-combination rules", () => {
    expect(input.safeParse({ ...base, path: "" }).success).toBe(false);
    expect(input.safeParse({ ...base, path: "a".repeat(4096) }).success).toBe(
      true
    );
    expect(input.safeParse({ ...base, path: "a".repeat(4097) }).success).toBe(
      false
    );
    expect(
      input.safeParse({ ...base, path: "a.md", format: "text", content: "x" })
        .success
    ).toBe(false);
    expect(
      input.safeParse({ ...base, format: "text", content: "x" }).success
    ).toBe(true);
    expect(input.safeParse({ ...base }).success).toBe(false);
  });
});
