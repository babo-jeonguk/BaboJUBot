// 제품 로그인. 사용: pnpm provider:login <연결> [--home <제품 폴더>]. 연결 이름은 claude, claude:work 처럼 쓴다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, runLogin } from "../packages/runtime/src/index.ts";

const [name, flag, value] = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(
  flag === "--home" && value
    ? value
    : (process.env.BABOJUBOT_HOME ?? path.join(root, ".babojubot"))
);
if (!name) {
  console.error("Usage: pnpm provider:login <connection> [--home <folder>]");
  process.exit(2);
}
try {
  await runLogin(createConnection(name, { dataDir }));
} catch (error) {
  if (error?.name === "AbortError") {
    console.error("Login cancelled.");
    process.exitCode = 130;
  } else {
    throw error;
  }
}
