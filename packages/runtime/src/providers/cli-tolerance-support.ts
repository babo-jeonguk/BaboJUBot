import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAntigravityProvider } from "./antigravity.ts";
import { createClaudeProvider } from "./claude.ts";
import { createCodexProvider } from "./codex.ts";

export const quirky = (kind: string, variant: string) =>
  [
    process.execPath,
    path.resolve("test-fixtures/quirky-cli.synthetic.mjs"),
    kind,
    variant,
  ] as [string, ...string[]];

export const control = (emit: () => Promise<void> = async () => {}) => ({
  signal: new AbortController().signal,
  emit,
});

export const adapters = {
  claude: (dataDir: string, variant: string) =>
    createClaudeProvider({ dataDir, command: quirky("claude", variant) }),
  "codex app-server": (dataDir: string, variant: string) =>
    createCodexProvider({ dataDir, command: quirky("codex", variant) }),
  "codex exec": (dataDir: string, variant: string) =>
    createCodexProvider({
      dataDir,
      mode: "exec",
      command: quirky("codex", variant),
    }),
  antigravity: (dataDir: string, variant: string) =>
    createAntigravityProvider({
      dataDir,
      command: quirky("antigravity", variant),
    }),
};

export async function createCliHome(
  onCreated: (root: string) => void
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-tolerance-"));
  onCreated(root);
  await mkdir(path.join(root, "providers/claude"), { recursive: true });
  await writeFile(path.join(root, "providers/claude/setup-token"), "login");
  return root;
}
