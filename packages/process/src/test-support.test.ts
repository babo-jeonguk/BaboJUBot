import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { callArming } from "./call-arming-support.ts";
import { fileLinks, reportedPid, within } from "./test-support.ts";

// 파일 링크 만들기와 지우기를 대신한다(모듈 경계 대역). 실제 링크는 만들지 않아 권한 없는 Windows에서도 같은 결과다. 받은 인수를 남겨
// 무엇을 만들고 지웠는지 본다. 실제 링크 만들기는 `fileLinks`를 쓰는 링크 시험(CI는 필수)이 본다.
const linking = vi.hoisted(() => ({
  made: [] as unknown[][],
  removed: [] as unknown[][],
}));
/**
 * 확인 링크의 이름은 무작위라 시험이 그 경로를 미리 알 수 없다. 시험은 `fileLinks()`를 `linkCalls.run(결함, …, onTestFinished)`로
 * 감싸고, 대역은 불린 순간 그 호출의 결함을 잡는다. 링크 만들기는 `refuse`, 지우기는 `failRemove` 원인(`code`)으로 실패하고 실패한
 * 링크 자리를 `failedAt`에 남긴다. 다른 시험의 호출이나 감싸지 않은 호출은 결함이 없어 실패하지 않는다(#286).
 */
const linkCalls = callArming<{
  refuse?: string;
  failRemove?: string;
  failedAt: string[];
}>();
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const failure = (code: string) =>
    Object.assign(new Error(`${code}: refused`), { code });
  const symlinkSync = ((...args: unknown[]) => {
    linking.made.push(args);
    const fault = linkCalls.current();
    if (fault?.refuse) {
      fault.failedAt.push(String(args[1]));
      throw failure(fault.refuse);
    }
  }) as typeof real.symlinkSync;
  const unlinkSync = ((...args: unknown[]) => {
    linking.removed.push(args);
    const fault = linkCalls.current();
    if (fault?.failRemove) {
      fault.failedAt.push(String(args[0]));
      throw failure(fault.failRemove);
    }
  }) as typeof real.unlinkSync;
  return {
    ...real,
    symlinkSync,
    unlinkSync,
    default: { ...real, symlinkSync, unlinkSync },
  };
});
afterEach(() => {
  linking.made = [];
  linking.removed = [];
  vi.unstubAllEnvs();
});

// 상한은 실제 시간으로 잰다. 시험이 가짜 시계를 켜도(`vi.useFakeTimers`) 그 시험의 기다림은 상한에서 실패해야 한다. 가짜 시계에 묶이면
// 시험이 시간을 옮기지 않는 한 상한이 지나지 않아, 상한 없는 기다림이 된다.
it("measures its limit in real time while a test fakes the clock", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });

  await expect(
    within(new Promise<never>(() => {}), 50, "nothing arrived")
  ).rejects.toThrow(new Error("nothing arrived within 50 ms"));
}, 5_000);

// 다른 프로세스가 알린 번호는 신호의 대상이 된다. 빈 글자·잘린 글자를 숫자로 바꾸면 0(프로세스 그룹 전체)이나 NaN이 되어, 정리가
// 엉뚱한 대상에 신호하거나 대상 없이 지나간다(#288 외부 리뷰 3회차 STD-4 같은 모양 수색). 그래서 받은 값의 모양을 확인한다.
describe("reportedPid", () => {
  it.each([
    ["4321", 4321],
    ["4321\n", 4321],
    [4321, 4321],
  ])("reads %j as process %i", (value, pid) => {
    expect(reportedPid(value, "the pid file")).toBe(pid);
  });

  it.each([
    "",
    "\n",
    "0",
    "-5",
    "1.5",
    "12abc",
    "4321 Tue",
    0,
    Number.NaN,
    null,
    undefined,
  ])("rejects %j with what it was and what it got", (value) => {
    expect(() => reportedPid(value, "the pid file")).toThrow(
      `the pid file is not a process number: ${JSON.stringify(value)}`
    );
  });
});

// 파일 링크를 만들 수 없는 컴퓨터(권한 없는 Windows)에서 링크 시험은 건너뛴다. 그 건너뜀은 이유와 함께 알리고, CI가 필수로 정했으면
// 건너뛰지 않고 실패해야 시험 수 관문이 잡는다(#286 항목 16). 권한이 없다는 답(EPERM)만 "쓸 수 없음"이고 다른 실패는 그대로 던진다.
describe("fileLinks", () => {
  it("makes one file link in the temporary folder, removes that link and answers yes when links can be made", () => {
    vi.stubEnv("BABOJUBOT_REQUIRE_FILE_LINKS", "1");
    expect(fileLinks()).toBe(true);
    expect(linking.made).toHaveLength(1);
    const [target, link, type] = linking.made[0]!;
    expect(path.dirname(String(link))).toBe(tmpdir());
    expect(target).toBe(`${String(link)}.target`);
    expect(type).toBe("file");
    expect(linking.removed).toEqual([[link]]);
  });

  // 만든 링크를 지우지 못한 것은 링크를 지원한다는 답으로 덮지 않는다. 그 실패로 끝난다.
  it("throws when it cannot remove the link it made", () => {
    vi.stubEnv("BABOJUBOT_REQUIRE_FILE_LINKS", "");
    const fault = { failRemove: "EBUSY", failedAt: [] as string[] };
    expect(() =>
      linkCalls.run(fault, () => fileLinks(), onTestFinished)
    ).toThrow(
      expect.objectContaining({ code: "EBUSY", message: "EBUSY: refused" })
    );
    // 지우기 실패는 그 확인이 만든 링크 하나에서 났다.
    expect(linking.made).toHaveLength(1);
    const link = linking.made[0]![1];
    expect(linking.removed).toEqual([[link]]);
    expect(fault.failedAt).toEqual([String(link)]);
  });

  it("skips saying why when it may not make links and CI does not require them", () => {
    vi.stubEnv("BABOJUBOT_REQUIRE_FILE_LINKS", "");
    const refusal = { refuse: "EPERM", failedAt: [] as string[] };
    const said = vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => said.mockRestore());
    expect(linkCalls.run(refusal, () => fileLinks(), onTestFinished)).toBe(
      false
    );
    // 거절은 그 확인이 만들려던 링크 하나에서 났다.
    expect(linking.made).toHaveLength(1);
    expect(refusal.failedAt).toEqual([String(linking.made[0]![1])]);
    // 만들지 못한 링크는 지울 것이 없다.
    expect(linking.removed).toEqual([]);
    expect(said.mock.calls).toEqual([
      [
        "[파일 링크] 쓸 수 없어 건너뜁니다: 파일 링크를 만들 권한이 없다(EPERM). Windows는 관리자 권한이나 개발자 모드에서만 만든다",
      ],
    ]);
  });

  it("fails instead of skipping when CI requires links and it may not make them", () => {
    vi.stubEnv("BABOJUBOT_REQUIRE_FILE_LINKS", "1");
    const refusal = { refuse: "EPERM", failedAt: [] as string[] };
    expect(() =>
      linkCalls.run(refusal, () => fileLinks(), onTestFinished)
    ).toThrow(
      new Error(
        "BABOJUBOT_REQUIRE_FILE_LINKS=1이라 파일 링크 시험은 필수인데 쓸 수 없다: 파일 링크를 만들 권한이 없다(EPERM). Windows는 관리자 권한이나 개발자 모드에서만 만든다"
      )
    );
    // 거절은 그 확인이 만들려던 링크 하나에서 났다.
    expect(linking.made).toHaveLength(1);
    expect(refusal.failedAt).toEqual([String(linking.made[0]![1])]);
  });

  // 권한 밖의 실패(디스크·임시 폴더 오류)는 링크를 지원하지 않는다는 답이 아니다. 건너뛰지 않고 그 원인으로 실패한다.
  it("throws a failure other than a refused permission as it is, even when CI does not require links", () => {
    vi.stubEnv("BABOJUBOT_REQUIRE_FILE_LINKS", "");
    const refusal = { refuse: "EIO", failedAt: [] as string[] };
    expect(() =>
      linkCalls.run(refusal, () => fileLinks(), onTestFinished)
    ).toThrow(
      expect.objectContaining({ code: "EIO", message: "EIO: refused" })
    );
    // 거절은 그 확인이 만들려던 링크 하나에서 났다.
    expect(linking.made).toHaveLength(1);
    expect(refusal.failedAt).toEqual([String(linking.made[0]![1])]);
  });
});
