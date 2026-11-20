import { runTree } from "@babojubot/process";

export const ownerMark = "babojubot-antigravity-v1";
const unsafe = 3;

/**
 * 예전 판(#148 전)이 실행마다 작업 폴더에 둔 Antigravity 설정(`.agents/mcp_config.json`)의 남은 것을 서버 시작 때 지운다.
 * 지금은 조직 도구를 ACP 세션을 열 때 실행 시도에만 주므로 작업 폴더에 설정을 쓰지 않는다.
 * 작업 폴더의 Antigravity 설정을 다룬다. Node에는 폴더 핸들로 다루는 기능이 없어, 확인한 뒤 경로로 다시 접근하면
 * 그 사이 .agents가 다른 조직을 가리키도록 바뀔 수 있다. 작업 폴더는 커널이 폴더 자체를 붙들므로, 별도 프로세스가
 * .agents로 들어가 확인한 폴더인지 본 뒤 그 안에서만 작업한다.
 */
export const configScript = `
const fs = require("node:fs");
const { constants } = fs;
const stat = { bigint: true };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const file = "mcp_config.json";
let expected;
try {
  expected = fs.lstatSync(".agents", stat);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  process.exit(0);
}
if (!expected.isDirectory()) process.exit(${unsafe});
process.chdir(".agents");
if (!same(expected, fs.statSync(".", stat))) process.exit(${unsafe});
const owned = (name) => {
  const before = fs.lstatSync(name, stat);
  if (!before.isFile()) return false;
  const fd = fs.openSync(
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!same(before, fs.fstatSync(fd, stat))) return false;
    return JSON.parse(fs.readFileSync(fd, "utf8"))?.babojubotOwner === ${JSON.stringify(ownerMark)};
  } catch (e) {
    if (e instanceof SyntaxError) return false;
    throw e;
  } finally {
    fs.closeSync(fd);
  }
};
const temporary = (name) => name.startsWith(".babojubot-") && name.endsWith(".tmp");
for (const name of fs.readdirSync("."))
  if (temporary(name) && owned(name)) fs.unlinkSync(name);
try {
  if (!owned(file)) process.exit(${unsafe});
  fs.unlinkSync(file);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
`;

/** 설정을 다루는 Node.js 프로세스를 공용 실행으로 끝까지 돌린다. 상한(30초)에 닿으면 그 트리를 끄고 확인한 뒤 실패로 던진다. */
async function run(cwd: string) {
  const result = await runTree({
    command: [process.execPath],
    args: ["-e", configScript],
    cwd,
    // 서버의 실행 옵션(NODE_OPTIONS 등)을 넘기지 않는다. Windows는 시스템 폴더 위치만 있으면 된다.
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    limitMs: 30_000,
    maxOutputBytes: 64 * 1024,
    overflow: "truncate",
  });
  if (!result.started)
    throw new Error(
      `the configuration script could not start: ${result.reason}`,
      {
        cause: result.error,
      }
    );
  if (result.stopped)
    throw new Error(
      `the configuration script was stopped at its ${result.stopped} limit`
    );
  if (result.code === null)
    throw new Error(
      `the configuration script ended by ${result.signal ?? "an unknown cause"}`
    );
  return result.code;
}

/** 우리 표시가 있는 설정과 임시 파일을 지운다. 표시 없는 파일이나 링크가 있으면 오류다. */
export async function clearOwnedConfig(cwd: string) {
  const status = await run(cwd);
  if (status) throw new Error(`configuration not cleared (${status})`);
}
