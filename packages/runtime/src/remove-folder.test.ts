import { expect, it } from "vitest";
import { removeFolder } from "./remove-folder.ts";

// Windows는 핸들이 늦게 닫히거나 검사 프로그램이 파일을 잠시 붙잡아 폴더 삭제가 잠깐 실패한다. 그런 일시적인 오류만
// 정해진 횟수 안에서 다시 시도하고, 소진하거나 다른 오류면 원래 오류로 실패한다. 오류는 삭제 함수를 바꿔 끼워 만든다.

const failure = (code: string) =>
  Object.assign(new Error(`${code}: injected`), { code });
/** 앞의 오류들을 차례로 내고, 그 뒤로는 성공하는 삭제. */
function failing(...codes: string[]) {
  let calls = 0;
  return {
    calls: () => calls,
    rm: async () => {
      const code = codes[calls++];
      if (code) throw failure(code);
    },
  };
}
const noWait = async () => {};

it("removes the folder after two busy failures", async () => {
  const rm = failing("EBUSY", "EBUSY");
  await removeFolder("root", { rm: rm.rm, wait: noWait });
  expect(rm.calls()).toBe(3);
});

it("fails with the original error once the retries run out", async () => {
  const busy = failure("EBUSY");
  let calls = 0;
  const waits: number[] = [];
  await expect(
    removeFolder("root", {
      rm: async () => {
        calls++;
        throw busy;
      },
      wait: async (ms) => void waits.push(ms),
    })
  ).rejects.toBe(busy);
  // 처음 한 번과 다시 시도 세 번. 기다림은 Node `fs.rm`처럼 시도마다 100ms씩 늘어난다.
  expect(calls).toBe(4);
  expect(waits).toEqual([100, 200, 300]);
});

it("retries as many times as asked, waiting longer each time, for a slow volume", async () => {
  const busy = failure("ENOTEMPTY");
  const waits: number[] = [];
  await expect(
    removeFolder("root", {
      retries: 5,
      retryDelayMs: 200,
      rm: async () => {
        throw busy;
      },
      wait: async (ms) => void waits.push(ms),
    })
  ).rejects.toBe(busy);
  expect(waits).toEqual([200, 400, 600, 800, 1000]);
});

it("fails at once on an error that waiting does not fix", async () => {
  const rm = failing("EACCES");
  await expect(
    removeFolder("root", { rm: rm.rm, wait: noWait })
  ).rejects.toMatchObject({ code: "EACCES" });
  expect(rm.calls()).toBe(1);
});

it("counts a folder that is already gone as removed", async () => {
  const rm = failing("ENOENT");
  await removeFolder("root", { rm: rm.rm, wait: noWait });
  expect(rm.calls()).toBe(1);
});

it.each(["EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"])(
  "retries %s like a busy folder",
  async (code) => {
    const rm = failing(code);
    await removeFolder("root", { rm: rm.rm, wait: noWait });
    expect(rm.calls()).toBe(2);
  }
);
