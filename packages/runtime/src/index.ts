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
export * from "./providers/recovery.ts";
export * from "./providers/login.ts";
export * from "./providers/container.ts";
export * from "./providers/credential-relay.ts";

const kinds = {
  claude: createClaudeProvider,
  codex: createCodexProvider,
  opencode: createOpenCodeProvider,
  antigravity: createAntigravityProvider,
};
/** `claude` 또는 `claude:work`로 연결을 만든다. 뒤의 이름은 같은 프로그램의 다른 계정을 구분한다. */
export function createConnection(
  name: string,
  options: {
    dataDir: string;
    mode?: "app-server" | "exec";
    container?: ContainerSettings;
  }
) {
  const [kind, account] = name.split(":") as [string, string | undefined];
  if (!(kind in kinds)) throw new Error(`Unknown provider connection: ${name}`);
  const create = kinds[kind as keyof typeof kinds] as (options: {
    dataDir: string;
    mode?: "app-server" | "exec";
    id?: string;
    label?: string;
    container?: ContainerSettings;
  }) => ProviderConnection;
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
