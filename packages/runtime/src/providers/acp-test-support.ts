import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProviderConnection,
  RunRequest,
  RunResult,
} from "@babojubot/contracts";
import { settled } from "@babojubot/contracts";
import { runAcpSession, type AcpSessionOptions } from "./acp-session.ts";
import { record } from "./record.ts";
import { request } from "./test-support.ts";
import type { testFolders } from "./test-folders.ts";

export const acpRpc = (id: number, body: Record<string, unknown>) => ({
  frame: { jsonrpc: "2.0", id, ...body },
});

export const acpOrganizationMcp = {
  mcpServers: [
    {
      type: "http",
      name: "organization",
      url: "http://127.0.0.1:1/api/tools/mcp",
      headers: [{ name: "Authorization", value: "Bearer private-run-token" }],
    },
  ],
};

export const acpOpening = [
  { input: { method: "initialize" } },
  acpRpc(1, { result: { protocolVersion: 1 } }),
  { input: { method: "session/new", params: acpOrganizationMcp } },
  acpRpc(2, { result: { sessionId: "saved" } }),
];

/** 시험용 임시 작업 폴더 구성을 만든다. */
export const acpWorkspace = (
  root: string,
  cwd = root
): NonNullable<RunRequest["workspace"]> => ({
  cwd,
  organization: root,
  personal: root,
  peers: [],
});

/** 공용 `TestAcp` 세션 실행 옵션을 만든다. */
export const testAcpSessionOptions = (
  root: string,
  command: readonly [string, ...string[]]
): AcpSessionOptions => ({
  logName: "TestAcp",
  dataDir: root,
  connectionId: "test-acp",
  command,
  args: ["acp"],
  env: { ...process.env },
});

/**
 * `runAcpSession`을 실행하면서 `folders.own`에 중단·종료 대기를 등록한다.
 * 시험이 실패하거나 중단돼도 자식이 끝난 뒤에만 임시 폴더를 지운다(CODING_STANDARDS.md#정리).
 */
export async function runOwnedAcpSession(
  folders: ReturnType<typeof testFolders>,
  options: AcpSessionOptions,
  runRequest: RunRequest,
  controller?: AbortController
): Promise<{ result: RunResult; activity: unknown[] }> {
  const activity: unknown[] = [];
  const stop = controller ?? new AbortController();
  const running = runAcpSession(options, runRequest, {
    signal: stop.signal,
    emit: async (item) => {
      activity.push(item);
    },
  });
  folders.own(async () => {
    stop.abort();
    await settled(running);
  }, "an ACP session run");
  const result = await running;
  return { result, activity };
}

/**
 * 수신한 모든 JSON-RPC 프레임을 파일에 기록하는 합성 ACP peer 스크립트를 만든다.
 * 실패·취소 경로에서도 peer가 실제로 받은 메서드와 응답을 직접 단언할 수 있게 한다.
 */
export async function writeRecordingAcpPeer(
  root: string,
  options: {
    expectedArgs?: readonly string[];
    body: string;
  }
): Promise<{ script: string; logFile: string }> {
  const script = path.join(root, "recording-acp-peer.mjs");
  const logFile = path.join(root, "received-frames.jsonl");
  const argCheck = options.expectedArgs
    ? [
        `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(options.expectedArgs))}) {`,
        "  process.exitCode = 24;",
        "  throw new Error('unexpected argv');",
        "}",
      ]
    : [];
  await writeFile(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      ...argCheck,
      `const logFile = ${JSON.stringify(logFile)};`,
      "const out = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');",
      "let promptId;",
      "for await (const line of createInterface({ input: process.stdin })) {",
      "  if (!line.trim()) continue;",
      "  appendFileSync(logFile, line + '\\n');",
      "  const msg = JSON.parse(line);",
      options.body,
      "}",
      "",
    ].join("\n")
  );
  return { script, logFile };
}

/** `writeRecordingAcpPeer`가 기록한 JSON-RPC 프레임 목록을 읽는다. */
export async function readRecordedFrames(
  logFile: string
): Promise<Record<string, unknown>[]> {
  const text = await readFile(logFile, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => record(JSON.parse(line)));
}

/** 공용 ACP replay 실행기. `runOwnedAcpSession`으로 자식 수명을 소유한다. */
export async function runAcpSessionReplay(
  folders: ReturnType<typeof testFolders>,
  options: {
    prefix: string;
    steps:
      | Record<string, unknown>[]
      | ((context: {
          root: string;
          realRoot: string;
          runRequest: RunRequest;
        }) => Record<string, unknown>[]);
    patch?: Partial<RunRequest>;
  }
): Promise<{
  result: RunResult;
  activity: unknown[];
  root: string;
  realRoot: string;
  runRequest: RunRequest;
}> {
  const root = await folders.make(options.prefix);
  const realRoot = await realpath(root);
  const runRequest: RunRequest = {
    ...request(),
    workspace: acpWorkspace(root),
    ...options.patch,
  };
  const steps =
    typeof options.steps === "function"
      ? options.steps({ root, realRoot, runRequest })
      : options.steps;
  const fixture = path.join(root, "fixture.json");
  await writeFile(fixture, JSON.stringify({ argv: { acp: true }, steps }));
  const { result, activity } = await runOwnedAcpSession(
    folders,
    testAcpSessionOptions(root, [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      fixture,
    ]),
    runRequest
  );
  return { result, activity, root, realRoot, runRequest };
}

/** 프로바이더 factory(`folders.owning`으로 감싼 것)로 replay를 한 번 실행한다. */
export async function runProviderAcpReplay(
  folders: ReturnType<typeof testFolders>,
  createProvider: (options: {
    dataDir: string;
    command?: readonly [string, ...string[]];
  }) => ProviderConnection,
  options: {
    prefix: string;
    argv: Record<string, unknown>;
    steps: Record<string, unknown>[];
    patch?: Partial<RunRequest>;
  }
): Promise<{ result: RunResult; activity: unknown[] }> {
  const root = await folders.make(options.prefix);
  const fixture = path.join(root, "fixture.json");
  await writeFile(
    fixture,
    JSON.stringify({ argv: options.argv, steps: options.steps })
  );
  const activity: unknown[] = [];
  const result = await createProvider({
    dataDir: root,
    command: [
      process.execPath,
      path.resolve("test-fixtures/replay.mjs"),
      fixture,
    ],
  }).adapter.execute(
    {
      ...request(),
      ...options.patch,
      workspace: acpWorkspace(root),
    },
    {
      signal: new AbortController().signal,
      emit: async (item) => {
        activity.push(item);
      },
    }
  );
  return { result, activity };
}
