import http from "node:http";
import type net from "node:net";
import express from "express";
import { hasErrorCode } from "@babojubot/contracts";
import { awaitedLater } from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { InFlight, trackHandlers } from "./in-flight.ts";

let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await within(
    new Promise<void>((resolve, reject) =>
      server
        ? // 듣기 전에 실패한 서버는 닫을 것이 없다.
          server.close((error) =>
            error && !hasErrorCode("ERR_SERVER_NOT_RUNNING")(error)
              ? reject(error)
              : resolve()
          )
        : resolve()
    ),
    10_000,
    "the test HTTP server did not close"
  );
  server = undefined;
});

async function serve(app: express.Express) {
  server = http.createServer(app);
  await within(
    new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    }),
    10_000,
    "the test HTTP server did not start listening"
  );
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** 멈춰 둔 처리기. 들어오면 `entered`가 풀리고, `release`로 풀면 답한다. */
function heldHandler() {
  let entered!: () => void;
  let release!: () => void;
  const enteredAt = new Promise<void>((resolve) => (entered = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const handle = async (_req: express.Request, res: express.Response) => {
    entered();
    await released;
    res.end("ok");
  };
  return { handle, entered: enteredAt, release };
}

describe("trackHandlers", () => {
  // 세기 시작한 뒤 건 경로(빈 채로 단 router에 나중에 건 경로 포함)도 센다. 서버를 시작한 뒤 경로를 거는 채널이 이렇다.
  // 이 시험은 경로가 세어지는지(처리기가 도는 동안 세고 끝나면 뺀다)만 본다. 센 일을 기다리는 `idle()`은 아래 「InFlight.idle」이 본다.
  it.each([
    ["a route added to the app later", "/later"],
    ["a route added later to a router mounted empty", "/mounted/later"],
  ])("counts %s", async (_name, path) => {
    const inFlight = new InFlight();
    const app = express();
    const mounted = express.Router();
    app.use("/mounted", mounted);
    trackHandlers(app, inFlight);
    const held = heldHandler();
    (path.startsWith("/mounted") ? mounted : app).get(
      path.replace("/mounted", ""),
      held.handle
    );
    const url = await serve(app);
    // 아래 단언이 먼저 실패하면 afterEach가 연결을 끊어 이 요청이 거절된다. 그때는 시험의 실패가 보고되고, 이 거절은 처리되지 않은
    // 거절로 새지 않는다. 시험이 끝까지 가면 아래에서 기다린다.
    const answered = awaitedLater(fetch(url + path).then((res) => res.text()));
    await held.entered;
    // 들어온 처리기는 끝나기 전까지 센다. 세지 않았다면 여기서 비어 있다.
    expect(inFlight.pending()).toEqual([`GET ${path}`]);
    held.release();
    // 답은 처리기가 끝난 뒤에 닿는다. 센 일은 처리기의 promise가 끝나는 대로 빠진다(아래 「counting tracked work」).
    expect(await answered).toBe("ok");
    expect(inFlight.pending()).toEqual([]);
  });

  it("keeps error handlers registered before and after tracking as error handlers", async () => {
    const inFlight = new InFlight();
    const app = express();
    const caught: express.ErrorRequestHandler = (error, _req, res, _next) => {
      res.status(500).json({ caught: (error as Error).message });
    };
    app.get("/before", () => {
      throw new Error("before");
    });
    app.use("/before", caught);
    trackHandlers(app, inFlight);
    app.get("/after", () => {
      throw new Error("after");
    });
    app.use("/after", caught);
    const url = await serve(app);
    for (const path of ["before", "after"])
      expect(await (await fetch(`${url}/${path}`)).json()).toEqual({
        caught: path,
      });
    await inFlight.idle();
  });
});

/** 풀 때까지 끝나지 않는 일 하나를 `flight`로 센다. 끝나면 `log`에 `<label> ended`를 남긴다. */
function heldWork(flight: InFlight, label: string, log: string[]) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const work = flight.track(
    () => released.then(() => void log.push(`${label} ended`)),
    label
  );
  return { release, work };
}

// `idle()`은 센 일이 모두 끝나야 풀린다. 기다리는 사이 새로 센 일도 기다린다. InFlight는 입출력 없이 microtask로만 움직이므로, 가짜 시계의
// 타이머를 남김없이 돌린 뒤에도 풀리지 않았으면 일을 풀기 전에는 풀리지 않는다. 타이머로 먼저 풀리는 틀린 구현도 여기서 드러난다.
describe("InFlight.idle", () => {
  it("resolves at once when nothing is counted", async () => {
    await new InFlight().idle();
  });

  it("waits for the counted work, including work counted while it waits", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const flight = new InFlight();
    const log: string[] = [];
    const first = heldWork(flight, "first", log);
    const idle = flight.idle().then(() => void log.push("idle"));
    const second = heldWork(flight, "second", log);
    await vi.runAllTimersAsync();
    expect(log).toEqual([]);

    first.release();
    await first.work;
    await vi.runAllTimersAsync();
    expect(log).toEqual(["first ended"]);
    expect(flight.pending()).toEqual(["second"]);

    second.release();
    await idle;
    await second.work;
    expect(log).toEqual(["first ended", "second ended", "idle"]);
    expect(flight.pending()).toEqual([]);
  });
});

// 센 일이 끝난 것은 그 일을 기다린 쪽이 다음 줄을 실행하기 전에 반영된다. 끝난 일을 아직 도는 것으로 알리면 종료 진단과 대기가 틀린다.
describe("counting tracked work", () => {
  it("stops counting a promise before whoever awaited it goes on", async () => {
    const flight = new InFlight();
    await flight.track(() => Promise.resolve(), "done");
    expect(flight.pending()).toEqual([]);
    await flight
      .track(() => Promise.reject(new Error("failed")), "failed")
      .catch((error: unknown) => error);
    expect(flight.pending()).toEqual([]);
  });
});
