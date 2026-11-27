// 서버 진입점 시험의 preload(`node --import`). 시작이 실패한 뒤의 DB 닫기 실패를 만든다: 이 프로세스가 만드는 DB 연결 pool은 닫기
// (`end`)가 실제로 닫은 뒤 실패를 알린다. `pg`의 prototype을 바꾸지 않고, 이 프로세스에서 `pg`를 가져오는 모듈(DB 패키지, drizzle)이
// `Pool`만 하위 클래스로 바꾼 이 모듈을 받게 한다(모듈 대역). 서버 시험은 db와 같은 판의 `pg`를 devDependencies로 선언해 같은 설치
// 폴더의 `pg`를 받는다(다른 패키지의 의존성을 그 패키지 기준으로 찾아 빌려 쓰지 않는다).
// 결함이 실패시킨 닫기는 그 pool의 연결 주소로 `FAIL_DATABASE_CLOSE_RECORD`(그 시험 폴더의 파일)에 한 줄씩 남는다.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import pg from "pg";

const configured = process.env.FAIL_DATABASE_CLOSE_RECORD;
if (!configured)
  throw new Error(
    "FAIL_DATABASE_CLOSE_RECORD (the test's record file) is not set"
  );
const record: string = configured;

class Pool extends pg.Pool {
  override end(): Promise<void>;
  override end(callback: () => void): void;
  override end(callback?: () => void): Promise<void> | void {
    // 제품은 Promise를 돌려주는 갈래만 부른다. 콜백 갈래는 그대로 넘긴다.
    if (callback) return super.end(callback);
    const target = `pool end ${String(this.options.connectionString)}`;
    return super.end().then(() => {
      appendFileSync(record, `${target}\n`);
      throw new Error("injected: closing the database failed");
    });
  }
}

export default { ...pg, Pool };

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 이 모듈이 가져오는 진짜 `pg`만 그대로 찾는다.
    if (specifier === "pg" && context.parentURL !== import.meta.url)
      return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
