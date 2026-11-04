import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { createClaudeProvider } from "./claude.ts";
import { runLogin } from "./login.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("runs the login with the connection's environment and saves a pasted token privately", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "babojubot-login-"));
  roots.push(dataDir);
  const seen = path.join(dataDir, "seen-home");
  const provider = createClaudeProvider({
    dataDir,
    command: [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(seen)}, process.env.HOME)`,
    ],
  });
  const input = new PassThrough();
  const done = runLogin(provider, {
    input,
    output: new PassThrough(),
    stdio: "ignore",
  });
  setTimeout(() => input.end("pasted-token\n"), 300);
  await done;
  const home = path.join(dataDir, "providers/claude");
  expect(await readFile(seen, "utf8")).toBe(home);
  const token = path.join(home, "setup-token");
  expect((await readFile(token, "utf8")).trim()).toBe("pasted-token");
  if (process.platform !== "win32")
    expect((await stat(token)).mode & 0o777).toBe(0o600);
});
