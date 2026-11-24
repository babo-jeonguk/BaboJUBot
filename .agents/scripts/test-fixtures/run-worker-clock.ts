// run-worker.test.ts가 띄우는 runner. 제품 진입점(run-worker.ts)과 같은 호출(`runWorker`)을 돌리되, 세션 확인·한도를 시험이 IPC로
// 옮기는 시계로 잰다. 제품 진입점에는 시계를 바꾸는 길을 두지 않는다(apps/server/test/clock-server.ts와 같은 방식). 시험은 worker의
// 준비(연결)를 본 뒤에만 시계를 옮겨, 한도가 실행기 속도와 상관없이 정한 차례에 온다(#286 항목 33).
// 메시지는 `{ advance: <ms> }` 하나다. 다른 모양은 시험의 잘못이라 던져 runner를 실패로 끝낸다.
import { manualClock } from "@babojubot/process/test-support";
import { runWorker } from "../run-worker.ts";

const clock = manualClock();
if (!process.send) throw new Error("run-worker-clock needs an IPC channel");
process.on("message", (message: unknown) => {
  const ms =
    typeof message === "object" && message !== null && "advance" in message
      ? message.advance
      : undefined;
  if (typeof ms !== "number")
    throw new Error(`not a clock message: ${JSON.stringify(message)}`);
  clock.advance(ms);
});
await runWorker(process.argv.slice(2), clock);
