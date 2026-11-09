// 제품 로그인의 토큰 입력을 실제 PTY에서 돌리는 대역. login.test.ts의 PTY 검사가 python3 pty로 띄운다.
// 사용: node login-pty.mjs <제품 폴더> <토큰 파일>. 로그인 프로그램은 바로 끝나고, 토큰을 받은 뒤 터미널이
// 원래대로 돌아왔는지 보이려고 `after:` 뒤에 echo가 켜진 보통 줄 하나를 더 읽는다.
import { createInterface } from "node:readline";
import { runLogin } from "../src/providers/login.ts";

const [home, tokenFile] = process.argv.slice(2);
try {
  await runLogin({
    id: "pty-login",
    login: {
      command: [process.execPath, "-e", ""],
      args: [],
      env: { ...process.env, HOME: home },
      tokenFile,
    },
  });
} catch (error) {
  if (error?.name !== "AbortError") throw error;
  process.stdout.write(`cancelled:${error.name}\n`);
}
process.stdout.write(`raw:${process.stdin.isRaw === true}\n`);
process.stdout.write("after: ");
const lines = createInterface({ input: process.stdin, terminal: false });
for await (const line of lines) {
  process.stdout.write(`got:${line.trim()}\n`);
  break;
}
lines.close();
