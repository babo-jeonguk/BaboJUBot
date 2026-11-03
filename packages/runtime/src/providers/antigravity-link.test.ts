import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAntigravityProvider } from "./antigravity.ts";
import { request } from "./test-support.ts";

// 하드링크를 지원하지 않는 파일 시스템에서도 설정 파일을 쓴다.
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  link: async () => {
    throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
  },
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("writes the workspace configuration without hard links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-link-"));
  roots.push(root);
  await mkdir(path.join(root, "work"));
  const { adapter } = createAntigravityProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/quirky-cli.synthetic.mjs"),
      "antigravity",
      "plain",
    ],
  });
  const cwd = path.join(root, "work");
  const result = await adapter.execute(
    {
      ...request(),
      workspace: { cwd, organization: cwd, personal: cwd, peers: [] },
    },
    { signal: new AbortController().signal, emit: async () => {} }
  );
  expect(result.stopReason).toBe("completed");
});
