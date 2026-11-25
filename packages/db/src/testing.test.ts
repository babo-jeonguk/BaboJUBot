// 곁 DB 정리(`closeThenDrop`)의 차례를 직접 본다(#297 리뷰 권고). 연결을 닫은 뒤에만 DB를 지우고, 닫기가 실패하거나 상한을 넘기면
// 지우지 않고 그 원인으로 실패한다. 실제 DB 대신 단계마다 받은 호출을 기록하는 닫기·지우기를 넘긴다.
import { describe, expect, it } from "vitest";
import { closeThenDrop } from "./testing.ts";

describe("closeThenDrop", () => {
  it("drops the database only after its connections closed", async () => {
    const steps: string[] = [];
    let closed!: () => void;
    const closing = new Promise<void>((resolve) => (closed = resolve));
    const cleaned = closeThenDrop(
      "side_db",
      async (...received: unknown[]) => {
        expect(received).toEqual([]);
        steps.push("close");
        await closing;
        steps.push("closed");
      },
      async (...received: unknown[]) => {
        expect(received).toEqual([]);
        steps.push("drop");
      }
    );
    // 닫기가 끝나기 전에는 지우지 않는다. 닫기를 붙잡은 채 이 순서를 본 뒤 닫기를 끝낸다.
    expect(steps).toEqual(["close"]);
    closed();
    await cleaned;
    expect(steps).toEqual(["close", "closed", "drop"]);
  });

  it("keeps the database and fails with the cause when its connections did not close", async () => {
    const failure = new Error("pool end failed");
    const dropped: string[] = [];
    await expect(
      closeThenDrop(
        "side_db",
        async () => {
          throw failure;
        },
        async () => {
          dropped.push("drop");
        }
      )
    ).rejects.toBe(failure);
    expect(dropped).toEqual([]);
  });

  it("keeps the database and names what it waited for when the close passes its bound", async () => {
    const dropped: string[] = [];
    await expect(
      closeThenDrop(
        "side_db",
        () => new Promise<never>(() => {}),
        async () => {
          dropped.push("drop");
        },
        50
      )
    ).rejects.toMatchObject({
      message: "the connections to database side_db did not close within 50 ms",
    });
    expect(dropped).toEqual([]);
  });

  it("names the database when dropping it passes its bound", async () => {
    await expect(
      closeThenDrop(
        "side_db",
        async () => {},
        () => new Promise<never>(() => {}),
        50
      )
    ).rejects.toMatchObject({
      message: "database side_db was not dropped within 50 ms",
    });
  });
});
