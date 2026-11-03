import { saying } from "./providers/test-support.ts";
import { describeRuntimeContract } from "./runtime-contract.ts";
import { createClaudeProvider } from "./providers/claude.ts";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
const dataDir = await mkdtemp(path.join(tmpdir(), "claude-contract-"));
await mkdir(path.join(dataDir, "providers/claude"), { recursive: true });
await writeFile(
  path.join(dataDir, "providers/claude/setup-token"),
  "synthetic-login",
  { mode: 0o600 }
);
afterAll(() => rm(dataDir, { recursive: true, force: true }));

describeRuntimeContract(
  "Claude synthetic process (not recorded model evidence)",
  {
    adapter: createClaudeProvider({
      dataDir,
      command: [
        process.execPath,
        path.resolve("test-fixtures/claude-simulator.mjs"),
      ],
    }).adapter,
    finishes: saying("진행 상황을 알려 주세요"),
    worksUntilCancelled: saying("실행 유지 연습"),
    unusableSession: { id: "expired" },
    resumes: {
      plant: (note) => saying(`메모해 주세요: ${note}`),
      recall: saying("세션 메모를 알려 주세요"),
      recalled: ({ messages }, note) => messages.some((m) => m.includes(note)),
    },
    steers: {
      scene: saying("끼워 넣기 연습"),
      took: ({ messages }, body) => messages.some((m) => m.includes(body)),
    },
  }
);
