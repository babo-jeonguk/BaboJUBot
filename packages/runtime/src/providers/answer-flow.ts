import type http from "node:http";
import { finished, type Duplex, type Readable } from "node:stream";

/** 중계가 넘기던 답이 끝난 방식. `complete`만 요청자가 답을 끝까지 받은 것이고, 나머지는 먼저 끝난 흐름과 그 오류다. */
export type AnswerEnd<By extends string> =
  { by: "complete" } | { by: By | "requester"; error: Error };

/** 답이 지나는 흐름 하나와, 그 흐름이 먼저 끝났을 때 알릴 이름. */
type Stage<S, By extends string> = { stream: S; by: By };

/**
 * 상류 답을 차례로 흐름(`stages`: 상류 답, 그 뒤 거르개들)을 거쳐 요청자 응답(`requester`)으로 흘려보내고, 정상·비정상 끝을 한 번만
 * 알린다. `pipe`는 원천의 오류·끊김에 대상을 닫지 않는다(Node stream 문서 `readable.pipe`). 그래서 흐름마다 `finished`로 정상 끝·
 * 오류·중간 닫힘을 함께 받고, 가장 먼저 끝난 흐름을 원인으로 본다. 상류가 끊으면 상류 흐름이, 요청자가 떠나면 요청자 흐름이 먼저
 * 끝난다(이 함수가 다른 흐름을 닫는 것은 알린 뒤다). 비정상 끝이면 모든 흐름을 닫는다. 머리를 이미 보냈으므로 새 상태를 쓰지 않고
 * 요청자 연결을 끊어, 받은 조각이 끝난 답으로 보이지 않게 한다.
 */
export function passAnswer<By extends string>(
  stages: readonly [Stage<Readable, By>, ...Stage<Duplex, By>[]],
  requester: http.ServerResponse,
  ended: (end: AnswerEnd<By>) => void
): void {
  let settled = false;
  const settle = (end: AnswerEnd<By>) => {
    if (settled) return false;
    settled = true;
    ended(end);
    return true;
  };
  const fail = (by: By | "requester", error: Error) => {
    if (!settle({ by, error })) return;
    for (const { stream } of stages) stream.destroy();
    requester.destroy();
  };
  // 상류·거르개가 정상으로 끝난 것은 아직 답의 끝이 아니다. 요청자가 끝까지 받았을 때(`finish`) 끝난다.
  for (const { stream, by } of stages)
    finished(stream, (error) => {
      if (error) fail(by, error);
    });
  finished(requester, (error) => {
    if (error) fail("requester", error);
    else settle({ by: "complete" });
  });
  const [first, ...rest] = stages;
  let flowing: Readable = first.stream;
  for (const { stream } of rest) flowing = flowing.pipe(stream);
  flowing.pipe(requester);
}
