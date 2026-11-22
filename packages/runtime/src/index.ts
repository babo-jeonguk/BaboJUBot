import type { ProviderConnection } from "@babojubot/contracts";
import { createClaudeProvider } from "./providers/claude.ts";
import { createCodexProvider } from "./providers/codex.ts";
import { createOpenCodeProvider } from "./providers/opencode.ts";
import { createAntigravityProvider } from "./providers/antigravity.ts";
import type { ContainerSettings } from "./providers/container.ts";

// Agent Runtime: 프로바이더 adapter(가짜부터), job runner adapter, 채널 adapter.
export * from "./scripted.ts";
export * from "./providers.ts";
export * from "./tools-client.ts";
export * from "./fake-channel.ts";
export * from "./providers/claude.ts";
export * from "./providers/codex.ts";
export * from "./providers/opencode.ts";
export * from "./providers/antigravity.ts";
// 재시작 복구만 연다. 그룹 끄기는 @babojubot/process의 공용 실행과 이 복구만 쓴다(lint).
export { recoverProviderProcesses } from "./providers/recovery.ts";
// 프로그램에 그대로 넘기는 환경 변수 목록. 제품 서버를 띄우는 개발 스크립트(chaos-server)도 같은 목록을 쓴다.
export { sharedVariables } from "./providers/process.ts";
export * from "./providers/login.ts";
export * from "./providers/container.ts";
export * from "./providers/credential-relay.ts";
export * from "./providers/relay.ts";
export * from "./providers/egress-policy.ts";
export * from "./providers/destinations.ts";

type ConnectionOptions = {
  dataDir: string;
  mode?: "app-server" | "exec";
  id?: string;
  label?: string;
  container?: ContainerSettings;
};
// 연결 이름은 사용자 설정(BABOJUBOT_PROVIDERS)과 로그인 명령 인수에서 온다. 일반 객체로 찾으면 물려받은 이름(constructor)도
// 종류로 통과하므로 Map으로 찾는다(CODING_STANDARDS.md#제품-코드).
const kinds = new Map<
  string,
  (options: ConnectionOptions) => ProviderConnection
>([
  ["claude", createClaudeProvider],
  ["codex", createCodexProvider],
  ["opencode", createOpenCodeProvider],
  ["antigravity", createAntigravityProvider],
]);
/** `claude` 또는 `claude:work`로 연결을 만든다. 뒤의 이름은 같은 프로그램의 다른 계정을 구분한다. */
export function createConnection(
  name: string,
  options: {
    dataDir: string;
    mode?: "app-server" | "exec";
    container?: ContainerSettings;
  }
) {
  const [kind = "", account] = name.split(":");
  const create = kinds.get(kind);
  if (!create) throw new Error(`Unknown provider connection: ${name}`);
  const base = create({
    dataDir: options.dataDir,
    mode: options.mode,
    container: options.container,
  });
  if (!account) return base;
  return create({
    dataDir: options.dataDir,
    mode: options.mode,
    id: `${kind}-${account}`,
    label: `${base.label} (${account})`,
    container: options.container,
  });
}
