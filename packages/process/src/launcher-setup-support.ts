import { prepareSupervisor } from "./supervisor.ts";

// 세 OS 모두 감독 실행기 없이 프로그램을 띄우지 않는다(#268). 시험 파일마다 checkout에서 빌드한 실행기를 준비한다(시험 실행만 한다).
// 준비하지 못하면 시험을 시작하지 않고 그 이유로 실패한다. 빌드는 `pnpm --filter @babojubot/process run build`다.
const supervisor = await prepareSupervisor();
if (!supervisor.ok)
  throw new Error(
    `the supervisor could not be prepared for the tests: ${supervisor.reason}`
  );
