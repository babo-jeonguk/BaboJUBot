// 시험이 띄운 프로그램이 쥐는 연결(`packages/runtime/src/providers/lifeline-support.ts`의 `hold`가 이 파일을 불러 부른다).
// 판정은 제품과 같은 것을 가져다 쓴다: 끊김(`isDisconnect`)은 답이고, 그 밖의 실패(연결 거절 등)는 오류 출력에 짧은 이름을 남긴다.
import { failureCode, isDisconnect } from "../../contracts/src/failure.ts";

/** `port`의 연결 서버에 연결해 `name`을 보내고 연결을 쥔다. 서버가 받았다고 답하면 `then`을 부른다. */
export function hold(port, name, then) {
  const line = process.getBuiltinModule("node:net").connect(port, "127.0.0.1");
  line.on("error", (error) => {
    if (!isDisconnect(error))
      process.stderr.write(
        `[lifeline] ${name} failed (${failureCode(error)})\n`
      );
  });
  line.write(`${name}\n`);
  line.once("data", then);
}
