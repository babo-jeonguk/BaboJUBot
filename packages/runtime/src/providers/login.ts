import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import spawn from "cross-spawn";
import type { ProviderConnection } from "@babojubot/contracts";

/**
 * 연결의 제품 로그인. 실행 시도와 같은 환경으로 프로그램의 로그인을 띄우고, 토큰을 보여 주는 프로그램이면
 * 붙여 넣은 값을 제품 폴더에 저장한다. 토큰은 명령 인수와 화면에 남지 않는다. 모든 OS에서 같은 명령이다.
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
  output.write("Paste the token shown above (hidden, empty to skip): ");
  const lines = createInterface({ input, terminal: false });
  let token = "";
  for await (const line of lines) {
    token = line.trim();
    break;
  }
  lines.close();
  output.write("\n");
  if (!token) return;
  await mkdir(path.dirname(login.tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(login.tokenFile, token + "\n", { mode: 0o600 });
  await chmod(login.tokenFile, 0o600);
}
