// 이 파일은 `vi.mock("node:os")` 대역의 factory가 불러온다. 그래서 이 파일은 `node:os`를 형으로만 불러오고, 그 builtin을 값으로
// 불러오는 모듈(@babojubot/process의 `test-support.ts` 등 — `connect-failure-support.ts`가 불러옴)을 불러오지 않는다. 값으로 불러오면
// 대역이 만들어지기 전에 자기 자신을 기다려 시험이 불러오는 단계에서 멈춘다.
import type * as osModule from "node:os";

// 이 컴퓨터의 주소 조회(`os.networkInterfaces`) 실패를 넣는다. 저장소가 OS 호출 실패를 넣는 방식(`vi.mock`의 모듈 대역)으로
// 그 경계를 감싸고, 정한 동안만 실패시키며 그 밖에는 진짜와 같다(객체·전역의 메서드를 바꾸지 않는다).
//
// 시험 파일에서: `vi.mock("node:os", async (importOriginal) => (await import("./os-failure-support.ts")).failingOs(await importOriginal()))`.
// 시험마다 `osFaults.interfaces`를 정하고, 끝나면 `connect-failure-support.ts`의 `resetRefusing()`이 `resetOsFaults()`로 함께 푼다.

export const osFaults = {
  /**
   * 정한 동안 `networkInterfaces`가 Node가 그 조회(libuv `uv_interface_addresses`)의 실패에 던지는 것과 같은 모양
   * (`code: "ERR_SYSTEM_ERROR"`, `info`에 원인 코드·syscall)으로 던진다.
   */
  interfaces: undefined as { cause: string } | undefined,
};

export function resetOsFaults() {
  osFaults.interfaces = undefined;
}

/** `node:os` 대역: `osFaults.interfaces`가 정한 동안 `networkInterfaces`가 실패한다. 그 밖의 함수는 진짜다. */
export function failingOs(real: typeof osModule) {
  const passThrough = real.networkInterfaces;
  const networkInterfaces = (() => {
    const fault = osFaults.interfaces;
    if (!fault) return passThrough();
    throw Object.assign(
      new Error(
        `A system error occurred: uv_interface_addresses returned ${fault.cause}`
      ),
      {
        code: "ERR_SYSTEM_ERROR",
        info: { code: fault.cause, syscall: "uv_interface_addresses" },
      }
    );
  }) as typeof real.networkInterfaces;
  return {
    ...real,
    networkInterfaces,
    default: { ...real, networkInterfaces },
  };
}
