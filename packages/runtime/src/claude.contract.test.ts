import { saying } from "./providers/test-support.ts";
import { describeRuntimeContract } from "./runtime-contract.ts";
import { createClaudeProvider as unownedClaudeProvider } from "./providers/claude.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll } from "vitest";
import { testFolders } from "./providers/test-folders.ts";
// 이 파일의 시험이 모두 끝난 뒤 정리가 지운다.
const folders = testFolders(afterAll);
// 이 파일이 만드는 프로바이더 연결은 모두 정리가 실행을 맡는다(시험 표에 담아 넘긴 factory도 같다).
const createClaudeProvider = folders.owning(unownedClaudeProvider);
const dataDir = await folders.make("claude-contract-");
await mkdir(path.join(dataDir, "providers/claude"), { recursive: true });
await writeFile(
  path.join(dataDir, "providers/claude/setup-token"),
  "synthetic-login",
  { mode: 0o600 }
);

for (const recorded of [false, true])
  describeRuntimeContract(
    recorded
      ? "Claude with recorded protocol output (reviewed real frames, scripted behaviour)"
      : "Claude synthetic process (not recorded model evidence)",
    {
      adapter: createClaudeProvider({
        dataDir,
        command: [
          process.execPath,
          path.resolve("test-fixtures/claude-simulator.mjs"),
          ...(recorded
            ? [
                "--recording",
                path.resolve("test-fixtures/claude-recorded.json"),
              ]
            : []),
        ],
      }).adapter,
      startupMs: 2000,
      finishes: saying("진행 상황을 알려 주세요"),
      worksUntilCancelled: saying("실행 유지 연습"),
      unusableSession: { id: "expired" },
      resumes: {
        plant: (note) => saying(`메모해 주세요: ${note}`),
        recall: saying("세션 메모를 알려 주세요"),
        recalled: ({ messages }, note) =>
          messages.some((m) => m.includes(note)),
      },
      steers: {
        scene: saying("끼워 넣기 연습"),
        took: ({ messages }, body) => messages.some((m) => m.includes(body)),
      },
    }
  );
