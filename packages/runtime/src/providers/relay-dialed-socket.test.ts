import http from "node:http";
import type * as netModule from "node:net";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { destinationSchema } from "@babojubot/contracts";
import { within } from "@babojubot/process/test-support";
import { createRelayHub } from "./relay.ts";

// 중계가 허용된 목적지로 붙은 소켓(`relay.ts` `dial`의 `net.connect`)을 시험이 받는다. 정한 포트로 가는 연결만 받고, 그 소켓은
// 진짜 연결이다. 시험은 그 소켓에 연결 끊김이 아닌 오류를 넣는다(실제 연결에서 결정적으로 만들 수 없는 오류).
const dialing = vi.hoisted(() => ({
  port: undefined as number | undefined,
  sockets: [] as netModule.Socket[],
}));
vi.mock("node:net", async (importOriginal) => {
  const real = await importOriginal<typeof netModule>();
  const connect = ((...args: Parameters<typeof real.connect>) => {
    const socket = real.connect(...args);
    const options: unknown = args[0];
    if (
      typeof options === "object" &&
      options !== null &&
      "port" in options &&
      Number(options.port) === dialing.port
    )
      dialing.sockets.push(socket);
    return socket;
  }) as typeof real.connect;
  return {
    ...real,
    connect,
    createConnection: connect,
    default: { ...real, connect, createConnection: connect },
  };
});

const identity = {
  organizationId: "00000000-0000-4000-8000-00000000000a",
  agentId: "00000000-0000-4000-8000-00000000000b",
  runId: "00000000-0000-4000-8000-00000000000c",
};

// Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행).
describe.skipIf(process.platform === "win32")(
  "a relay connection to an allowed destination",
  () => {
    // 목적지 쪽 요청에 넘긴 소켓의 오류는 그 요청의 끝 하나로만 알린다. 연결 단계의 오류 처리가 같은 실패를 따로 한 번 더 남기지
    // 않는다(#296 외부 리뷰 1회차 SPEC-1).
    it("leaves a socket failure after the answer began once, as the answer's end", async () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("part");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      onTestFinished(
        () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          })
      );
      const port = (server.address() as net.AddressInfo).port;
      dialing.port = port;
      dialing.sockets = [];
      onTestFinished(() => {
        dialing.port = undefined;
      });
      const relays = createRelayHub();
      relays.attach({
        research: async () => [
          destinationSchema.parse({
            host: "localhost",
            port,
            addresses: ["127.0.0.1"],
          }),
        ],
        tools: (_req, res) => res.end(),
        protectedPorts: () => [],
      });
      onTestFinished(() => relays.close());
      const relay = relays.open({ identity, required: [] });
      await relay.ready;
      const ending = await within(
        new Promise<string>((resolve, reject) => {
          const req = http.request({
            socketPath: path.join(relay.directory, "egress.sock"),
            path: `http://localhost:${port}/page`,
            agent: false,
          });
          req.on("response", (res) => {
            res.once("data", () => {
              for (const socket of dialing.sockets)
                socket.destroy(
                  Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
                );
            });
            res.on("end", () => resolve("ended"));
            res.on("error", () => resolve("broken"));
          });
          req.on("error", reject);
          req.end();
        }),
        10_000,
        "the relayed answer to end"
      );
      expect(ending).toBe("broken");
      expect(dialing.sockets).toHaveLength(1);
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
        "[provider] an allowed destination's answer broke off in the relay (ETIMEDOUT)",
      ]);
    });
  }
);
