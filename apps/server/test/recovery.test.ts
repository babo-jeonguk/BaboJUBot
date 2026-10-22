import { spawn } from "node:child_process";
import path from "node:path";
import { once } from "node:events";
import {
  conversationMessageListSchema,
  organizationDetailSchema,
  runDetailSchema,
  runSummaryListSchema,
} from "@babojubot/contracts";
import { createTestDatabase, type TestDatabase } from "@babojubot/db/testing";
import { createScriptedRuntime, leadReplyScript } from "@babojubot/runtime";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.ts";

// 서버 재시작 복구. 실행 중 서버가 멈추면 그 실행 시도는 `server_restart`로 끝나고, 받은 깨우기는 다시 처리되어 새 실행 시도가 생긴다.

let database: TestDatabase | undefined;
let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  await database?.close();
  database = undefined;
});

const api = (base: () => string) => {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base() + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    async organization(name: string) {
      const org = organizationDetailSchema.parse(
        (await call("POST", "/api/organizations", { name })).body
      );
      return { id: org.id, lead: org.agents.find((a) => a.role === "lead")! };
    },
    async say(orgId: string, body: string) {
      expect(
        (await call("POST", `/api/organizations/${orgId}/messages`, { body }))
          .status
      ).toBe(201);
    },
    runs: async (orgId: string) =>
      runSummaryListSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/runs`)).body
      ),
    run: async (orgId: string, runId: string) =>
      runDetailSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/runs/${runId}`)).body
      ),
    conversation: async (orgId: string) =>
      conversationMessageListSchema.parse(
        (await call("GET", `/api/organizations/${orgId}/messages`)).body
      ),
  };
};

describe("server restart recovery", () => {
  it("ends a run the server stopped during as a server restart and hands its wakes to a new run after the restart", async () => {
    database = await createTestDatabase();
    const gate = createGate();
    server = await startServer({
      db: database.db,
      port: 0,
      runtime: createScriptedRuntime({
        select: () => ({
          ...leadReplyScript,
          steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
        }),
      }),
    });
    const http = api(() => server!.url);
    const org = await http.organization("재시작 조직");
    await http.say(org.id, "재시작 뒤에도 처리해 줘");
    await gate.reached;
    const [interrupted] = await http.runs(org.id);

    await server.close();
    server = await startServer({ db: database.db, port: 0 });
    await server.drain();

    const [next, old] = await http.runs(org.id);
    expect(old).toMatchObject({
      id: interrupted!.id,
      status: "server_restart",
      wakeCount: 1,
    });
    expect(next).toMatchObject({ status: "completed", wakeCount: 1 });
    const [before, after] = await Promise.all([
      http.run(org.id, old!.id),
      http.run(org.id, next!.id),
    ]);
    expect(after.wakeReasons).toEqual(before.wakeReasons);
    expect(
      (await http.conversation(org.id)).map((m) => [
        m.author,
        m.deliveredToRunId,
      ])
    ).toEqual([
      ["owner", next!.id],
      ["agent", null],
    ]);
  });

  it("recovers after the server process is killed mid-run without repeating the reply it already sent", async () => {
    database = await createTestDatabase();
    const child = spawn(
      process.execPath,
      [
        path.join(import.meta.dirname, "fixtures/crash-server.ts"),
        database.url,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    try {
      const [line] = (await once(child.stdout!, "data")) as [Buffer];
      const crashed = JSON.parse(String(line)) as { url: string };
      const http = api(() => crashed.url);
      const org = await http.organization("crash 조직");
      await http.say(org.id, "답장하고 멈춰");
      // 답장이 commit된 뒤에 프로세스를 죽인다.
      for (let i = 0; ; i++) {
        if ((await http.conversation(org.id)).length === 2) break;
        if (i > 200) throw new Error("the reply never arrived");
        await new Promise((r) => setTimeout(r, 25));
      }
      child.kill("SIGKILL");
      await once(child, "exit");

      // 다시 시작한 서버의 Lead는 crash 전과 같은 답장 시나리오다.
      server = await startServer({
        db: database.db,
        port: 0,
        runtime: createScriptedRuntime({ select: () => leadReplyScript }),
      });
      await server.drain();
      const restarted = api(() => server!.url);
      const [next, old] = await restarted.runs(org.id);
      expect(old).toMatchObject({ status: "server_restart", wakeCount: 1 });
      expect(old!.error).toContain("서버가 멈춰");
      expect(next).toMatchObject({ status: "completed", wakeCount: 1 });
      // 새 실행 시도는 같은 깨우기를 받아 같은 답장을 보내지만, 같은 호출 키라 이미 남긴 답장을 돌려받는다.
      const conversation = await restarted.conversation(org.id);
      expect(conversation.map((m) => m.author)).toEqual(["owner", "agent"]);
      expect(conversation[1]!.sentByRunId).toBe(old!.id);
      const detail = await restarted.run(org.id, next!.id);
      expect(
        detail.transcript.some(
          (e) =>
            e.type === "run.activity" &&
            e.payload.activity.source === "control_plane" &&
            e.payload.activity.activity.summary.includes("다시 돌려줌")
        )
      ).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });
});
