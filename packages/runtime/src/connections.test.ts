import { describe, expect, it } from "vitest";
import { createConnection } from "./index.ts";

// 연결 이름은 사용자 설정(BABOJUBOT_PROVIDERS)과 로그인 명령 인수에서 온다. 정한 종류 밖의 이름은 모든 객체가 물려받는
// 이름(constructor·toString)이어도 알 수 없는 연결로 거절한다(#281 리뷰 REC-1과 같은 모양).
describe("createConnection", () => {
  it.each(["constructor", "toString", "constructor:work", "nobody"])(
    "refuses the unknown connection %s",
    (name) => {
      expect(() => createConnection(name, { dataDir: "/unused" })).toThrow(
        `Unknown provider connection: ${name}`
      );
    }
  );
});
