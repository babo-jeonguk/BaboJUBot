// 예전 판(#148 전)이 작업 폴더에 둔 Antigravity 설정(`.agents/mcp_config.json`)의 남은 것을 지우는 별도 프로세스다.
// `antigravity-config.ts`의 `clearOwnedConfig`가 조직의 작업 폴더를 현재 폴더로 띄우고, 인수는 JSON `[우리 표시]`다.
// 작업 폴더로 `.agents`를 붙들려고 별도 프로세스로 돈다(@babojubot/files `enterFolder`). 열기와 폴더 확인은 그 패키지가 한다.
// 끝난 코드: 0 지움(또는 지울 것 없음), 3 우리 표시가 없는 설정이나 확인한 폴더가 아님(지우지 않음), 그 밖은 실패.
import { lstat, readdir, unlink } from "node:fs/promises";
import {
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
} from "@babojubot/contracts/failure";
import { enterFolder, openRegularFile } from "@babojubot/files";
import { record } from "./record.ts";

const unsafe = 3;
const file = "mcp_config.json";
const given: unknown = JSON.parse(process.argv[2] ?? "");
const ownerMark: unknown = Array.isArray(given) ? given.at(0) : undefined;
if (typeof ownerMark !== "string")
  throw new Error("the configuration script was started without our mark");

/** 이름이 우리 표시가 있는 일반 파일인가. 한 번 연 파일에서 종류를 보고 읽는다. 없으면 `"missing"`이다. */
async function owned(name: string): Promise<boolean | "missing"> {
  const opened = await openRegularFile(name);
  if (opened === "missing") return "missing";
  if (opened === "not-regular") return false;
  try {
    const text = await opened.handle.readFile("utf8");
    const parsed = orIfUnreadable((): unknown => JSON.parse(text), undefined);
    return record(parsed).babojubotOwner === ownerMark;
  } finally {
    await opened.handle.close();
  }
}
const temporary = (name: string) =>
  name.startsWith(".babojubot-") && name.endsWith(".tmp");

const agents = await orIfMissing(
  () => lstat(".agents", { bigint: true }),
  hasErrorCode("ENOENT"),
  undefined
);
if (agents === undefined) process.exit(0);
if (!agents.isDirectory() || !(await enterFolder(".agents", agents)))
  process.exit(unsafe);
for (const name of await readdir("."))
  if (temporary(name) && (await owned(name)) === true) await unlink(name);
const config = await owned(file);
if (config === false) process.exit(unsafe);
// 지우기는 이름 자체에 하는 일이라 링크를 따라가지 않는다. `.agents`는 그 조직의 에이전트가 원래 지울 수 있는 곳이다.
if (config === true)
  await orIfMissing(() => unlink(file), hasErrorCode("ENOENT"), undefined);
