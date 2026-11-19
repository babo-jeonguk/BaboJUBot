// 프로세스 그룹 끄기의 공용 진입점. 스크립트(.agents/scripts/run-worker.mjs)가 제품과 같은 끄기를 쓰도록 이것만 연다.
// 그룹 생존 확인·SIGTERM·유예·SIGKILL·상한 있는 확인은 providers/recovery.ts가 맡는다. 음수 pid에 신호를 보내는 일은 그 파일만 한다(lint).
export { stopProcessGroup } from "./providers/recovery.ts";
