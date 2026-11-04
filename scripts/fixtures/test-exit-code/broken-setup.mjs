// 시험용 DB가 뜨지 못한 상황. 실제 globalSetup처럼 embedded Postgres를 싣는 모듈을 실은 뒤 실패한다.
import "../../../packages/db/src/client.ts";

export default function brokenSetup() {
  throw new Error("test database failed to start");
}
