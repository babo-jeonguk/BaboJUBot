import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  cleanUpAll,
  folderCleanup,
  killUnlessGone,
  processAlive,
  withCleanup,
} from "./test-cleanup.ts";

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

describe("cleanUpAll", () => {
  it("tries every step in order and succeeds when they all do", async () => {
    const ran: string[] = [];
    await cleanUpAll([() => ran.push("stop"), async () => ran.push("remove")]);
    expect(ran).toEqual(["stop", "remove"]);
  });

  it("fails with the one failure as it is and still tries the later steps", async () => {
    const stop = new Error("did not stop");
    const ran: string[] = [];
    const outcome = cleanUpAll([
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
    const outcome = await cleanUpAll([
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
  it("signals a running process and passes over a finished one", async () => {
    const running = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    const exit = once(running, "exit");
    expect(killUnlessGone(running.pid!)).toBe(true);
    await exit;
    expect(killUnlessGone(running.pid!)).toBe(false);
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
