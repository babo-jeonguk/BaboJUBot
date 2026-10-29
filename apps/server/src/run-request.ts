import type { RunRequest } from "@babojubot/contracts";
import { loadRunContext, type ClaimedRun, type Database } from "@babojubot/db";

/**
 * 실행 시도 요청 한 장을 만든다. admission(`claimNextRun`)이 고정한 깨우기 묶음·지침 사본·bundle 버전·이전 세션에
 * 실행 맥락 조회와 같은 신원·맥락 묶음, 이 실행 시도의 토큰과 도구 주소, workspace를 더한다.
 * workspace는 연구 환경 구성을 정하는 판 2 전까지 없다(`null`).
 * 실행 시도가 사라졌으면 throw한다.
 */
export async function assembleRunRequest(
  db: Database,
  { run, wakeReasons, instructions }: ClaimedRun,
  access: { toolsBaseUrl: string; token: string }
): Promise<RunRequest> {
  const loaded = await loadRunContext(db, run.id);
  if (!loaded) throw new Error(`run ${run.id} disappeared`);
  return {
    identity: loaded.identity,
    access,
    wakeReasons,
    context: loaded.context,
    instructionsBundleVersion: run.instructionsBundleVersion,
    instructions,
    workspace: null,
    previousSession: run.sessionBefore,
  };
}
