import { execFile } from "node:child_process";

export const ownerMark = "babojubot-antigravity-v1";
const unsafe = 3;
const exists = 4;
const noLink = 5;

/**
 * 작업 폴더의 Antigravity 설정을 다룬다. Node에는 폴더 핸들로 다루는 기능이 없어, 확인한 뒤 경로로 다시 접근하면
 * 그 사이 .agents가 다른 조직을 가리키도록 바뀔 수 있다. 작업 폴더는 커널이 폴더 자체를 붙들므로, 별도 프로세스가
 * .agents로 들어가 확인한 폴더인지 본 뒤 그 안에서만 작업한다. 내용은 명령 인수에 남지 않게 입력으로 받는다.
 */
export const configScript = `
const fs = require("node:fs");
const { constants } = fs;
const [op] = JSON.parse(process.argv[1]);
const stat = { bigint: true };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const file = "mcp_config.json";
let expected;
try {
  expected = fs.lstatSync(".agents", stat);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  if (op === "clear") process.exit(0);
  fs.mkdirSync(".agents");
  expected = fs.lstatSync(".agents", stat);
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
if (op === "publish") {
  const temp = ".babojubot-" + require("node:crypto").randomUUID() + ".tmp";
  fs.writeFileSync(temp, fs.readFileSync(0), { flag: "wx", mode: 0o600 });
  let status = 0;
  try {
    fs.linkSync(temp, file);
  } catch (e) {
    status = e.code === "EEXIST" ? ${exists} : ${noLink};
  }
  // 게시 결과와 임시 파일 정리는 별개다. 남은 임시 파일에도 표시가 있어 정리 때 함께 지운다.
  try {
    fs.unlinkSync(temp);
  } catch {}
  process.exit(status);
}
`;

function run(cwd: string, op: "clear" | "publish", content = "") {
  return new Promise<number>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["-e", configScript, JSON.stringify([op])],
      {
        cwd,
        // 서버의 실행 옵션(NODE_OPTIONS 등)을 넘기지 않는다. Windows는 시스템 폴더 위치만 있으면 된다.
        env: process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {},
        timeout: 30_000,
        windowsHide: true,
      },
      (error) => {
        if (!error) resolve(0);
        else if (typeof error.code === "number") resolve(error.code);
        else reject(error);
      }
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(content);
  });
}

/** 우리 표시가 있는 설정과 임시 파일을 지운다. 표시 없는 파일이나 링크가 있으면 오류다. */
export async function clearOwnedConfig(cwd: string) {
  const status = await run(cwd, "clear");
  if (status) throw new Error(`configuration not cleared (${status})`);
}

/** 설정을 한 번에 나타나게 쓴다. 성공하면 0, 아니면 `configFailure`로 사유를 얻는 상태값이다. */
export const publishConfig = (cwd: string, content: string) =>
  run(cwd, "publish", content);

/** 설정을 쓰지 않았음이 확실한 거부인가. 그 밖의 실패는 게시됐을 수 있어 정리해야 한다. */
export const configRefused = (status: number) =>
  status === unsafe || status === exists || status === noLink;

export function configFailure(status: number) {
  if (status === unsafe || status === exists)
    return "작업 폴더의 MCP 설정이 제품 소유 파일이 아니거나 심볼릭 링크입니다.";
  if (status === noLink)
    return "이 파일 시스템은 하드링크를 지원하지 않아 Antigravity 설정 파일을 안전하게 쓸 수 없습니다. 제품 데이터 폴더를 하드링크를 지원하는 디스크로 옮겨 주세요.";
  return "프로바이더를 실행하지 못했습니다.";
}
