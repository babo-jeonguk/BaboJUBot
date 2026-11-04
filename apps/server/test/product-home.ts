import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// 테스트 파일마다 임시 제품 폴더를 쓴다. 데이터 폴더를 넘기지 않은 서버와 자식 서버(main.ts)도 BABOJUBOT_HOME을 따르므로
// 조직 폴더가 저장소(apps/server/.babojubot, 루트 .babojubot)에 쌓이지 않는다.
const home = mkdtempSync(path.join(tmpdir(), "babojubot-server-test-"));
process.env.BABOJUBOT_HOME = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});
