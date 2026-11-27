import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProviderConnection,
  RunRequest,
  RunResult,
} from "@babojubot/contracts";
import { settled } from "@babojubot/contracts";
import { runAcpSession, type AcpSessionOptions } from "./acp-session.ts";
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

/**
 * `runAcpSession`을 실행하면서 `folders.own`에 중단·종료 대기를 등록한다.
 * 시험이 실패하거나 중단돼도 자식이 끝난 뒤에만 임시 폴더를 지운다(CODING_STANDARDS.md#정리).
 */
export async function runOwnedAcpSession(
  folders: ReturnType<typeof testFolders>,
  options: AcpSessionOptions,
  runRequest: RunRequest,
  onEmit?: (activity: unknown, abort: () => void) => void
): Promise<{ result: RunResult; activity: unknown[] }> {
  const activity: unknown[] = [];
  const stop = new AbortController();
  const running = runAcpSession(options, runRequest, {
    signal: stop.signal,
    emit: async (item) => {
      activity.push(item);
      onEmit?.(item, () => stop.abort());
    },
  });
  folders.own(async () => {
    stop.abort();
    await settled(running);
  }, "an ACP session run");
  const result = await running;
  return { result, activity };
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
    onEmit?: (activity: unknown, abort: () => void) => void;
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
    workspace: { cwd: root, organization: root, personal: root, peers: [] },
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
    {
      logName: "TestAcp",
      dataDir: root,
      connectionId: "test-acp",
      command: [
        process.execPath,
        path.resolve("test-fixtures/replay.mjs"),
        fixture,
      ],
      args: ["acp"],
      env: { ...process.env },
    },
    runRequest,
    options.onEmit
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
      workspace: { cwd: root, organization: root, personal: root, peers: [] },
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
