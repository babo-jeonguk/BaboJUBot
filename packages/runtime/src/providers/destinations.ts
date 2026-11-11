import type { Destination } from "@babojubot/contracts";

/**
 * 연결마다 격리 실행이 늘 여는 모델·로그인 목적지(#149). 초기 연구 승인 전 Lead 계획 수립에도 필요한 최소 통신이며,
 * 조직의 연구 목적지(사용자 허용 목록)와 따로 둔다. 다른 모델 서버를 쓰는 연결(OpenCode의 다른 제공자, 내부 모델 서버)은
 * 운영자가 서버 시작 때 `BABOJUBOT_MODEL_DESTINATIONS`로 더한다. 에이전트·공유 파일·모델 출력으로는 넓히지 않는다.
 * 원격 측정·오류 보고처럼 실행에 꼭 필요하지 않은 목적지는 넣지 않는다(거부되어도 실행은 이어진다).
 */
const https = (...hosts: string[]): Destination[] =>
  hosts.map((host) => ({ host, port: 443 }));

export const providerDestinations = {
  // Claude Code: API와 로그인 갱신.
  claude: https(
    "api.anthropic.com",
    "console.anthropic.com",
    "platform.claude.com",
    "claude.ai"
  ),
  // Codex: API, ChatGPT 로그인과 그 API.
  codex: https("api.openai.com", "chatgpt.com", "auth.openai.com"),
  // OpenCode: 기본 제공자(OpenCode Zen·Go)와 모델 목록.
  opencode: https("opencode.ai", "*.opencode.ai", "models.dev"),
  // Antigravity CLI: Google 로그인과 Google API.
  antigravity: https(
    "accounts.google.com",
    "oauth2.googleapis.com",
    "*.googleapis.com"
  ),
} as const satisfies Record<string, readonly Destination[]>;
