import { settled } from "@babojubot/contracts";

/**
 * 키(경로)마다 일을 하나씩 한다. 한 서버 프로세스 안의 차례다(이 제품 폴더(`BABOJUBOT_HOME`)는 서버 하나가 쓴다).
 * 로그인 링크와 조직 로그인 자리가 같은 자리를 확인하고 바꾸는 일을 이 차례로 한다.
 */
const turns = new Map<string, Promise<unknown>>();
export function oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = settled(turns.get(key) ?? Promise.resolve()).then(task);
  turns.set(key, next);
  void settled(
    next.finally(() => {
      if (turns.get(key) === next) turns.delete(key);
    })
  );
  return next;
}
