import { describe, expect, it } from "vitest";
import { cleanUpAll, folderCleanup, withCleanup } from "./test-cleanup.ts";

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
});
