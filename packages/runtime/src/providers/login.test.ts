import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ProviderConnection } from "@babojubot/contracts";
import { afterEach, expect, it } from "vitest";
import { createClaudeProvider } from "./claude.ts";
import { runLogin } from "./login.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "babojubot-login-"));
  roots.push(dir);
  return dir;
}

it("runs the login with the connection's environment and saves a pasted token privately", async () => {
  const dataDir = await tempDir();
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

// ---------- 터미널 입력 (#123) ----------
// 터미널의 echo는 입력 터미널 드라이버가 한다. 출력 스트림만 봐서는 보이지 않으므로, 입력이 raw mode로
// 바뀌었다가 원래대로 돌아오는지와 출력에 토큰이 없는지를 함께 본다. 모든 OS에서 돈다.

function stubConnection(dir: string): ProviderConnection {
  return {
    id: "stub-login",
    login: {
      command: [process.execPath, "-e", ""],
      args: [],
      env: { ...process.env, HOME: path.join(dir, "home") },
      tokenFile: path.join(dir, "home", "token"),
    },
  } as ProviderConnection;
}

function fakeTerminalInput() {
  const modes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      modes.push(mode);
      input.isRaw = mode;
      return input;
    },
  });
  return { input, modes };
}

function recordedOutput(isTTY: boolean) {
  const output = Object.assign(new PassThrough(), { isTTY, columns: 80 });
  let text = "";
  output.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  return { output, text: () => text };
}

/** 프롬프트가 나온 뒤에 입력을 보낸다. 프롬프트 전 입력은 실제 터미널에서도 echo되므로 계약 밖이다. */
async function typeAfterPrompt(
  input: PassThrough,
  text: () => string,
  chunks: Array<string | Error>
) {
  while (!text().includes("empty to skip"))
    await new Promise((r) => setTimeout(r, 10));
  for (const chunk of chunks) {
    if (chunk instanceof Error) input.destroy(chunk);
    else input.write(chunk);
    await new Promise((r) => setTimeout(r, 10));
  }
}

it.each([
  ["terminal output", true],
  ["redirected output", false],
])(
  "hides a pasted token on a terminal input with %s and restores the terminal",
  async (_name, outputIsTTY) => {
    const dir = await tempDir();
    const connection = stubConnection(dir);
    const { input, modes } = fakeTerminalInput();
    const { output, text } = recordedOutput(outputIsTTY);
    const done = runLogin(connection, { input, output, stdio: "ignore" });
    await typeAfterPrompt(input, text, ["  synthetic-", "token-123  \r"]);
    await done;
    expect(text()).toContain("Paste the token");
    expect(text()).not.toContain("synthetic");
    expect(modes[0]).toBe(true);
    expect(modes.at(-1)).toBe(false);
    expect(input.isRaw).toBe(false);
    const tokenFile = connection.login!.tokenFile!;
    expect(await readFile(tokenFile, "utf8")).toBe("synthetic-token-123\n");
    if (process.platform !== "win32")
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  }
);

it("skips on an empty terminal line and restores the terminal", async () => {
  const dir = await tempDir();
  const connection = stubConnection(dir);
  const { input, modes } = fakeTerminalInput();
  const { output, text } = recordedOutput(true);
  const done = runLogin(connection, { input, output, stdio: "ignore" });
  await typeAfterPrompt(input, text, ["\r"]);
  await done;
  expect(modes).toContain(true);
  expect(input.isRaw).toBe(false);
  await expect(stat(connection.login!.tokenFile!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("cancels on Ctrl-C without saving and restores the terminal", async () => {
  const dir = await tempDir();
  const connection = stubConnection(dir);
  const { input, modes } = fakeTerminalInput();
  const { output, text } = recordedOutput(true);
  const done = runLogin(connection, { input, output, stdio: "ignore" });
  const settled = done.then(
    () => undefined,
    (error: unknown) => error
  );
  await typeAfterPrompt(input, text, ["partial-secret", "\x03"]);
  expect(await settled).toMatchObject({ name: "AbortError" });
  expect(text()).not.toContain("partial-secret");
  expect(modes).toContain(true);
  expect(input.isRaw).toBe(false);
  await expect(stat(connection.login!.tokenFile!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("restores the terminal when the input fails", async () => {
  const dir = await tempDir();
  const connection = stubConnection(dir);
  const { input, modes } = fakeTerminalInput();
  const { output, text } = recordedOutput(true);
  const done = runLogin(connection, { input, output, stdio: "ignore" });
  const settled = done.then(
    () => undefined,
    (error: unknown) => error
  );
  await typeAfterPrompt(input, text, [
    "partial-secret",
    new Error("input broke"),
  ]);
  expect(await settled).toMatchObject({ message: "input broke" });
  expect(modes).toContain(true);
  expect(input.isRaw).toBe(false);
  await expect(stat(connection.login!.tokenFile!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("leaves a terminal that was already in raw mode in raw mode", async () => {
  const dir = await tempDir();
  const connection = stubConnection(dir);
  const { input, modes } = fakeTerminalInput();
  input.isRaw = true;
  const { output, text } = recordedOutput(true);
  const done = runLogin(connection, { input, output, stdio: "ignore" });
  await typeAfterPrompt(input, text, ["synthetic-token\r"]);
  await done;
  expect(modes.at(-1)).toBe(true);
  expect(input.isRaw).toBe(true);
});

// ---------- 실제 PTY (#123) ----------
// POSIX에서 python3 pty로 실제 터미널을 만들어 커널 line discipline의 echo까지 본다. Windows ConPTY는 범위 밖이며
// 위의 크로스플랫폼 검사가 같은 계약을 본다.

const fixture = fileURLToPath(
  new URL("../../test-fixtures/login-pty.mjs", import.meta.url)
);
const python =
  process.platform === "win32"
    ? undefined
    : ["python3", "python"].find(
        (name) =>
          spawnSync(name, ["-c", "import pty"], { stdio: "ignore" }).status ===
          0
      );

// 프롬프트를 기다렸다가 입력을 보내고, 끝까지 읽은 transcript와 종료 코드를 JSON으로 낸다.
const driver = String.raw`
import json, os, pty, sys, time
argv, sends = json.loads(sys.argv[1]), json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
out = b""
def read_until(marker, timeout=20):
    global out
    end = time.time() + timeout
    while marker.encode() not in out and time.time() < end:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return
        if not chunk:
            return
        out += chunk
for marker, text in sends:
    read_until(marker)
    time.sleep(0.2)
    os.write(fd, text.encode())
read_until("\0never\0")
_, status = os.waitpid(pid, 0)
print(json.dumps({"transcript": out.decode("utf8", "replace"), "code": os.waitstatus_to_exitcode(status)}))
`;

function runInPty(dir: string, sends: Array<[string, string]>) {
  const result = spawnSync(
    python!,
    [
      "-c",
      driver,
      JSON.stringify([
        process.execPath,
        fixture,
        path.join(dir, "home"),
        path.join(dir, "home", "token"),
      ]),
      JSON.stringify(sends),
    ],
    { encoding: "utf8", timeout: 50_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { transcript: string; code: number };
}

it.skipIf(!python)(
  "does not echo a pasted token on a real terminal and echoes again afterwards",
  async () => {
    const dir = await tempDir();
    const { transcript, code } = runInPty(dir, [
      ["empty to skip", "synthetic-pty-token-7f3a\r"],
      ["after: ", "visible-after\r"],
    ]);
    expect(code, transcript).toBe(0);
    expect(transcript).not.toContain("synthetic-pty-token-7f3a");
    expect(transcript).toContain("raw:false");
    expect(transcript.match(/visible-after/g)?.length, transcript).toBe(2);
    expect(await readFile(path.join(dir, "home", "token"), "utf8")).toBe(
      "synthetic-pty-token-7f3a\n"
    );
  }
);

it.skipIf(!python)(
  "restores echo on a real terminal after Ctrl-C",
  async () => {
    const dir = await tempDir();
    const { transcript, code } = runInPty(dir, [
      ["empty to skip", "partial-pty-secret"],
      ["empty to skip", "\x03"],
      ["after: ", "visible-after\r"],
    ]);
    expect(code, transcript).toBe(0);
    expect(transcript).not.toContain("partial-pty-secret");
    expect(transcript).toContain("cancelled:AbortError");
    expect(transcript.match(/visible-after/g)?.length, transcript).toBe(2);
    await expect(stat(path.join(dir, "home", "token"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
);
