// 서버 crash 재현용 자식 프로세스. 주어진 DB에 서버를 띄우고, Lead는 답장을 남긴 뒤 멈춰 실행 시도를 끝내지 않는다.
// 부모 테스트가 SIGKILL로 이 프로세스를 끝내 실행 중 실행 시도가 DB에 남은 상태를 만든다.
import { openDatabase } from "@babojubot/db";
import { createScriptedRuntime, leadReplyScript } from "@babojubot/runtime";
import { startServer } from "../../src/index.ts";

const url = process.argv[2];
if (!url) throw new Error("usage: crash-server.ts <database url>");
const handle = await openDatabase({ url });
const server = await startServer({
  db: handle.db,
  port: 0,
  runtime: createScriptedRuntime({
    select: () => ({
      ...leadReplyScript,
      steps: [
        ...leadReplyScript.steps,
        { do: "hold", until: () => new Promise<void>(() => {}) },
      ],
    }),
  }),
});
process.stdout.write(`${JSON.stringify({ url: server.url })}\n`);
