// 예전 판(#148 전)이 작업 폴더에 둔 Antigravity 설정(`.agents/mcp_config.json`)의 남은 것을 지우는 별도 프로세스다.
// `antigravity-config.ts`의 `clearOwnedConfig`가 조직의 작업 폴더를 현재 폴더로 띄우고, 인수는 JSON `[우리 표시]`다.
// 작업 폴더로 `.agents`를 붙들려고 별도 프로세스로 돈다(@babojubot/files `enterFolder`). 열기와 폴더 확인은 그 패키지가 한다.
// 끝난 코드: 0 지움(또는 지울 것 없음), 3 우리 표시가 없는 설정이나 확인한 폴더가 아님(지우지 않음), 확인한 뒤 같은 이름에
// 저장된 파일을 되돌리지 못하고 옮긴 이름으로 남김(3), 그 밖은 실패.
import { lstat, readdir } from "node:fs/promises";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
} from "@babojubot/contracts/failure";
import {
  enterFolder,
  openRegularFile,
  removeConfirmed,
} from "@babojubot/files";
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
  if (typeof opened === "string")
    return opened === "missing" ? "missing" : false;
  try {
    const text = await opened.handle.readFile("utf8");
    const parsed = orIfUnreadable((): unknown => JSON.parse(text), undefined);
    return record(parsed).babojubotOwner === ownerMark;
  } finally {
    await continueAfterFailure(
      () => opened.handle.close(),
      (error) =>
        process.stderr.write(
          `[config] a file handle could not be closed (${failureCode(error)})\n`
        )
    );
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
if (!agents.isDirectory() || !(await enterFolder(".agents", agents))) {
  process.stderr.write(
    "[config] .agents is not a folder this script could check; nothing is removed\n"
  );
  process.exit(unsafe);
}
let kept = false;
for (const name of await readdir("."))
  if (temporary(name) && (await owned(name)) === true) {
    // 확인한 뒤 이름으로 지우면 그 사이 같은 이름에 저장된 새 파일을 지운다. 옮긴 파일을 확인해 맞을 때만 지운다(#286 항목 8).
    const removal = await removeConfirmed(
      name,
      async (moved) => (await owned(moved)) === true
    );
    if (typeof removal === "object") {
      process.stderr.write(
        `[config] a file saved under ${name} while it was cleared is kept as ${removal.keptAs}\n`
      );
      kept = true;
    }
  }
const config = await owned(file);
if (config === false) {
  process.stderr.write(
    "[config] mcp_config.json has no BaboJUBot mark; it is kept\n"
  );
  process.exit(unsafe);
}
if (config === true) {
  const removal = await removeConfirmed(
    file,
    async (moved) => (await owned(moved)) === true
  );
  if (typeof removal === "object") {
    process.stderr.write(
      `[config] a file saved under ${file} while it was cleared is kept as ${removal.keptAs}\n`
    );
    process.exit(unsafe);
  }
}
if (kept) process.exit(unsafe);
