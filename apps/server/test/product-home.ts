import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import { afterAll, beforeEach, vi } from "vitest";

// 테스트 파일마다 임시 제품 폴더를 쓴다. 데이터 폴더를 넘기지 않은 서버와 자식 서버(main.ts)도 BABOJUBOT_HOME을 따르므로
// 조직 폴더가 저장소(apps/server/.babojubot, 루트 .babojubot)에 쌓이지 않는다. 파일의 hook(beforeAll)도 이 값을 보게 처음에
// 걸고, 시험이 자기 stub을 `vi.unstubAllEnvs()`로 돌려놓으면 이 값도 함께 풀리므로 시험마다 다시 건다. 파일이 끝나면
// 시작 전 값으로 돌려놓고 폴더를 지운다(정리는 나중에 등록한 것부터 돈다).
const home = mkdtempSync(path.join(tmpdir(), "babojubot-server-test-"));
vi.stubEnv("BABOJUBOT_HOME", home);
beforeEach(() => {
  vi.stubEnv("BABOJUBOT_HOME", home);
});

afterAll(() => removeFolder(home));
afterAll(() => {
  vi.unstubAllEnvs();
});
