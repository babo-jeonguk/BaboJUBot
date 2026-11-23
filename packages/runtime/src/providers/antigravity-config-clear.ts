// 예전 판(#148 전)이 작업 폴더에 둔 Antigravity 설정(`.agents/mcp_config.json`)의 남은 것을 지우는 별도 프로세스다.
// `antigravity-config.ts`의 `clearOwnedConfig`가 조직의 작업 폴더를 현재 폴더로 띄우고, 인수는 JSON `[우리 표시]`다.
// 작업 폴더로 `.agents`를 붙들려고 별도 프로세스로 돈다(@babojubot/files `enterFolder`). 열기와 폴더 확인은 그 패키지가 한다.
// 끝난 코드: 0 지움(또는 지울 것 없음), 3 지우지 못한 까닭이 있음. 까닭은 표준 오류에 한 줄에 JSON 하나로 남긴다:
// `{"reason": …, "name": …}`(되돌리지 못해 옮긴 이름으로 남겼으면 `keptAs`, handle을 닫지 못했으면 `code`). 그 밖은 실패.
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
  type Removal,
} from "@babojubot/files";
import { record } from "./record.ts";

const unsafe = 3;
const file = "mcp_config.json";
const given: unknown = JSON.parse(process.argv[2] ?? "");
const ownerMark: unknown = Array.isArray(given) ? given.at(0) : undefined;
if (typeof ownerMark !== "string")
  throw new Error("the configuration script was started without our mark");

/** 지우지 못한 까닭. 서버가 정해진 값만 기록한다. */
type Reason =
  | "not_checkable"
  | "unmarked"
  | "not_regular"
  | "changed"
  | "restored"
  | "kept_aside"
  | "handle_not_closed";
/** 지우지 못한 까닭이 있었는가. 하나라도 남기면 끝남 코드 3이다. */
let unsafeReason = false;
/** 까닭 하나를 표준 오류에 JSON 한 줄로 남긴다. 사람이 읽을 글은 쓰지 않는다(서버가 정해진 값만 기록한다). */
function report(
  reason: Reason,
  name: string,
  extra?: { keptAs?: string; code?: string }
) {
  unsafeReason = true;
  process.stderr.write(`${JSON.stringify({ reason, name, ...extra })}\n`);
}

/** 이름이 우리 표시가 있는 일반 파일인가, 아니면 확인하지 못한 까닭인가. */
async function owned(
  name: string
): Promise<"missing" | "owned" | "unmarked" | "not_regular" | "changed"> {
  const opened = await openRegularFile(name);
  if (opened === "missing") return "missing";
  if (opened === "not-regular") return "not_regular";
  if (opened === "changed") return "changed";
  try {
    const text = await opened.handle.readFile("utf8");
    const parsed = orIfUnreadable((): unknown => JSON.parse(text), undefined);
    return record(parsed).babojubotOwner === ownerMark ? "owned" : "unmarked";
  } finally {
    await continueAfterFailure(
      () => opened.handle.close(),
      (error) => report("handle_not_closed", name, { code: failureCode(error) })
    );
  }
}

/** `removeConfirmed`의 결과를 빠짐없이 처리한다. 되돌렸으면 정리하지 못한 까닭이다. */
function handled(name: string, removal: Removal) {
  if (typeof removal === "object") {
    report("kept_aside", name, { keptAs: removal.keptAs });
    return;
  }
  switch (removal) {
    case "removed":
    case "missing":
      return;
    case "restored":
      report("restored", name);
      return;
    default: {
      const unhandled: never = removal;
      throw new Error(`unhandled removal ${String(unhandled)}`);
    }
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
  report("not_checkable", ".agents");
  process.exit(unsafe);
}
for (const name of await readdir(".")) {
  if (!temporary(name)) continue;
  // 임시 파일은 우리 것일 때만 지운다. 그 밖은 건드리지 않고 까닭도 남기지 않는다.
  if ((await owned(name)) !== "owned") continue;
  handled(
    name,
    await removeConfirmed(
      name,
      async (moved) => (await owned(moved)) === "owned"
    )
  );
}
const config = await owned(file);
switch (config) {
  case "owned":
    handled(
      file,
      await removeConfirmed(
        file,
        async (moved) => (await owned(moved)) === "owned"
      )
    );
    break;
  case "unmarked":
  case "not_regular":
  case "changed":
    report(config, file);
    break;
  case "missing":
    break;
  default: {
    const unhandled: never = config;
    throw new Error(`unhandled owned result ${String(unhandled)}`);
  }
}
if (unsafeReason) process.exit(unsafe);
