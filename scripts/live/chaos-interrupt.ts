// 사람이 돌리는 실제 장애 검사(scripts/chaos-live.mjs)의 Ctrl-C 처리. 첫 Ctrl-C는 지금 장면을 멈추고 정리한 뒤 결과를 남기게 하고,
// 두 번째 Ctrl-C는 바로 끝낸다.
/** `stop`을 멈추는 첫 Ctrl-C와 바로 끝내는 두 번째 Ctrl-C를 단다. */
export function installUserInterrupt(stop: AbortController) {
  process.on("SIGINT", () => {
    if (stop.signal.aborted) {
      // 비상 종료: 출력이 다 닿기를 기다리지 않는다(afterOutput을 쓰지 않는다). 사용자가 바로 끝내라고 했고, 표준 출력을 아무도
      // 읽지 않으면 출력은 영영 닿지 않아 기다리면 끝날 길이 없다. 정상 종료와 사용법 오류는 출력을 다 보낸 뒤 끝낸다.
      process.exit(130);
    }
    console.error(
      "Stopping: cancelling runs and cleaning up. Press Ctrl-C again to quit now."
    );
    stop.abort(new Error("user interrupt"));
  });
}
