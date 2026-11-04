import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeProvider } from "./claude.ts";
import { claudeModels, claudeModelsFor } from "./claude-models.ts";
import { request } from "./test-support.ts";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});
const additional = "BABOJUBOT_CLAUDE_ADDITIONAL_MODELS";

it("lists real model versions instead of only the short family names", () => {
  const ids = claudeModels.map((m) => m.id);
  expect(ids).toContain("claude-opus-5-5");
  expect(ids).toContain("claude-sonnet-5-5");
  expect(ids).toContain("claude-haiku-5-5");
  expect(ids).toContain("claude-fable-5-1");
  expect(ids).not.toContain("opus");
  expect(new Set(ids).size).toBe(ids.length);
});

it("gives the built-in list to a connection with nothing added", () => {
  expect(createClaudeProvider({ dataDir: "/tmp/product" }).models).toEqual(
    claudeModels
  );
});

it("adds new models at the end, in the order written", () => {
  process.env[additional] = JSON.stringify([
    { id: "claude-mythos-5-1", label: "Mythos 5.1" },
    { id: "gateway/custom", label: "Custom" },
  ]);
  const models = claudeModelsFor("claude");
  expect(models.slice(0, claudeModels.length)).toEqual(claudeModels);
  expect(models.slice(claudeModels.length)).toEqual([
    { id: "claude-mythos-5-1", label: "Mythos 5.1" },
    { id: "gateway/custom", label: "Custom" },
  ]);
});

it("renames a built-in model in place when the ID is the same", () => {
  process.env[additional] = JSON.stringify([
    { id: "claude-opus-5-5", label: "Main model" },
  ]);
  const models = claudeModelsFor("claude");
  expect(models).toHaveLength(claudeModels.length);
  const at = claudeModels.findIndex((m) => m.id === "claude-opus-5-5");
  expect(models[at]).toEqual({ id: "claude-opus-5-5", label: "Main model" });
});

it.each(["not json", '{"id":"x","label":"X"}'])(
  "warns and keeps the built-in list when the setting is unusable: %s",
  (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[additional] = value;
    expect(claudeModelsFor("claude")).toEqual(claudeModels);
    expect(warn).toHaveBeenCalledOnce();
  }
);

it("skips only the unusable rows and warns about each", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env[additional] = JSON.stringify([
    { id: "kept", label: "Kept" },
    { id: "no-label" },
    "text",
  ]);
  expect(claudeModelsFor("claude").slice(claudeModels.length)).toEqual([
    { id: "kept", label: "Kept" },
  ]);
  expect(warn).toHaveBeenCalledTimes(2);
});

it("keeps the built-in name when a rename has nothing to show", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env[additional] = JSON.stringify([
    { id: "claude-opus-5-5", label: "   " },
  ]);
  expect(claudeModelsFor("claude")).toEqual(claudeModels);
  expect(warn).toHaveBeenCalledOnce();
});

it("reads the setting of that connection only", () => {
  process.env.BABOJUBOT_CLAUDE_WORK_ADDITIONAL_MODELS = JSON.stringify([
    { id: "work-only", label: "Work" },
  ]);
  expect(claudeModelsFor("claude")).toEqual(claudeModels);
  expect(claudeModelsFor("claude-work").at(-1)?.id).toBe("work-only");
});

it("hands the chosen ID to Claude unchanged, including a context suffix", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-claude-models-"));
  try {
    const fixture = path.join(root, "model.json");
    await writeFile(
      fixture,
      JSON.stringify({
        // 인수가 다르면 재생 프로그램이 실패로 끝나 실행 시도도 실패한다.
        argv: { "--model": "claude-opus-4-8[1m]" },
        steps: [
          { input: { type: "user" } },
          {
            frame: { type: "system", subtype: "init", session_id: "session" },
          },
          {
            frame: {
              type: "result",
              subtype: "success",
              session_id: "session",
            },
          },
          { exit: 0 },
        ],
      })
    );
    const provider = createClaudeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        fixture,
      ],
    });
    const result = await provider.adapter.execute(
      { ...request(), model: "claude-opus-4-8[1m]" },
      { signal: new AbortController().signal, emit: async () => {} }
    );
    expect(result.stopReason).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
