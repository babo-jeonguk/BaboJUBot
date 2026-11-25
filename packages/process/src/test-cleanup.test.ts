import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import net from "node:net";
import {
  folderCleanup,
  killUnlessGone,
  lifelineHolder,
  ownedClosable,
  ownedListener,
  processAlive,
  withCleanup,
} from "./test-cleanup.ts";
import { endChild } from "./process-test-support.ts";
import { removeFolder } from "./remove-folder.ts";
import { within } from "./test-support.ts";
import { attemptAll, isDisconnect } from "@babojubot/contracts";

// 정리 실패가 시험의 원래 실패를 가리지 않고, 한 정리가 실패해도 나머지 정리를 한다.
describe("withCleanup", () => {
  it("returns what the body returns after running its cleanups in reverse order", async () => {
    const ran: string[] = [];
    const value = await withCleanup(async (defer) => {
      defer(() => ran.push("folder"));
      defer(async () => {
        ran.push("server");
      });
      return "result";
    });
    expect(value).toBe("result");
    expect(ran).toEqual(["server", "folder"]);
  });

  it("rethrows the body's failure as it is when every cleanup succeeds", async () => {
    const failure = new Error("assertion");
    let cleaned = false;
    const outcome = withCleanup(async (defer) => {
      defer(() => {
        cleaned = true;
      });
      throw failure;
    });
    await expect(outcome).rejects.toBe(failure);
    expect(cleaned).toBe(true);
  });

  it("reports the body's failure first and every cleanup failure after it, running each cleanup", async () => {
    const failure = new Error("assertion");
    const server = new Error("server did not close");
    const folder = new Error("folder is locked");
    const ran: string[] = [];
    const outcome = await withCleanup(async (defer) => {
      defer(() => {
        ran.push("folder");
        throw folder;
      });
      defer(async () => {
        ran.push("server");
        throw server;
      });
      throw failure;
    }).catch((error: unknown) => error);
    expect(ran).toEqual(["server", "folder"]);
    expect(outcome).toBeInstanceOf(AggregateError);
    const { errors, cause, message } = outcome as AggregateError;
    expect(errors).toEqual([failure, server, folder]);
    expect(cause).toBe(failure);
    // 오류 목록을 펼치지 않는 출력(node:test의 TAP)에서도 모든 실패가 보인다.
    expect(message).toBe(
      "시험이 실패했고 정리도 실패했다: assertion — 그리고 server did not close — 그리고 folder is locked"
    );
  });

  it("fails with a cleanup failure when only the cleanup fails, after the other cleanups", async () => {
    const server = new Error("server did not close");
    let folderRemoved = false;
    const outcome = withCleanup(async (defer) => {
      defer(() => {
        folderRemoved = true;
      });
      defer(() => {
        throw server;
      });
    });
    await expect(outcome).rejects.toBe(server);
    expect(folderRemoved).toBe(true);
  });

  it("keeps a body failure that is not an Error", async () => {
    const folder = new Error("folder is locked");
    const outcome = await withCleanup(async (defer) => {
      defer(() => {
        throw folder;
      });
      throw undefined;
    }).catch((error: unknown) => error);
    expect((outcome as AggregateError).errors).toEqual([undefined, folder]);
  });
});

describe("attemptAll", () => {
  it("tries every step in order and succeeds when they all do", async () => {
    const ran: string[] = [];
    await attemptAll([() => ran.push("stop"), async () => ran.push("remove")]);
    expect(ran).toEqual(["stop", "remove"]);
  });

  it("fails with the one failure as it is and still tries the later steps", async () => {
    const stop = new Error("did not stop");
    const ran: string[] = [];
    const outcome = attemptAll([
      () => {
        ran.push("stop");
        throw stop;
      },
      () => ran.push("remove"),
    ]);
    await expect(outcome).rejects.toBe(stop);
    expect(ran).toEqual(["stop", "remove"]);
  });

  it("fails with every failure together when several steps fail", async () => {
    const stop = new Error("did not stop");
    const remove = new Error("folder is locked");
    const outcome = await attemptAll([
      async () => {
        throw stop;
      },
      () => {
        throw remove;
      },
    ]).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([stop, remove]);
    expect((outcome as AggregateError).message).toBe(
      "정리가 실패했다: did not stop — 그리고 folder is locked"
    );
  });
});

describe("folderCleanup", () => {
  it("stops what runs in the folder in reverse order before removing it", async () => {
    const ran: string[] = [];
    const folder = folderCleanup(() => ran.push("remove"));
    folder.own(() => ran.push("database"));
    folder.own(async () => ran.push("server"));
    await folder.cleanUp();
    expect(ran).toEqual(["server", "database", "remove"]);
  });

  it("keeps the folder when something in it does not stop, after trying the other stops", async () => {
    const server = new Error("server did not stop");
    const ran: string[] = [];
    const folder = folderCleanup(() => ran.push("remove"));
    folder.own(() => ran.push("database"));
    folder.own(() => {
      throw server;
    });
    await expect(folder.cleanUp()).rejects.toBe(server);
    expect(ran).toEqual(["database"]);
  });

  // 지우기가 매달리면 정리가 이름 없이 hook 시한까지 멈췄다(#297 독립 점검). 지우기를 기다리는 데도 이름 있는 상한을 둔다.
  it("fails with the reason when removing the folder does not end within its bound", async () => {
    const folder = folderCleanup(() => new Promise<never>(() => {}), {
      removeTimeoutMs: 50,
    });
    await expect(
      within(folder.cleanUp(), 5_000, "the folder cleanup did not end")
    ).rejects.toMatchObject({
      message: "the test folder was not removed within 50 ms",
    });
  });

  // 정지가 실패한 폴더는 그 안의 프로그램이 아직 쓸 수 있다. 같은 정리를 다시 불러도 지우지 않는다(#243).
  it("keeps the folder when called again after a stop failed, without stopping again", async () => {
    const server = new Error("server did not stop");
    const ran: string[] = [];
    const folder = folderCleanup(() => ran.push("remove"));
    folder.own(() => {
      ran.push("stop");
      throw server;
    });
    await expect(folder.cleanUp()).rejects.toBe(server);
    await expect(folder.cleanUp()).rejects.toBe(server);
    expect(ran).toEqual(["stop"]);
  });

  it("shares one run between calls made while it is stopping", async () => {
    const server = new Error("server did not stop");
    const ran: string[] = [];
    let fail!: () => void;
    const folder = folderCleanup(() => ran.push("remove"));
    folder.own(() => {
      ran.push("stop");
      return new Promise<void>((_, reject) => {
        fail = () => reject(server);
      });
    });
    const first = folder.cleanUp();
    const second = folder.cleanUp();
    // 두 번째 호출은 첫 정지가 끝나기 전에 들어왔다. 정지가 실패하면 둘 다 그 실패를 받고 폴더는 남는다.
    expect(ran).toEqual(["stop"]);
    fail();
    await expect(first).rejects.toBe(server);
    await expect(second).rejects.toBe(server);
    expect(ran).toEqual(["stop"]);
  });

  it("removes the folder once when called again after it succeeded", async () => {
    const ran: string[] = [];
    const folder = folderCleanup(() => ran.push("remove"));
    folder.own(() => ran.push("stop"));
    await Promise.all([folder.cleanUp(), folder.cleanUp()]);
    await folder.cleanUp();
    expect(ran).toEqual(["stop", "remove"]);
  });

  // 정리가 시작된 뒤 맡긴 것은 그 정리가 멈추지 않는다. 멈추지 않은 채 폴더가 지워지지 않게 맡기기를 거절한다.
  it("refuses something to stop once the cleanup has started", async () => {
    const ran: string[] = [];
    const folder = folderCleanup(() => ran.push("remove"));
    const cleaning = folder.cleanUp();
    expect(() => folder.own(() => ran.push("late"))).toThrow(
      "폴더 정리가 시작된 뒤에는 멈출 것을 맡길 수 없다"
    );
    await cleaning;
    expect(ran).toEqual(["remove"]);
  });
});

/** `process.kill`이 `code` 오류로 실패하게 한다. 시험이 끝나면 되돌린다. */
function failKill(code: string) {
  const failure = Object.assign(new Error(`kill ${code}`), { code });
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw failure;
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  return failure;
}

// 종료 확인은 "프로세스 없음"(ESRCH)만 끝난 것으로 본다. 권한·I/O 오류를 끝남으로 보면 남은 프로그램의 폴더를 지운다(#243).
describe("processAlive", () => {
  it("answers true for a running process and false for a finished one", async () => {
    expect(processAlive(process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(processAlive(child.pid!)).toBe(false);
  });

  it.each(["EPERM", "EIO"])(
    "fails with the pid and the cause when the lookup fails with %s",
    (code) => {
      const failure = failKill(code);
      let error: unknown;
      try {
        processAlive(4242);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "프로세스 4242가 있는지 확인하지 못했다"
      );
      expect((error as Error).cause).toBe(failure);
    }
  );
});

describe("killUnlessGone", () => {
  it("signals a running process", async () => {
    const running = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    const exit = once(running, "exit");
    expect(killUnlessGone(running.pid!)).toBe(true);
    await exit;
  });

  // 끝난 대상(ESRCH)은 넘어간다. 끝난 프로세스의 번호에 실제로 신호하면 그 번호를 받은 다른 프로그램에 갈 수 있어(#288 parent 점검),
  // "없음" 답을 주입해 본다.
  it("passes over a finished process", () => {
    failKill("ESRCH");
    expect(killUnlessGone(4242)).toBe(false);
  });

  it.each(["EPERM", "EIO"])(
    "fails with the pid, the signal and the cause when the signal fails with %s",
    (code) => {
      const failure = failKill(code);
      let error: unknown;
      try {
        killUnlessGone(4242, "SIGTERM");
      } catch (thrown) {
        error = thrown;
      }
      expect((error as Error).message).toBe(
        "프로세스 4242에 SIGTERM을 보내지 못했다"
      );
      expect((error as Error).cause).toBe(failure);
    }
  );
});

// #288 외부 리뷰 4회차 STD-6/SPEC-3: 연결이 열려 있음은 그 번호가 아직 그 프로그램이라는 근거다. 그 근거는 본 순간에만 맞으므로,
// 열림을 본 뒤 신호까지 다른 기다림(파일 읽기 등)이 끼면 그 사이 프로그램이 끝나 닫힘이 처리될 수 있다. 대역 연결은 열림을 알린
// 직후 다음 기다림에서 닫히게 해, 신호가 그보다 먼저(열린 동안) 갔는지 본다.
describe("lifelineHolder", () => {
  it("signals the holder right after it sees the connection open, with nothing awaited in between", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "babojubot-holder-"));
    onTestFinished(() => removeFolder(folder));
    const program = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      }
    );
    onTestFinished(() => endChild(program));
    const exit = once(program, "exit");
    const pidFile = path.join(folder, "pid");
    await writeFile(pidFile, String(program.pid));
    let open = true;
    const holder = lifelineHolder(
      {
        hold: () => "",
        connected: async () => {},
        open: () => {
          const seen = open;
          queueMicrotask(() => (open = false));
          return seen;
        },
        closed: async () => {
          await within(exit, 10_000, "the holder program did not end");
        },
      },
      "holder",
      pidFile
    );
    const kill = process.kill.bind(process);
    const openAtSignal: boolean[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === program.pid) openAtSignal.push(open);
      return kill(pid, signal);
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });

    await holder.end();

    expect(openAtSignal).toEqual([true]);
  });
});

// 시험이 만든 소켓·요청은 만든 직후 정리에 맡긴다. 정리는 끊고, 실제 닫힘을 상한 안에서 확인한다(#286 3b-3).
describe("ownedClosable", () => {
  it("ends an open socket and returns once it closed", async () => {
    const { server } = await ownedListener(
      net.createServer(),
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the test server"
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error(`the server is not on a TCP port (${address})`);
    // 시험 대상이 넘긴 정리는 기록하고 러너에도 맡긴다. 본문이 그 정리를 부르기 전에 실패해도 소켓이 남지 않는다(두 번 불러도 같다).
    const steps: (() => Promise<void>)[] = [];
    const socket = ownedClosable(
      (step) => {
        steps.push(step);
        onTestFinished(step);
      },
      net.connect(address.port, "127.0.0.1"),
      "the test socket"
    );
    await within(once(socket, "connect"), 5_000, "the socket did not connect");
    expect(steps).toHaveLength(1);
    await within(steps[0]!(), 5_000, "the cleanup did not end");
    expect(socket.destroyed).toBe(true);
    expect(socket.closed).toBe(true);
  });

  it("fails with the reason when the resource does not close within its bound", async () => {
    const destroyed: unknown[][] = [];
    const resource = Object.assign(new EventEmitter(), {
      destroy: (...received: unknown[]) => destroyed.push(received),
    });
    const steps: (() => unknown)[] = [];
    ownedClosable(
      (step) => steps.push(step),
      resource,
      "the stuck request",
      50
    );
    await expect(
      within(Promise.resolve(steps[0]?.()), 5_000, "the cleanup did not end")
    ).rejects.toMatchObject({
      message: "the stuck request did not close within 50 ms",
    });
    expect(destroyed).toEqual([[]]);
  });
});

// 시험이 띄우는 listener(net·http 서버)는 듣기 전에 그 닫기를 소유자에 맡긴다. 듣기·닫기는 상한 안에서 기다리고, 닫기는 받은 연결을
// 먼저 끊는다. 듣지 않은 서버·이미 닫은 서버는 닫을 것이 없다(#286 3b-3, server 시험의 같은 계약을 공용 자리로).
describe("ownedListener", () => {
  it("hands its close to the owner before listening, and the close ends the connections it took", async () => {
    const server = net.createServer();
    const owned: { listening: boolean; close: () => Promise<void> }[] = [];
    // 맡긴 닫기는 기록하고 러너에도 맡긴다. 본문이 닫기 전에 실패해도 서버가 남지 않는다.
    const { close } = await ownedListener(
      server,
      { port: 0, host: "127.0.0.1" },
      (step) => {
        owned.push({ listening: server.listening, close: step });
        onTestFinished(step);
      },
      "the test listener"
    );
    expect(owned.map(({ listening }) => listening)).toEqual([false]);
    expect(server.listening).toBe(true);
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error(`the listener is not on a TCP port (${address})`);
    const accepted = once(server, "connection");
    const client = ownedClosable(
      onTestFinished,
      net.connect(address.port, "127.0.0.1"),
      "the client"
    );
    // 상대가 끊어 난 오류는 이 시험이 기다리는 끝이다. 그 밖의 오류는 드러낸다.
    client.on("error", (error) => {
      if (!isDisconnect(error)) throw error;
    });
    await within(accepted, 5_000, "the listener did not take the connection");
    await within(owned[0]!.close(), 5_000, "the owner's close did not end");
    expect(server.listening).toBe(false);
    await within(once(client, "close"), 5_000, "the client was not cut");
    // 시험이 이미 닫았으면 맡긴 닫기는 닫을 것이 없다.
    await close();
  });

  it("rejects with the listen failure and leaves nothing to close", async () => {
    const holder = net.createServer();
    const { server: held } = await ownedListener(
      holder,
      { port: 0, host: "127.0.0.1" },
      onTestFinished,
      "the port holder"
    );
    const { port } = held.address() as net.AddressInfo;
    const closes: (() => Promise<void>)[] = [];
    await expect(
      ownedListener(
        net.createServer(),
        { port, host: "127.0.0.1" },
        (step) => {
          closes.push(step);
          onTestFinished(step);
        },
        "the second listener"
      )
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(closes).toHaveLength(1);
    await within(closes[0]!(), 5_000, "the close did not end");
  });
});
