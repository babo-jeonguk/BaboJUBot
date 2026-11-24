// 사람이 돌리는 실제 장애 검사(scripts/chaos-live.mjs)의 Ctrl-C 처리. 첫 Ctrl-C는 지금 장면을 멈추고 정리한 뒤 결과를 남기게 하고,
// 두 번째 Ctrl-C는 바로 끝낸다.
import { afterOutput } from "../exit-after-output.ts";

/** `stop`을 멈추는 첫 Ctrl-C와 바로 끝내는 두 번째 Ctrl-C를 단다. */
export function installUserInterrupt(stop: AbortController) {
  process.on("SIGINT", () => {
    if (stop.signal.aborted) {
      void afterOutput(130).then((code) => process.exit(code));
      return;
    }
    console.error(
      "Stopping: cancelling runs and cleaning up. Press Ctrl-C again to quit now."
    );
    stop.abort(new Error("user interrupt"));
  });
}
