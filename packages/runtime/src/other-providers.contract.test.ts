import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { describeRuntimeContract } from "./runtime-contract.ts";
import { createAntigravityProvider } from "./providers/antigravity.ts";
import { createOpenCodeProvider } from "./providers/opencode.ts";
import { saying } from "./providers/test-support.ts";
const root = await mkdtemp(path.join(tmpdir(), "other-provider-contract-"));
afterAll(() => rm(root, { recursive: true, force: true }));
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
      adapter: provider.adapter,
      startupMs: 2000,
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
    adapter: createAntigravityProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/antigravity-simulator.mjs"),
        "--recording",
        path.resolve("test-fixtures/antigravity-recorded.json"),
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
        messages.some((message) => message.includes(note)),
    },
  }
);

describeRuntimeContract(
  "opencode with recorded protocol output (reviewed real frames, scripted behaviour)",
  {
    adapter: createOpenCodeProvider({
      dataDir: root,
      command: [
        process.execPath,
        path.resolve("test-fixtures/opencode-simulator.mjs"),
        "--recording",
        path.resolve("test-fixtures/opencode-recorded.json"),
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
        messages.some((message) => message.includes(note)),
    },
    steers: {
      scene: saying("끼워 넣기 연습"),
      took: ({ messages }, body) =>
        messages.some((message) => message.includes(body)),
    },
  }
);
