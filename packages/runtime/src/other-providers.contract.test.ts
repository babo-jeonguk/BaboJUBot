import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, vi } from "vitest";
import { describeRuntimeContract } from "./runtime-contract.ts";
import { createAntigravityProvider as unownedAntigravityProvider } from "./providers/antigravity.ts";
import { createGrokProvider as unownedGrokProvider } from "./providers/grok.ts";
import { createOpenCodeProvider as unownedOpenCodeProvider } from "./providers/opencode.ts";
import { saying } from "./providers/test-support.ts";
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
const createOpenCodeProvider = folders.owning(unownedOpenCodeProvider);
const createAntigravityProvider = folders.owning(unownedAntigravityProvider);
const createGrokProvider = folders.owning(unownedGrokProvider);
const root = await folders.make("other-provider-contract-");
// `pnpm provider:login antigravity`가 남기는 자리(연결 폴더)에만 로그인이 있다. 실행 시도는 조직 폴더로 돌므로
// 이 로그인이 조직 실행에서 보여야 공통 검사(녹화 재생 포함)가 통과한다(#126).
const antigravityLogin = path.join(
  root,
  "providers/antigravity/.gemini/antigravity-cli/antigravity-oauth-token"
);
await mkdir(path.dirname(antigravityLogin), { recursive: true });
await writeFile(antigravityLogin, JSON.stringify({ synthetic: true }));
for (const kind of ["antigravity", "opencode"] as const) {
  const provider = (
    kind === "antigravity" ? createAntigravityProvider : createOpenCodeProvider
  )({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve(`test-fixtures/${kind}-simulator.mjs`),
    ],
  });
  describeRuntimeContract(
    `${kind} synthetic process (not recorded model evidence)`,
    {
      launches: "programs",
      adapter: provider.adapter,
      finishes: saying("진행 상황을 알려 주세요"),
      worksUntilCancelled: saying("실행 유지 연습"),
      unusableSession: { id: "expired" },
      resumes: {
        plant: (note) => saying(`메모해 주세요: ${note}`),
        recall: saying("세션 메모를 알려 주세요"),
        recalled: ({ messages }, note) =>
          messages.some((message) => message.includes(note)),
      },
      steers:
        kind === "opencode"
          ? {
              scene: saying("끼워 넣기 연습"),
              took: ({ messages }, body) =>
                messages.some((message) => message.includes(body)),
            }
          : undefined,
    }
  );
}

describeRuntimeContract(
  "antigravity with recorded protocol output (reviewed real frames, scripted behaviour)",
  {
    launches: "programs",
    adapter: createAntigravityProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/antigravity-simulator.mjs"),
        "--recording",
        path.resolve("test-fixtures/antigravity-recorded.json"),
      ],
    }).adapter,
    finishes: saying("진행 상황을 알려 주세요"),
    worksUntilCancelled: saying("실행 유지 연습"),
    unusableSession: { id: "expired" },
    resumes: {
      plant: (note) => saying(`메모해 주세요: ${note}`),
      recall: saying("세션 메모를 알려 주세요"),
      recalled: ({ messages }, note) =>
        messages.some((message) => message.includes(note)),
    },
  }
);

describeRuntimeContract(
  "opencode with recorded protocol output (reviewed real frames, scripted behaviour)",
  {
    launches: "programs",
    adapter: createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--recording",
        path.resolve("test-fixtures/opencode-recorded.json"),
      ],
    }).adapter,
    finishes: saying("진행 상황을 알려 주세요"),
    worksUntilCancelled: saying("실행 유지 연습"),
    unusableSession: { id: "expired" },
    resumes: {
      plant: (note) => saying(`메모해 주세요: ${note}`),
      recall: saying("세션 메모를 알려 주세요"),
      recalled: ({ messages }, note) =>
        messages.some((message) => message.includes(note)),
    },
    steers: {
      scene: saying("끼워 넣기 연습"),
      took: ({ messages }, body) =>
        messages.some((message) => message.includes(body)),
    },
  }
);

describeRuntimeContract(
  "grok synthetic process (not recorded model evidence)",
  {
    launches: "programs",
    adapter: createGrokProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/acp-simulator.ts"),
        "--acp-args",
        "agent,--no-leader,stdio",
        "--probe-args",
        "models",
        "--probe-stdout",
        "You are logged in with grok.com.\n  * simulated-model (default)",
        "--store",
        root,
      ],
    }).adapter,
    finishes: saying("진행 상황을 알려 주세요"),
    worksUntilCancelled: saying("실행 유지 연습"),
    unusableSession: { id: "expired" },
    resumes: {
      plant: (note) => saying(`메모해 주세요: ${note}`),
      recall: saying("세션 메모를 알려 주세요"),
      recalled: ({ messages }, note) =>
        messages.some((message) => message.includes(note)),
    },
  }
);
