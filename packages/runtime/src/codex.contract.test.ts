import { saying } from "./providers/test-support.ts";
import { describeRuntimeContract } from "./runtime-contract.ts";
import { createCodexProvider } from "./providers/codex.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
const dataDir = await mkdtemp(path.join(tmpdir(), "claude-contract-"));
afterAll(() => rm(dataDir, { recursive: true, force: true }));

for (const mode of ["app-server", "exec"] as const)
  describeRuntimeContract(
    `Codex ${mode} synthetic process (not recorded model evidence)`,
    {
      adapter: createCodexProvider({
        dataDir,
        mode,
        command: [
          process.execPath,
          path.resolve("test-fixtures/codex-simulator.mjs"),
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
      steers:
        mode === "exec"
          ? undefined
          : {
              scene: saying("끼워 넣기 연습"),
              took: ({ messages }, body) =>
                messages.some((m) => m.includes(body)),
            },
    }
  );
