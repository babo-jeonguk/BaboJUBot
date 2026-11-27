import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAntigravityProvider } from "./antigravity.ts";
import { createClaudeProvider } from "./claude.ts";
import { createCodexProvider } from "./codex.ts";
import type { testFolders } from "./test-folders.ts";

export const quirky = (kind: string, variant: string) =>
  [
    process.execPath,
    path.resolve("test-fixtures/quirky-cli.synthetic.mjs"),
    kind,
    variant,
  ] as [string, ...string[]];

export const control = (
  emit: (activity: unknown) => Promise<void> = async () => {}
) => ({
  signal: new AbortController().signal,
  emit,
});

/** 이 시험들이 쓰는 CLI 연결. 만든 연결은 시험 정리가 실행을 맡는다(`testFolders().owning`). */
export const cliAdapters = (
  folders: Pick<ReturnType<typeof testFolders>, "owning">
) => ({
  claude: folders.owning((dataDir: string, variant: string) =>
    createClaudeProvider({ dataDir, command: quirky("claude", variant) })
  ),
  "codex app-server": folders.owning((dataDir: string, variant: string) =>
    createCodexProvider({ dataDir, command: quirky("codex", variant) })
  ),
  "codex exec": folders.owning((dataDir: string, variant: string) =>
    createCodexProvider({
      dataDir,
      mode: "exec",
      command: quirky("codex", variant),
    })
  ),
  antigravity: folders.owning((dataDir: string, variant: string) =>
    createAntigravityProvider({
      dataDir,
      command: quirky("antigravity", variant),
    })
  ),
});

/**
 * 로그인이 든 CLI 홈. 시험의 폴더 정리(`make`)가 만들기를 시작 순간 맡으므로, 시험이 만들기 도중 끝나도 정리가 그 끝을 확인한 뒤
 * 지운다.
 */
export async function createCliHome(
  folders: Pick<ReturnType<typeof testFolders>, "make">
): Promise<string> {
  const root = await folders.make("babojubot-tolerance-");
  await mkdir(path.join(root, "providers/claude"), { recursive: true });
  await writeFile(path.join(root, "providers/claude/setup-token"), "login");
  return root;
}
