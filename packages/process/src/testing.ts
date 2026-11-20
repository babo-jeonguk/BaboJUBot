// 프로그램을 띄우고 끄는 시험이 함께 쓰는 vitest 시험 도움. vitest 밖(node:test 스크립트·Playwright)에서는 쓰지 않는다.
// vitest 없이 쓰는 정리 도움은 `@babojubot/process/test-cleanup`·`/remove-folder`·`/lifelines`에 있다.
export { testFolders } from "./test-folders.ts";
export {
  exited,
  killAndWait,
  readyLine,
  untilExited,
} from "./process-test-support.ts";
export {
  commandFailure,
  manualClock,
  probeEnvironment,
} from "./test-support.ts";
