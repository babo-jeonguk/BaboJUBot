import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { onStopRequest, stopRequest } from "./stop-request.ts";

/** 프로세스의 신호·IPC 이벤트만 흉내 낸다. `ipc`면 부모와 이어진 채널이 있는 자식이다. */
function fakeProcess({ ipc }: { ipc: boolean }) {
  const proc = new EventEmitter() as EventEmitter & { send?: () => boolean };
  if (ipc) proc.send = () => true;
  return proc;
}

function listen(proc: ReturnType<typeof fakeProcess>) {
  const reasons: string[] = [];
  onStopRequest(proc, (reason) => reasons.push(reason));
  return reasons;
}

describe("stop requests", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP"])(
    "treats %s as a stop request with or without a parent channel",
    (signal) => {
      for (const ipc of [false, true]) {
        const proc = fakeProcess({ ipc });
        const reasons = listen(proc);
        proc.emit(signal);
        expect(reasons).toEqual([signal]);
      }
    }
  );

  it("treats the parent's stop message as a stop request", () => {
    const proc = fakeProcess({ ipc: true });
    const reasons = listen(proc);
    proc.emit("message", { ...stopRequest });
    expect(reasons).toEqual(["stop request"]);
  });

  it("ignores other messages from the parent", () => {
    const proc = fakeProcess({ ipc: true });
    const reasons = listen(proc);
    for (const message of [
      "shutdown",
      { type: "stop" },
      { type: "babojubot:stop!" },
      { id: 1, now: "2026-03-10T15:00:00.000Z" },
      null,
      undefined,
      42,
    ])
      proc.emit("message", message);
    expect(reasons).toEqual([]);
  });

  it("treats losing the parent channel as a stop request", () => {
    const proc = fakeProcess({ ipc: true });
    const reasons = listen(proc);
    proc.emit("disconnect");
    expect(reasons).toEqual(["parent disconnected"]);
  });

  it("does not listen for parent messages when there is no parent channel", () => {
    const proc = fakeProcess({ ipc: false });
    listen(proc);
    expect(proc.listenerCount("message")).toBe(0);
    expect(proc.listenerCount("disconnect")).toBe(0);
  });

  // 같은 요청이 여러 번 와도 정리는 받는 쪽이 한 번만 한다(main.ts의 `stopping`). 이 연결은 온 요청을 모두 그대로 넘긴다.
  it("passes on every request in order", () => {
    const proc = fakeProcess({ ipc: true });
    const reasons = listen(proc);
    proc.emit("message", stopRequest);
    proc.emit("SIGTERM");
    proc.emit("message", stopRequest);
    proc.emit("disconnect");
    expect(reasons).toEqual([
      "stop request",
      "SIGTERM",
      "stop request",
      "parent disconnected",
    ]);
  });
});
