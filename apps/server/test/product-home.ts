import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  folderCleanup,
  removeFolderWithin,
} from "@babojubot/process/test-cleanup";
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

const folder = folderCleanup(() => removeFolderWithin(home));
/**
 * 이 제품 폴더를 쓰는 것(데이터 폴더를 넘기지 않은 서버, 자식 서버)의 끝을 맡긴다. 파일이 끝나면 맡긴 끝을 모두 확인한 뒤에만 폴더를
 * 지우고, 하나라도 확인하지 못하면 폴더를 남기고 실패한다(`folderCleanup`). 맡기는 끝은 여러 번 불러도 같은 결과를 내야 한다(시험의
 * 정리가 먼저 부르고, 여기서 그 결과를 다시 받는다). 시험 파일이 이 파일을 가져와도 setup이 쓴 같은 인스턴스다.
 */
export const ownHome = folder.own;
afterAll(folder.cleanUp);
afterAll(() => {
  vi.unstubAllEnvs();
});
