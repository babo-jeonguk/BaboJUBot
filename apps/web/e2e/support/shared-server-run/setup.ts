import { writeFileSync } from "node:fs";
import { startSharedServer } from "../../global-setup.ts";

// 공용 서버가 뜨면 바깥 시험이 정리를 확인할 수 있게 서버·Postgres·폴더를 적는다. SHARED_SERVER_RUN_FAIL_SETUP이면
// 정리 함수를 돌려주기 전에(자원을 얻은 뒤) 실패한다.
export default function setup() {
  return startSharedServer({
    port: 0,
    afterStart: (server) => {
      process.env.SHARED_SERVER_URL = server.url;
      writeFileSync(
        process.env.SHARED_SERVER_RUN_STATE!,
        JSON.stringify({
          pid: server.pid,
          postgresPid: server.postgresPid,
          folder: server.folder,
        })
      );
      if (process.env.SHARED_SERVER_RUN_FAIL_SETUP)
        throw new Error("setup failed on purpose");
    },
  });
}
