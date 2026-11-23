import { configDefaults, defineConfig } from "vitest/config";
import { suiteTest } from "../../vitest.reports.ts";
import server from "./vitest.config.ts";

// 실제 OpenCode CLI + 이 컴퓨터의 가짜 모델 검사(test/opencode-real-cli.test.ts). 서버 시험과 같은 준비(시험용 DB·제품 폴더·감독
// 실행기)를 쓰고 파일 고르기와 보고서만 다르다(묶음 정의 scripts/test-suites.ts의 server-opencode). CI는 CLI를 설치한 job에서 돈다.
export default defineConfig({
  test: { ...server.test, ...suiteTest("server-opencode", configDefaults) },
});
