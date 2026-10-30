import type { RunRequest } from "@babojubot/contracts";
import { loadRunContext, type ClaimedRun, type Database } from "@babojubot/db";

/** admission이 고정한 실행 시도와 그 토큰으로 실행 시도 요청 한 장을 만든다. 실행 시도가 사라졌으면 throw한다. */
export type RunRequestAssembler = (
  claimed: ClaimedRun,
  token: string
) => Promise<RunRequest>;

/**
 * 실행 시도 요청 조립. admission(`claimNextRun`)이 고정한 깨우기 묶음·지침 사본·bundle 버전·모델·이전 세션에
 * 실행 맥락 조회와 같은 신원·맥락 묶음, 이 실행 시도의 토큰과 조직 도구 주소, workspace를 더한다.
 * 도구 주소는 서버가 listen한 뒤에 정해지므로 부를 때 읽는다. workspace는 연구 환경 구성을 정하는 판 2 전까지 없다(`null`).
 */
export function createRunRequestAssembler({
  db,
  toolsBaseUrl,
}: {
  db: Database;
  toolsBaseUrl: () => string;
}): RunRequestAssembler {
  return async ({ run, wakeReasons, instructions }, token) => {
    const loaded = await loadRunContext(db, run.id);
    if (!loaded) throw new Error(`run ${run.id} disappeared`);
    return {
      identity: loaded.identity,
      access: { toolsBaseUrl: toolsBaseUrl(), token },
      wakeReasons,
      context: loaded.context,
      instructionsBundleVersion: run.instructionsBundleVersion,
      instructions,
      workspace: null,
      model: run.model,
      previousSession: run.sessionBefore,
    };
  };
}
