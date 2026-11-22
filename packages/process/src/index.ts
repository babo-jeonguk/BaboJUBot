// 프로그램 띄우기·끄기의 바탕(#266). 오래 도는 자식은 launchTree가 띄우면서 그 트리의 끄기(stop)를 함께 돌려주고, 끝까지 돌릴 짧은 명령은
// runTree가, 공용 실행 위에 놓을 수 없는 짧은 명령은 runCommand가 시한에 끝을 보장한다. 의존은 contracts와 cross-spawn뿐이다.
export {
  launchTree,
  prepareJobObjectLauncher,
  prepareSupervisor,
  requireJobObject,
  runTree,
  TreeLaunchRefused,
  type LaunchedTree,
  type TreeExit,
  type TreeLaunch,
  type TreeRun,
  type TreeStart,
  type TreeStdio,
} from "./launch.ts";
export {
  boundChild,
  runCommand,
  type BoundedExit,
  type BoundedRun,
  type WatchedChild,
} from "./bounded-command.ts";
export { psField } from "./ps.ts";
export { realClock, type Clock } from "./clock.ts";
