import { randomUUID } from "node:crypto";
import net from "node:net";
import type pg from "pg";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { clusterUrl } from "./client.ts";
import {
  askServer,
  createDatabase,
  testClusterPort,
  testConnection,
  testPool,
} from "./testing.ts";
import { awaitedLater } from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";

// 시험이 여는 pg 연결의 상한(#288 외부 리뷰 5회차 parent 점검). 상한이 지나면 시험은 그 상한의 이유로 실패하고 그 연결도 끝나야
// 한다. 상한이 거절만 하고 연결 시도나 질의를 그대로 두면, 시험이 잡은 연결이 실패한 뒤에도 남는다(CODING_STANDARDS 「정리」).
// 시험이 띄운 서버로 본다. 받은 것을 읽기만 하고 답하지 않는 서버(연결 단계)와, 인증 끝·준비 알림만 보내고 질의에 답하지 않는
// 서버(질의 단계)에서는 서버 쪽에서 연결의 닫힘을 본다. 아무것도 읽지 않는 서버(멈춘 서버)는 상대의 끝도 읽지 않아 서버 쪽에서는
// 닫힘을 볼 수 없으므로, 묻는 쪽의 정리가 연결의 끝을 확인했는지(실패가 상한의 이유 하나뿐인지)로 본다.

// 인증 끝(AuthenticationOk)과 질의 준비(ReadyForQuery, idle). PostgreSQL 프로토콜 메시지 형식.
const readyForQuery = Buffer.from([
  0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49,
]);

/** 연결 단계에서 멈추는 서버(받은 것을 읽기만 함)와 질의 단계에서 멈추는 서버(준비 알림까지만 보냄). */
const stuckAt = [
  { what: "its connection", answers: false },
  { what: "its question", answers: true },
];
const serveUntil = (answers: boolean) => (socket: net.Socket) => {
  if (answers) socket.once("data", () => socket.write(readyForQuery));
  else socket.resume();
};

// 질의 끝(CommandComplete "SELECT 0")과 다음 질의 준비(ReadyForQuery, idle).
const queryDone = Buffer.concat([
  Buffer.from([0x43, 0, 0, 0, 13]),
  Buffer.from("SELECT 0\0"),
  Buffer.from([0x5a, 0, 0, 0, 5, 0x49]),
]);

/** 시작에 답하고(인증 끝·준비 알림) 질의(Query, `Q`)마다 그 끝을 알리는 서버. 끝내자는 알림(Terminate, `X`)에는 답하지 않는다. */
const answerQueries = (socket: net.Socket) => {
  let started = false;
  socket.on("data", (chunk: Buffer) => {
    if (!started) {
      started = true;
      socket.write(readyForQuery);
    } else if (chunk[0] === 0x51) socket.write(queryDone);
  });
};

/**
 * 시험이 띄운 서버. 받은 연결마다 `serve`를 부르고, 그 연결의 닫힘을 모은다. 시험이 끝나면 연결을 끊고 서버를 닫는다.
 * 상대가 자기 쪽을 닫으면(FIN) 서버도 그 연결을 닫는다(정중한 끝에 답함). `keepsOpen`이면 닫지 않고 쥔다(정중한 끝에 답하지 않음).
 */
async function fakeServer(
  serve: (socket: net.Socket) => void,
  { keepsOpen = false } = {}
) {
  const server = net.createServer({ allowHalfOpen: keepsOpen });
  const sockets = new Set<net.Socket>();
  const closed: Promise<void>[] = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    closed.push(
      new Promise<void>((resolve) => socket.once("close", () => resolve()))
    );
    // 시험이 끊는 연결은 재설정으로 끝날 수 있다. 그 끝은 위 `close`로 본다.
    socket.on("error", () => socket.destroy());
    serve(socket);
  });
  // 듣기 전에 정리에 맡긴다. 듣지 못한 서버(듣기 실패)는 닫을 것이 없다(닫으면 ERR_SERVER_NOT_RUNNING으로 실패한다).
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await within(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        ),
        10_000,
        "the fake server did not close"
      );
  });
  await within(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    }),
    10_000,
    "the fake server did not start listening"
  );
  const { port } = server.address() as net.AddressInfo;
  return { url: clusterUrl(port, "postgres"), closed };
}

/** 서버 쪽에서 그 연결 하나가 닫히는 것을 본다. */
async function closedOnServer(closed: Promise<void>[]) {
  expect(closed).toHaveLength(1);
  await within(
    closed[0]!,
    5_000,
    "the connection to the fake server was left open"
  );
}

describe("asking a server with a limit", () => {
  /** 상한 500ms로 묻고, 그 상한의 이유 하나로 실패하는지 본다(정리가 연결의 끝을 확인하지 못하면 그 실패가 함께 묶여 다르다). */
  const asksInVain = (url: string) =>
    expect(
      askServer(
        url,
        (client) => client.query("select 1"),
        500,
        "the fake server did not answer"
      )
    ).rejects.toThrow(
      new Error("the fake server did not answer within 500 ms")
    );

  it.each(stuckAt)(
    "ends the connection when the server never answers $what",
    async ({ answers }) => {
      const { url, closed } = await fakeServer(serveUntil(answers));

      await asksInVain(url);

      await closedOnServer(closed);
    }
  );

  it("ends the connection when the server reads nothing at all", async () => {
    const { url, closed } = await fakeServer(() => {});

    await asksInVain(url);

    expect(closed).toHaveLength(1);
  });

  // 답을 받은 연결은 정중히 끝낸다(#288 외부 리뷰 6회차 STD-9/SPEC-5). 정중한 끝이 상한 안에 닫히지 않으면(상대가 끝에 답하지 않음)
  // 그 실패를 알리고, 소켓을 끊어 닫는다.
  it("ends an answered connection politely when the server ends it too", async () => {
    const { url, closed } = await fakeServer(answerQueries);

    const answer = await askServer(
      url,
      (client) => client.query("select 1"),
      500,
      "the fake server did not answer"
    );

    expect(answer.command).toBe("SELECT");
    await closedOnServer(closed);
  });

  // 끝에 답하지 않는 서버는 상대의 FIN 뒤로 받을 것이 없어 상대가 끊어 닫은 것을 볼 수 없다. 끝은 묻는 쪽에서 본다: pg Client의 `end`
  // 이벤트는 그 소켓이 닫힌 뒤에 나고(pg 8.23 `lib/connection.js`·`lib/client.js`), 실패가 알려질 때 이미 났어야 한다.
  it("cuts an answered connection the server does not end, and reports that it did not end politely", async () => {
    const { url } = await fakeServer(answerQueries, { keepsOpen: true });
    let ended = false;

    await expect(
      askServer(
        url,
        (client) => {
          client.once("end", () => (ended = true));
          return client.query("select 1");
        },
        500,
        "the fake server did not answer"
      )
    ).rejects.toThrow(
      new Error(
        "the fake server did not answer, and its connection did not close within 500 ms"
      )
    );

    expect(ended).toBe(true);
  });
});

// 시험이 여는 pg pool도 같은 기준이다: 연결과 질의마다 상한이 있고, 상한이 지나면 그 연결이 끝난다. pool의 끝은 닫기가 확인한다.
describe("a test's pg pool", () => {
  // 연결 단계는 pg-pool의 연결 상한이 소켓을 끊어 끝나고(pg의 연결 실패 문구), 질의 단계는 pg의 질의 상한이 끝낸다.
  it.each([
    {
      ...stuckAt[0]!,
      failure: "Connection terminated due to connection timeout",
    },
    { ...stuckAt[1]!, failure: "Query read timeout" },
  ])(
    "fails a query and ends its connection when the server never answers $what",
    async ({ answers, failure }) => {
      const { url, closed } = await fakeServer(serveUntil(answers));
      const { pool, close } = testPool(url, 500);
      onTestFinished(() => close(true, "the test's pool did not end"));

      await expect(
        within(pool.query("select 1"), 5_000, "the pool's query did not settle")
      ).rejects.toThrow(new Error(failure));

      await closedOnServer(closed);
    }
  );
});

// pool의 끝은 그 연결들의 소켓이 닫힌 것으로 본다(#288 외부 리뷰 6회차 STD-8/SPEC-4). pg-pool은 연결을 목록에서 먼저 빼고 끝내므로,
// pool의 `end()`는 소켓이 닫히기 전에 이행할 수 있다(pg-pool 3.14 `_remove`·`_pulseQueue`). 정중한 끝이 상한 안에 닫히지 않으면
// 그 실패를 알리고 끊는다. 끊은 경우에도 끝은 소켓의 닫힘으로 본다. 끝에 답하지 않는 서버는 끊어 닫은 것을 볼 수 없어(위) pool
// 쪽에서 본다.
describe("closing a test's pg pool", () => {
  /** pool이 연 연결 가운데 아직 끝나지 않은 것. pg Client의 `end` 이벤트는 그 소켓이 닫힌 뒤에 난다(pg 8.23 `lib/connection.js`). */
  function openClients(pool: pg.Pool) {
    const open = new Set<pg.PoolClient>();
    pool.on("connect", (client) => {
      open.add(client);
      client.once("end", () => open.delete(client));
    });
    return open;
  }

  /** 질의 하나를 마쳐 쉬는 연결 하나를 둔 pool. 시험이 닫지 않았으면 정리가 끊어 닫는다. */
  async function usedPool(url: string) {
    const { pool, close } = testPool(url, 500);
    const open = openClients(pool);
    let closing = false;
    onTestFinished(() =>
      closing ? undefined : close(true, "the test's pool did not end")
    );
    await within(
      pool.query("select 1"),
      5_000,
      "the pool's query did not settle"
    );
    expect(open.size).toBe(1);
    return {
      open,
      close: (cut: boolean) => {
        closing = true;
        return close(cut, "the test's pool did not end");
      },
    };
  }

  it("ends only after its connections close, when the server ends them too", async () => {
    const { url, closed } = await fakeServer(answerQueries);
    const { open, close } = await usedPool(url);

    await close(false);

    expect(open.size).toBe(0);
    await closedOnServer(closed);
  });

  it("cuts the connections the server does not end, and reports that they did not end politely", async () => {
    const { url } = await fakeServer(answerQueries, { keepsOpen: true });
    const { open, close } = await usedPool(url);

    await expect(close(false)).rejects.toThrow(
      new Error("the test's pool did not end within 500 ms")
    );

    expect(open.size).toBe(0);
  });

  it("ends only after the connections it cuts close", async () => {
    const { url } = await fakeServer(answerQueries, { keepsOpen: true });
    const { open, close } = await usedPool(url);

    await close(true);

    expect(open.size).toBe(0);
  });
});

// 만들기의 답을 받지 못해도 서버는 그 DB를 만들고 있을 수 있다(#288 외부 리뷰 6회차 STD-R1). 연결을 끊어도 서버 쪽 연결(backend)은
// 잠금을 기다리는 동안 그 끊김을 보지 못하고, 잠금이 풀리면 만들기를 마친다. 그 DB도 지워져야 한다.
describe("creating a test database", () => {
  it("drops the database it did not hear back about, even when the server goes on to create it", async () => {
    const admin = clusterUrl(testClusterPort(), "postgres");
    const suffix = randomUUID().replaceAll("-", "");
    const source = `test_source_${suffix}`;
    const name = `test_unheard_${suffix}`;
    onTestFinished(() =>
      askServer(
        admin,
        async (client) => {
          await client.query(`drop database if exists ${name} with (force)`);
          await client.query(`drop database if exists ${source} with (force)`);
        },
        30_000,
        "the test's databases were not dropped"
      )
    );
    await askServer(
      admin,
      (client) => client.query(`create database ${source}`),
      30_000,
      "the source database was not created"
    );
    // 시험의 연결 둘: 원본 DB에 잠금을 쥐는 연결(열린 transaction 안의 설명 달기. 만들기는 원본 DB에 공유 잠금을 건다)과, 서버
    // 상태를 보는 연결(transaction 밖: 묻는 때마다 새 상태를 본다).
    const holder = testConnection(admin);
    const observer = testConnection(admin);
    let done = false;
    onTestFinished(async () => {
      await holder.close(!done, 10_000, "the lock holder did not close");
      await observer.close(!done, 10_000, "the observer did not close");
    });
    await within(
      Promise.all([
        holder.client
          .connect()
          .then(() => holder.client.query("begin"))
          .then(() =>
            holder.client.query(`comment on database ${source} is 'held'`)
          ),
        observer.client.connect(),
      ]),
      10_000,
      "the test's connections were not ready"
    );
    const ask = async <R extends pg.QueryResultRow>(
      text: string,
      values: unknown[]
    ) =>
      (
        await within(
          observer.client.query<R>(text, values),
          10_000,
          "the observer did not hear back"
        )
      ).rows;

    const creating = awaitedLater(createDatabase(admin, name, source, 500));
    // 만들기가 그 잠금을 기다리는 것을 본다(그 backend의 번호).
    const creator = await vi.waitUntil(
      async () =>
        (
          await ask<{ pid: number }>(
            "select pid from pg_stat_activity where wait_event_type = 'Lock' and query = $1",
            [`create database ${name} template ${source}`]
          )
        )[0]?.pid,
      { timeout: 10_000, interval: 20 }
    );
    await expect(creating).rejects.toThrow(
      new Error(`the test cluster did not create ${name} within 500 ms`)
    );
    // 잠금을 풀고, 그 backend가 끝난 뒤에 본다. 만들기를 포기한 쪽이 그 backend를 끝내지 않았으면 만들기는 여기서 마저 끝난다.
    await within(
      holder.client.query("commit"),
      10_000,
      "the lock holder did not commit"
    );
    await vi.waitUntil(
      async () =>
        (await ask("select from pg_stat_activity where pid = $1", [creator]))
          .length === 0,
      { timeout: 10_000, interval: 20 }
    );

    expect(
      await ask("select from pg_database where datname = $1", [name])
    ).toEqual([]);
    done = true;
  });
});
