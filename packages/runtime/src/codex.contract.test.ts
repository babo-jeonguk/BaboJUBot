import { saying } from "./providers/test-support.ts";
import { describeRuntimeContract } from "./runtime-contract.ts";
import { createCodexProvider as unownedCodexProvider } from "./providers/codex.ts";
import path from "node:path";
import { afterAll, vi } from "vitest";
import { testFolders } from "./providers/test-folders.ts";

// 실행 시도가 띄운 프로그램의 끝을 계약 시험이 신호로 본다(runtime-contract.ts 약속 2). 실행 시도의 프로그램(`startProcess`)과
// 공용 실행(`launchTree`·`runTree`)을 모두 본다.
vi.mock("./providers/process.ts", async (importOriginal) =>
  (await import("./providers/program-watch-support.ts")).watchPrograms(
    await importOriginal()
  )
);
vi.mock("@babojubot/process", async (importOriginal) =>
  (await import("./providers/program-watch-support.ts")).watchProcessPackage(
    await importOriginal()
  )
);
// 이 파일의 시험이 모두 끝난 뒤 정리가 지운다.
const folders = testFolders(afterAll);
// 이 파일이 만드는 프로바이더 연결은 모두 정리가 실행을 맡는다(시험 표에 담아 넘긴 factory도 같다).
const createCodexProvider = folders.owning(unownedCodexProvider);
const dataDir = await folders.make("claude-contract-");

for (const [mode, recorded] of [
  ["app-server", false],
  ["exec", false],
  ["app-server", true],
  ["exec", true],
] as const)
  describeRuntimeContract(
    recorded
      ? `Codex ${mode} with recorded protocol output (reviewed real frames, scripted behaviour)`
      : `Codex ${mode} synthetic process (not recorded model evidence)`,
    {
      launches: "programs",
      adapter: createCodexProvider({
        dataDir,
        mode,
        command: [
          process.execPath,
          path.resolve("test-fixtures/codex-simulator.mjs"),
          ...(recorded
            ? [
                "--recording",
                path.resolve(`test-fixtures/codex-${mode}-recorded.json`),
              ]
            : []),
        ],
      }).adapter,
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
