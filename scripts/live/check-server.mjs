// 사람이 돌리는 실제 프로바이더 확인(provider-live·provider-smoke)의 서버 자원. 임시 제품 폴더·임시 DB·서버를 열고, 확인이
// 끝나면 성공·실패와 상관없이 서버 닫기·DB 닫기·폴더 지우기를 모두 시도한다. 앞 정리가 실패해도 뒤 정리를 하고, 정리 실패는
// 원래 실패와 함께 알린다(CODING_STANDARDS.md#제품-코드). 정리 순서와 실패 묶음은 시험 정리와 같은 withCleanup이 맡는다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withCleanup } from "@babojubot/process/test-cleanup";

/**
 * `prefix`로 임시 폴더를 만들고 `openDatabase()`로 DB를, `startServer({ database, workspace })`로 서버를 연 뒤 `check`를 돌린다.
 * 자원은 잡은 직후 정리를 등록하므로 DB 열기나 서버 시작이 실패해도 그때까지 잡은 것을 거둔다. `check`의 결과를 돌려준다.
 */
export function withCheckServer({ prefix, openDatabase, startServer }, check) {
  return withCleanup(async (defer) => {
    const workspace = await mkdtemp(path.join(tmpdir(), prefix));
    defer(() => rm(workspace, { recursive: true, force: true }));
    const database = await openDatabase();
    defer(() => database.close());
    const server = await startServer({ database, workspace });
    defer(() => server.close());
    return check({ workspace, database, server });
  });
}
