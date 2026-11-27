// 이 파일은 `vi.mock("node:os")` 대역의 factory가 불러온다. 그래서 이 파일은 `node:os`를 형으로만 불러오고, 그 builtin을 값으로
// 불러오는 모듈(@babojubot/process의 `test-support.ts` 등 — `connect-failure-support.ts`가 불러옴)을 불러오지 않는다. 값으로 불러오면
// 대역이 만들어지기 전에 자기 자신을 기다려 시험이 불러오는 단계에서 멈춘다.
import type * as osModule from "node:os";

import { callArming } from "@babojubot/process/call-arming";

// 이 컴퓨터의 주소 조회(`os.networkInterfaces`) 실패를 넣는다. 저장소가 OS 호출 실패를 넣는 방식(`vi.mock`의 모듈 대역)으로
// 그 경계를 감싸고(객체·전역의 메서드를 바꾸지 않는다), 그 밖에는 진짜와 같다. 주소 조회에는 고를 경로가 없으므로 결함은 그 시험이
// 부른 제품 호출의 문맥에 묶는다(`failingInterfacesDuring`). `call-arming`은 node 기본 모듈을 값으로 불러오지 않는다.
//
// 시험 파일에서: `vi.mock("node:os", async (importOriginal) => (await import("./os-failure-support.ts")).failingOs(await importOriginal()))`.

/** 주소 조회 결함. 시험이 `failing`을 켠 동안 그 호출 안의 조회가 실패하고, 실패시킨 조회 수를 `failed`에 센다. */
type InterfaceFault = { cause: string; failing: boolean; failed: number };
const interfaceCalls = callArming<InterfaceFault>();

/**
 * 제품 호출 `call`(그 시험이 부른 것, 그것이 만든 중계의 처리기 포함) 안에서 `fault.failing`을 켠 동안 `networkInterfaces`가 Node가
 * 그 조회(libuv `uv_interface_addresses`)의 실패에 던지는 것과 같은 모양(`code: "ERR_SYSTEM_ERROR"`, `info`에 원인 코드·syscall)으로
 * 던진다. 처음에는 꺼져 있고, `call`이 받은 결함으로 시험이 켠다. 무장의 끝은 `own`(그 시험의 정리)에 맡긴다. 결함(켜기·실패 수)과 호출의 결과를 돌려준다.
 */
export function failingInterfacesDuring<T>(
  own: (step: () => Promise<void>) => void,
  cause: string,
  call: (fault: InterfaceFault) => T
) {
  const fault: InterfaceFault = { cause, failing: false, failed: 0 };
  const result = interfaceCalls.run(fault, () => call(fault), own);
  return { fault, result };
}

/** `node:os` 대역: 그 시험의 호출 문맥에서 주소 조회 결함이 켜진 동안 `networkInterfaces`가 실패한다. 그 밖의 함수는 진짜다. */
export function failingOs(real: typeof osModule) {
  const passThrough = real.networkInterfaces;
  const networkInterfaces = (() => {
    const fault = interfaceCalls.current();
    if (!fault?.failing) return passThrough();
    fault.failed += 1;
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
