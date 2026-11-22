// 서버 재시작 복구(@babojubot/runtime의 providers/recovery.ts)만 쓰는 좁은 입구: 그룹 끄기와 표식 정리, 기록한 프로세스의 신원 확인.
// 다른 곳은 띄울 때 launchTree가 돌려준 stop()으로 끈다. 이 입구를 가져오는 곳은 lint(product/package-import-scope)가 묶는다.
export { groupAlive, identity, members, stopProcessGroup } from "./group.ts";
export {
  holdsLease,
  leaseVariable,
  processStartTicks,
  stopLeaseHolders,
} from "./lease.ts";
