import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ProviderConnection } from "@babojubot/contracts";
import { expect, it, vi } from "vitest";
import { createClaudeProvider as unownedClaudeProvider } from "./claude.ts";
import { runLogin } from "./login.ts";
import { testFolders } from "./test-folders.ts";
import { commandFailure, probeEnvironment } from "./test-support.ts";

const folders = testFolders();
// 이 파일이 만드는 프로바이더 연결은 모두 정리가 실행을 맡는다(시험 표에 담아 넘긴 factory도 같다).
const createClaudeProvider = folders.owning(unownedClaudeProvider);

async function tempDir() {
  const dir = await folders.make("babojubot-login-");
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
  const { output, text } = recordedOutput(false);
  const done = runLogin(provider, { input, output, stdio: "ignore" });
  // 로그인 프로그램이 끝나고 토큰을 묻는 프롬프트가 나온 뒤에 붙여 넣는다.
  await typeAfterPrompt(input, text, ["pasted-token\n"]);
  input.end();
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

function stubConnection(dir: string): Pick<ProviderConnection, "id" | "login"> {
  return {
    id: "stub-login",
    login: {
      command: [process.execPath, "-e", ""],
      args: [],
      env: { ...process.env, HOME: path.join(dir, "home") },
      tokenFile: path.join(dir, "home", "token"),
    },
  };
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

/** 출력에 쓴 글과, 프롬프트를 쓰는 순간 입력이 이미 raw였는지를 남긴다. 프롬프트가 보이면 바로 붙여 넣을 수 있다. */
function recordedOutput(isTTY: boolean, input?: { isRaw: boolean }) {
  const output = Object.assign(new PassThrough(), { isTTY, columns: 80 });
  let text = "";
  let rawAtPrompt: boolean | undefined;
  const write = output.write.bind(output) as (chunk: unknown) => boolean;
  output.write = ((chunk: unknown) => {
    const piece = String(chunk);
    if (piece.includes("empty to skip")) rawAtPrompt = input?.isRaw;
    text += piece;
    return write(chunk);
  }) as typeof output.write;
  return { output, text: () => text, rawAtPrompt: () => rawAtPrompt };
}

/** 프롬프트가 나온 뒤에 입력을 보낸다. 프롬프트 전 입력은 실제 터미널에서도 echo되므로 계약 밖이다. */
async function typeAfterPrompt(
  input: PassThrough,
  text: () => string,
  chunks: Array<string | Error>
) {
  await vi.waitUntil(() => text().includes("empty to skip"), {
    timeout: 5_000,
    interval: 10,
  });
  // 조각마다 입력을 읽는 쪽이 받은 뒤에 다음 조각을 보낸다. 읽기 전에 입력이 끊기면 받지 못한 조각이 버려진다.
  for (const chunk of chunks) {
    if (chunk instanceof Error) {
      input.destroy(chunk);
      continue;
    }
    const read = once(input, "data");
    input.write(chunk);
    await read;
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
    const { output, text, rawAtPrompt } = recordedOutput(outputIsTTY, input);
    const done = runLogin(connection, { input, output, stdio: "ignore" });
    await typeAfterPrompt(input, text, ["  synthetic-", "token-123  \r"]);
    await done;
    expect(text()).toContain("Paste the token");
    expect(rawAtPrompt()).toBe(true);
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
// CI(Linux·macOS)는 BABOJUBOT_REQUIRE_PYTHON_PTY=1로 이 검사를 필수로 정한다. 그때 python pty가 없으면 원인과 함께 실패한다.
const python = probeEnvironment({
  variable: "BABOJUBOT_REQUIRE_PYTHON_PTY",
  what: "python pty 실제 터미널",
  ...(process.platform === "win32" && {
    unsupported: "Windows에는 POSIX pty가 없다(ConPTY는 범위 밖)",
  }),
  probe: () => {
    const failures: string[] = [];
    for (const name of ["python3", "python"]) {
      const missing = commandFailure(name, ["-c", "import pty"]);
      if (missing === undefined) return { value: name };
      failures.push(missing);
    }
    return { missing: failures.join(" / ") };
  },
});

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
# 프롬프트를 본 즉시 보낸다. 사람·자동화가 프롬프트를 보자마자 붙여 넣는 경우다.
for marker, text in sends:
    read_until(marker)
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

// 프롬프트와 echo 끄기 사이에 틈이 있으면 바로 붙여 넣은 토큰이 대부분 보인다(리뷰 재현 27/30). 여러 번 돌려 틈이 없음을 본다.
it.skipIf(!python)(
  "does not echo a token pasted the moment the prompt appears on a real terminal",
  async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const dir = await tempDir();
      const { transcript, code } = runInPty(dir, [
        ["empty to skip", "synthetic-race-token-9c1e\r"],
        ["after: ", "visible-after\r"],
      ]);
      expect(code, transcript).toBe(0);
      expect(transcript, `attempt ${attempt}`).not.toContain(
        "synthetic-race-token-9c1e"
      );
    }
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
