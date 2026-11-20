// 서버 진입점 시험의 preload(`node --import`). DB 연결 pool을 닫으면 실제로 닫은 뒤 실패를 알린다.
// 시작이 실패한 뒤의 DB 닫기 실패를 만든다. DB 패키지가 쓰는 것과 같은 `pg` 모듈을 고친다: 서버 시험은 db와 같은 판을
// devDependencies로 선언해 같은 설치 폴더의 `pg`를 받는다(다른 패키지의 의존성을 그 패키지 기준으로 찾아 빌려 쓰지 않는다).
import pg from "pg";

// 콜백을 받지 않는 갈래(Promise를 돌려줌)만 쓴다.
const end = pg.Pool.prototype.end as (this: pg.Pool) => Promise<void>;
pg.Pool.prototype.end = async function () {
  await end.call(this);
  throw new Error("injected: closing the database failed");
};
