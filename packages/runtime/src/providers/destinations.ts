import type { Destination } from "@babojubot/contracts";

/**
 * 연결마다 격리 실행이 늘 여는 모델·로그인 목적지(#149). 초기 연구 승인 전 Lead 계획 수립에도 필요한 최소 통신이며,
 * 조직의 연구 목적지(사용자 허용 목록)와 따로 둔다. 다른 모델 서버를 쓰는 연결(OpenCode의 다른 제공자, 내부 모델 서버)은
 * 운영자가 서버 시작 때 `BABOJUBOT_MODEL_DESTINATIONS`로 더한다. 에이전트·공유 파일·모델 출력으로는 넓히지 않는다.
 * 원격 측정·오류 보고처럼 실행에 꼭 필요하지 않은 목적지는 넣지 않는다(거부되어도 실행은 이어진다).
 */
export const providerDestinations = {
  // 네 연결 모두 인증 중계(#148)에 붙어, 모델 통신이 실행 시도 중계의 조직 도구 연결(`/api/relay/<연결>`)로만 나간다.
  // 프로바이더로 직접 나가는 목적지를 열지 않는다. 다른 모델 서버는 운영자가 `BABOJUBOT_MODEL_DESTINATIONS`로 더한다.
  claude: [],
  codex: [],
  // Antigravity(`agy acp`): 로그인 확인(www.googleapis.com)·사용 기록은 중계로 보낼 수 없지만 ACP에서는 실패해도 실행이 이어진다.
  antigravity: [],
  opencode: [],
} as const satisfies Record<string, readonly Destination[]>;
