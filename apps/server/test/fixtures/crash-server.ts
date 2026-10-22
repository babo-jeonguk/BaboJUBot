// 서버 crash 재현용 자식 프로세스. 주어진 DB에 서버를 띄우고, Lead는 가짜 실행기의 기본 시나리오에서 `<멈출 쓰기>`
// (조직 도구 이름 또는 send_message)가 commit된 뒤 멈춰 실행 시도를 끝내지 않는다.
// 부모 테스트가 SIGKILL로 이 프로세스를 끝내 실행 중 실행 시도가 DB에 남은 상태를 만든다.
import type { OrgToolName } from "@babojubot/contracts";
import { openDatabase } from "@babojubot/db";
import {
  createScriptedRuntime,
  defaultScriptSelector,
} from "@babojubot/runtime";
import { holdAfter, writes } from "@babojubot/runtime/testing";
import { startServer } from "../../src/index.ts";

const [url, stopAfter = "send_message"] = process.argv.slice(2);
if (!url)
  throw new Error("usage: crash-server.ts <database url> [<멈출 쓰기>]");
const handle = await openDatabase({ url });
const server = await startServer({
  db: handle.db,
  port: 0,
  runtime: createScriptedRuntime({
    select: (request) =>
      holdAfter(
        defaultScriptSelector(request)!,
        writes(stopAfter as OrgToolName | "send_message"),
        () => new Promise<void>(() => {})
      ),
  }),
});
process.stdout.write(`${JSON.stringify({ url: server.url })}\n`);
