// 서버 진입점 시험의 preload(`node --import`). DB 연결 pool을 닫으면 실제로 닫은 뒤 실패를 알린다.
// 시작이 실패한 뒤의 DB 닫기 실패를 만든다. DB 패키지가 쓰는 것과 같은 `pg` 모듈을 고친다(서버 패키지는 `pg`에 의존하지 않는다).
import { createRequire } from "node:module";

type PoolPrototype = { end: (this: unknown) => Promise<void> };
const requireFromDb = createRequire(import.meta.resolve("@babojubot/db"));
const pg = requireFromDb("pg") as { Pool: { prototype: PoolPrototype } };
const end = pg.Pool.prototype.end;
pg.Pool.prototype.end = async function () {
  await end.call(this);
  throw new Error("injected: closing the database failed");
};
