import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import spawn from "cross-spawn";
import type { ProviderConnection } from "@babojubot/contracts";

/**
 * 토큰 한 줄을 숨겨서 읽는다. 입력이 터미널이면 프롬프트를 쓰기 전에 커널 echo를 끄는 raw mode로 바꾸므로,
 * 프롬프트가 보이는 순간 붙여 넣은 토큰도 화면에 나타나지 않는다. readline에도 출력 스트림을 주지 않아
 * readline이 echo할 곳을 없앤다. 끝나면 입력의 raw 상태를 원래대로 되돌린다.
 */
async function readHiddenLine(
  input: Readable,
  output: Writable,
  prompt: string
): Promise<string> {
  const tty =
    (input as { isTTY?: boolean }).isTTY === true &&
    typeof (input as { setRawMode?: unknown }).setRawMode === "function";
  const wasRaw = (input as { isRaw?: boolean }).isRaw === true;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let rl: Interface | undefined;

    const cleanup = () => {
      rl?.off("line", onLine);
      rl?.off("close", onClose);
      rl?.off("SIGINT", onSigint);
      rl?.off("error", onError);
      input.off("error", onError);
      rl?.close();
      if (tty) {
        (input as unknown as { setRawMode(mode: boolean): unknown }).setRawMode(
          wasRaw
        );
      }
      output.write("\n");
    };

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const onLine = (line: string) => finish(() => resolve(line.trim()));
    const onClose = () => finish(() => resolve(""));
    const onSigint = () =>
      finish(() =>
        reject(new DOMException("Token input was cancelled", "AbortError"))
      );
    const onError = (error: Error) => finish(() => reject(error));

    try {
      if (tty) {
        (input as unknown as { setRawMode(mode: boolean): unknown }).setRawMode(
          true
        );
      }
      rl = tty
        ? createInterface({ input, terminal: true, historySize: 0 })
        : createInterface({ input, terminal: false });
      rl.on("line", onLine);
      rl.on("close", onClose);
      rl.on("SIGINT", onSigint);
      rl.on("error", onError);
      input.once("error", onError);
      output.write(prompt);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/**
 * 연결의 제품 로그인. 실행 시도와 같은 환경으로 프로그램의 로그인을 띄우고, 토큰을 보여 주는 프로그램이면
 * 붙여 넣은 값을 제품 폴더에 저장한다. 토큰은 명령 인수와 화면에 남지 않는다. 모든 OS에서 같은 명령이다.
 * 입력이 터미널이면 붙여 넣은 토큰을 echo 없이 읽고, 모든 경로에서 끝나면 터미널을 원래 상태로 되돌린다.
 * Ctrl-C는 토큰을 저장하지 않고 AbortError로 끝난다.
 */
export async function runLogin(
  connection: ProviderConnection,
  {
    input = process.stdin,
    output = process.stdout,
    stdio = "inherit",
  }: {
    input?: Readable;
    output?: Writable;
    stdio?: "inherit" | "ignore";
  } = {}
) {
  const { login } = connection;
  if (!login) throw new Error(`${connection.id} has no login`);
  const home = String(login.env.HOME);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      login.command[0],
      [...login.command.slice(1), ...login.args],
      { env: login.env, cwd: home, stdio }
    );
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) console.warn(`[login] the program exited with code ${code}`);
  if (!login.tokenFile) return;
  const token = await readHiddenLine(
    input,
    output,
    "Paste the token shown above (hidden, empty to skip): "
  );
  if (!token) return;
  await mkdir(path.dirname(login.tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(login.tokenFile, token + "\n", { mode: 0o600 });
  await chmod(login.tokenFile, 0o600);
}
