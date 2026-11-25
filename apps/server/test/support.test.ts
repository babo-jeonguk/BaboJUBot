import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeFolder } from "@babojubot/process/remove-folder";
import { folderCleanup } from "@babojubot/process/test-cleanup";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Event, ProviderConnection } from "@babojubot/contracts";
import { createFakeProviders } from "@babojubot/runtime";
import { WebSocketServer, type WebSocket } from "ws";
import {
  eventuallyMs,
  openEventStream,
  startTestServer,
  within,
} from "./support.ts";

// 시험 서버 helper가 서버를 넘기기 전에 실패하면, 자기가 만든 것(서버·DB·작업 폴더)을 치우고 원래 오류로 실패한다.
// 작업 폴더는 운영체제 임시 폴더에 만들므로, 이 시험만의 임시 폴더를 운영체제 임시 폴더로 정해 남은 것을 본다.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * helper가 만드는 임시 폴더가 이 시험의 폴더 안에 생기게 한다. Node는 POSIX에서 TMPDIR, Windows에서 TEMP·TMP를 읽는다.
 * 폴더는 만든 직후 시험 정리에 맡긴다. 그 안에서 도는 것(서버)은 `own`으로 맡기면 그 끝을 확인한 뒤에만 폴더를 지운다(`folderCleanup`).
 */
async function ownTemporaryFolder() {
  const temp = await mkdtemp(path.join(tmpdir(), "babojubot-support-"));
  const folder = folderCleanup(() => removeFolder(temp));
  onTestFinished(folder.cleanUp);
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, temp);
  return { temp, own: folder.own };
}

it("removes the workspace folder it made and keeps the start error when the server cannot start", async () => {
  const { temp } = await ownTemporaryFolder();
  // 알림 채널이 하나가 아니면 서버는 아무것도 띄우기 전에 거절한다.
  await expect(startTestServer({ notificationChannels: [] })).rejects.toThrow(
    "exactly one notification channel is supported, got 0"
  );
  expect(await readdir(temp)).toEqual([]);
});

it("closes the started server and removes its folder when the readiness check before handing it over fails", async () => {
  const { temp } = await ownTemporaryFolder();
  // 서버는 떴지만 준비 확인의 응답이 깨졌다.
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("not json")
  );
  await expect(startTestServer()).rejects.toThrow(SyntaxError);
  expect(await readdir(temp)).toEqual([]);
});

it("leaves a workspace folder it was given when the server cannot start", async () => {
  const { temp } = await ownTemporaryFolder();
  const given = await mkdtemp(path.join(temp, "given-"));
  await expect(
    startTestServer({ notificationChannels: [], dataDir: given })
  ).rejects.toThrow("exactly one notification channel is supported, got 0");
  expect(await readdir(temp)).toEqual([path.basename(given)]);
});

it("fails naming what it waited for and cleans up when the startup readiness check does not finish within its limit", async () => {
  const { temp } = await ownTemporaryFolder();
  // 준비 확인을 시험이 붙잡아 끝나지 않게 한다. 상한 0이면 첫 확인에서 상한이 지나므로 실행기 속도와 상관없이 상한에 걸린다.
  const [fake] = createFakeProviders(1);
  const held: ProviderConnection = {
    ...fake!,
    id: "held",
    adapter: {
      ...fake!.adapter,
      // 서버를 닫으면 멈춤 신호로 끝난다.
      checkReadiness: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        ),
    },
  };
  const failure = await startTestServer({
    providers: [held],
    readinessSettleMs: 0,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(AggregateError);
  expect((failure as Error).message).toMatch(
    /^the test server's providers did not finish their startup readiness check in 0ms: (held \((checking|not_checked)\)|no answer from GET \/api\/providers yet)$/
  );
  // 넘기기 전 실패의 정리를 모두 마쳤다(정리 실패가 없어 원래 오류 그대로다). 작업 폴더는 서버가 닫힌 것을 확인한 뒤에만 지운다.
  expect(await readdir(temp)).toEqual([]);
});

// 서버의 끝을 확인하지 못하면 그 서버가 쓰는 DB와 작업 폴더를 닫거나 지우지 않는다(#294 외부 리뷰 5회차 STD-4-R1). 서버 닫기의 한 단계(알림
// 채널 닫기)를 실패시킨다. 서버의 닫기는 다시 부를 수 없으므로(이미 닫은 부분에서 실패한다), helper의 정리는 끄기가 실패한 서버를 닫힌 것으로
// 보지 않는다.
it("keeps the database and the workspace folder when stopping the server failed, and reports that failure on close", async () => {
  const { temp, own } = await ownTemporaryFolder();
  const refused = new Error("the notification channel did not close");
  let channelCloses = 0;
  const t = await startTestServer({
    notificationChannels: [
      {
        name: "refusing-close",
        deliver: () => Promise.resolve(),
        listen: () => {},
        close: () => {
          channelCloses++;
          return Promise.reject(refused);
        },
      },
    ],
  });
  // helper가 남긴 작업 폴더는 이 시험이 치운다. 서버의 끝은 시험이 넣은 실패 하나만 빼고 확인할 수 있다: 서버 끄기는 모든 단계를 시도하고
  // 실패를 모아 던지며(`attemptAll`), 실패가 하나면 그 오류를 그대로 던진다. 그래서 끄기가 정확히 그 거절로 끝났고, 끄기 차례가 끝까지
  // 돌았고("stopped"), 대역의 닫기가 한 번 불렸으면 나머지 단계(HTTP listener를 닫고 그 닫힘을 기다리는 `requests`)는 실패 없이 끝난
  // 것이다. 이를 확인한 뒤에만 폴더를 지운다. 확인하지 못하면 폴더를 남기고 실패한다. 끄기는 한 번만 돌므로 시험이 먼저 불렀으면 그 결과를
  // 다시 받는다.
  // DB는 닫지 않고 남긴다: 시험 서버는 DB 닫기를 내주지 않고, DB는 시험 실행의 cluster에 있어 이 폴더와 상관없다. 연결은 pg pool이 유휴
  // 10초 뒤 닫고, DB는 cluster와 함께 지워진다.
  own(async () => {
    const stopFailure = await within(
      t.stopServer().then(
        () => undefined,
        (error: unknown) => error
      ),
      eventuallyMs,
      "stopping the server did not finish"
    );
    if (
      stopFailure !== refused ||
      channelCloses !== 1 ||
      t.stopProgress() !== "stopped"
    )
      throw new Error(
        `the server's end was not confirmed (channel closed ${channelCloses} times, progress "${t.stopProgress()}"); its folder is kept`
      );
  });
  await expect(t.stopServer()).rejects.toBe(refused);
  await expect(t.close()).rejects.toBe(refused);
  // helper의 정리는 DB와 작업 폴더를 남겼다.
  expect(await readdir(temp)).toHaveLength(1);
  expect((await t.db.execute("select 1 as one")).rows).toEqual([{ one: 1 }]);
});

// Event stream 구독은 받은 것을 연결이 실패하지 않았을 때만 관측 결과로 내준다(#298 외부 리뷰 2회차 SPEC-2-R1). 실제 로컬 WebSocket
// 서버가 정상 frame(준비·Event·설정 신호) 뒤 연결을 깨뜨린다. 받은 원본을 그대로 읽게 두면 끊긴 연결에서 마지막 값을 정상 관측값으로 본다.
describe("an Event stream subscription", () => {
  const event: Event = {
    id: 1,
    organizationId: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-11-25T00:00:00.000Z",
    type: "organization.paused",
    payload: { by: "owner", from: "researching", cancelledRunIds: [] },
  };

  /**
   * 연결하면 준비·Event·설정 신호를 보내는 로컬 서버에 구독한다. 구독이 준비된 뒤 그 연결의 서버 쪽(`peer`)을 돌려주어 시험이 연결을
   * 깨뜨리게 한다. 서버와 연결은 시험 정리에 맡긴다.
   */
  async function subscribed() {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    onTestFinished(() =>
      within(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        ),
        eventuallyMs,
        "the local Event stream server did not close"
      )
    );
    const peer = new Promise<WebSocket>((resolve) =>
      server.once("connection", (socket) => {
        socket.send(JSON.stringify({ type: "ready" }));
        socket.send(JSON.stringify({ type: "event", event }));
        socket.send(JSON.stringify({ type: "settings_changed" }));
        resolve(socket);
      })
    );
    await within(
      new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      }),
      eventuallyMs,
      "the local Event stream server did not start listening"
    );
    const { port } = server.address() as { port: number };
    const { subscription } = await openEventStream(`ws://127.0.0.1:${port}`, {
      opened: (terminate) => onTestFinished(terminate),
    });
    return { subscription, peer: await peer };
  }

  it("hands out every frame the server sent before it was asked", async () => {
    const { subscription } = await subscribed();
    expect(await subscription.received()).toEqual({
      events: [event],
      settingsSignals: 1,
    });
  });

  // 서버가 연결을 깨뜨린 뒤 구독에 묻는다. 읽지 못한 frame은 순서 표시(pong)보다 먼저 오고, 끊긴 연결에는 pong이 오지 않는다.
  it.each([
    {
      breaking: "an unreadable frame",
      breakOn: (peer: WebSocket) => peer.send("not json"),
      failure: SyntaxError,
    },
    {
      breaking: "the server cutting the connection",
      breakOn: (peer: WebSocket) => peer.terminate(),
      failure:
        /^the Event stream closed before the test closed it \(code 1006\)$/,
    },
  ])(
    "fails with $breaking after the first frames instead of handing them out",
    async ({ breakOn, failure }) => {
      const { subscription, peer } = await subscribed();
      breakOn(peer);
      await expect(subscription.received()).rejects.toThrow(failure);
    }
  );
});
