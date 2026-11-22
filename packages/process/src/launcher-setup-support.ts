import { beforeAll } from "vitest";

// 세 OS 모두 감독 실행기 없이 프로그램을 띄우지 않는다(#268). 시험 파일마다 checkout에서 빌드한 실행기를 준비한다(시험 실행만 한다).
// 준비하지 못하면 그 파일의 시험을 시작하지 않고 그 이유로 실패한다. 빌드는 `pnpm --filter @babojubot/process run build`다.
//
// 준비 모듈은 시험 파일이 읽힌 뒤(`beforeAll`)에 불러온다. 이 파일은 시험 파일보다 먼저 돌아, 여기서 바로 불러온 제품 모듈은 시험
// 파일의 대역(`vi.mock`)이 등록되기 전에 읽혀 그 대역을 받지 못한다. 그러면 대역을 쓴다고 믿는 시험이 진짜 코드로 통과한다(#274).
beforeAll(async () => {
  const { prepareSupervisor } = await import("./supervisor.ts");
  const supervisor = await prepareSupervisor();
  if (!supervisor.ok)
    throw new Error(
      `the supervisor could not be prepared for the tests: ${supervisor.reason}`
    );
});
