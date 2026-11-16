import http from "node:http";
import type net from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { InFlight, trackHandlers } from "./in-flight.ts";

let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  server = undefined;
});

async function serve(app: express.Express) {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** 멈춰 둔 처리기. 들어오면 `entered`가 풀리고, `release`로 풀면 `handled`를 남기고 답한다. */
function heldHandler(order: string[]) {
  let entered!: () => void;
  let release!: () => void;
  const enteredAt = new Promise<void>((resolve) => (entered = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const handle = async (_req: express.Request, res: express.Response) => {
    entered();
    await released;
    order.push("handled");
    res.end("ok");
  };
  return { handle, entered: enteredAt, release };
}

describe("trackHandlers", () => {
  // 세기 시작한 뒤 건 경로(빈 채로 단 router에 나중에 건 경로 포함)도 센다. 서버를 시작한 뒤 경로를 거는 채널이 이렇다.
  it.each([
    ["a route added to the app later", "/later"],
    ["a route added later to a router mounted empty", "/mounted/later"],
  ])("counts %s", async (_name, path) => {
    const inFlight = new InFlight();
    const app = express();
    const mounted = express.Router();
    app.use("/mounted", mounted);
    trackHandlers(app, inFlight);
    const order: string[] = [];
    const held = heldHandler(order);
    (path.startsWith("/mounted") ? mounted : app).get(
      path.replace("/mounted", ""),
      held.handle
    );
    const url = await serve(app);
    const answered = fetch(url + path).then((res) => res.text());
    await held.entered;
    const idle = inFlight.idle().then(() => order.push("idle"));
    // 세지 않았다면 이 사이에 `idle`이 먼저 풀린다.
    await new Promise((resolve) => setImmediate(resolve));
    held.release();
    await idle;
    expect(await answered).toBe("ok");
    expect(order).toEqual(["handled", "idle"]);
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
