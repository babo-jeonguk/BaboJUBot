import type http from "node:http";
import { finished, type Duplex, type Readable } from "node:stream";

/**
 * 중계가 목적지로 보낸 요청 하나가 끝난 방식. `complete`는 요청자 응답이 끝까지 쓰인 것, `refused`는 중계가 상류 답 대신 스스로
 * 답하기로 한 것, `cancelled`는 중계가 스스로 끊은 것이다. 나머지는 먼저 끝난 쪽과 그 오류다: 목적지 쪽 요청·상류 답(`upstream`),
 * 거르개, 요청자.
 */
export type AnswerEnd<By extends string> =
  | { by: "complete" }
  | { by: "refused" }
  | { by: "cancelled" }
  | { by: By | "upstream" | "requester"; error: Error };

/** 답이 지나는 흐름 하나와, 그 흐름이 먼저 끝났을 때 알릴 이름. */
type Stage<S, By extends string> = { stream: S; by: By | "upstream" };

export type PassedAnswer<By extends string> = {
  /**
   * 상류 답을 차례로 흐름(`stages`: 상류 답, 그 뒤 거르개들)을 거쳐 요청자 응답으로 흘려보낸다. 상태·머리는 부른 쪽이 먼저 쓴다.
   * `pipe`는 원천의 오류·끊김에 대상을 닫지 않으므로(Node stream 문서 `readable.pipe`) 흐름마다 `finished`로 정상 끝·오류·중간
   * 닫힘을 함께 받는다. 상류·거르개가 정상으로 끝난 것은 아직 답의 끝이 아니다. 요청자가 끝까지 받았을 때 끝난다.
   */
  pass(stages: readonly [Stage<Readable, By>, ...Stage<Duplex, By>[]]): void;
  /**
   * 중계가 상류 답을 넘기지 않고 스스로 답한다(리디렉트·로그인 거부·확인할 수 없는 답). 아직 끝나지 않았으면 `refused`로 알리고
   * 목적지 쪽 요청을 닫는다. 요청자 응답은 부른 쪽이 그 뒤에 쓴다.
   */
  refuse(): void;
  /** 중계가 스스로 끊는다(권한 회수·실행 취소·정책 변경·중계 닫기). 아직 끝나지 않았으면 `cancelled`로 알리고 모두 닫는다. */
  cancel(): void;
};

/**
 * 중계가 목적지로 보낸 요청(`request`) 하나의 끝을 처음부터 한 곳에서 한 번만 알린다. 목적지 쪽 요청의 오류(연결 실패, 답 중간의 HTTP
 * 형식 오류·소켓 오류), 넘기는 흐름의 오류·중간 닫힘, 요청자의 떠남, 중계의 취소 가운데 먼저 온 것 하나가 원인이다. 답이 시작된 뒤의
 * 목적지 쪽 요청 오류도 버리지 않는다: Node는 그 원인을 요청에 알리고, 답 흐름에는 뒤따르는 연결 끊김(`aborted`)만 남긴다.
 * 끝나면 목적지 쪽 요청과 흐름을 닫는다. 머리를 이미 보낸 비정상 끝이면 새 상태를 쓰지 않고 요청자 연결을 끊어, 받은 조각이 끝난
 * 답으로 보이지 않게 한다. 머리 전의 실패면 요청자 응답은 `ended`에서 부른 쪽이 쓴다(502 등). 다른 흐름을 닫는 것은 알린 뒤다.
 */
export function passAnswer<By extends string>(
  request: http.ClientRequest,
  requester: http.ServerResponse,
  ended: (end: AnswerEnd<By>) => void
): PassedAnswer<By> {
  let settled = false;
  let stages: readonly Stage<Readable | Duplex, By>[] = [];
  const settle = (end: AnswerEnd<By>, cutRequester: boolean) => {
    if (settled) return;
    settled = true;
    ended(end);
    request.destroy();
    for (const { stream } of stages) stream.destroy();
    if (cutRequester) requester.destroy();
  };
  const fail = (by: By | "upstream" | "requester", error: Error) =>
    settle({ by, error }, requester.headersSent);
  request.on("error", (error) => fail("upstream", error));
  finished(requester, (error) => {
    if (error) fail("requester", error);
    else settle({ by: "complete" }, false);
  });
  return {
    pass(passed) {
      // 이미 끝났으면(요청자가 떠남·취소) 넘기지 않고 닫는다.
      if (settled) {
        for (const { stream } of passed) stream.destroy();
        return;
      }
      stages = passed;
      for (const { stream, by } of passed)
        finished(stream, (error) => {
          if (error) fail(by, error);
        });
      const [first, ...rest] = passed;
      let flowing: Readable = first.stream;
      for (const { stream } of rest) flowing = flowing.pipe(stream);
      flowing.pipe(requester);
    },
    refuse: () => settle({ by: "refused" }, false),
    cancel: () => settle({ by: "cancelled" }, true),
  };
}
