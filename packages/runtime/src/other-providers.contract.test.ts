import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { describeRuntimeContract } from "./runtime-contract.ts";
import { createAntigravityProvider } from "./providers/antigravity.ts";
import { createOpenCodeProvider } from "./providers/opencode.ts";
import { saying } from "./providers/test-support.ts";
const root = await mkdtemp(path.join(tmpdir(), "other-provider-contract-"));
afterAll(() => rm(root, { recursive: true, force: true }));
await mkdir(path.join(root, "providers/antigravity/.gemini"), {
  recursive: true,
});
await writeFile(
  path.join(root, "providers/antigravity/.gemini/oauth_creds.json"),
  "{}"
);
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
