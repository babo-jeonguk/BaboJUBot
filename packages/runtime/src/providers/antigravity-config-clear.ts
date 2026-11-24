// 예전 판(#148 전)이 작업 폴더에 둔 Antigravity 설정(`.agents/mcp_config.json`)의 남은 것을 지우는 별도 프로세스다.
// `antigravity-config.ts`의 `clearOwnedConfig`가 조직의 작업 폴더를 현재 폴더로 띄우고, 인수는 JSON `[우리 표시]`다.
// 작업 폴더로 `.agents`를 붙들려고 별도 프로세스로 돈다(@babojubot/files `enterFolder`). 열기와 폴더 확인은 그 패키지가 한다.
// 끝난 코드: 0 지움(또는 지울 것 없음), 3 지우지 못한 까닭이 있음. 까닭은 표준 오류에 한 줄에 JSON 하나로 남긴다:
// `{"reason": …, "name": …}`(되돌리지 못해 옮긴 이름으로 남겼으면 `.agents` 안의 그 이름 `keptAs`와 예상 밖의 실패로 남겼으면 그 코드
// `keptCode`, 확인하지 못한 원인이나 handle을 닫지 못한 원인은 `code`). 그 밖은 실패.
import { lstat, readdir } from "node:fs/promises";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
} from "@babojubot/contracts/failure";
import {
  ConfirmFailed,
  enterFolder,
  openRegularFile,
  removeConfirmed,
  type Kept,
  type Removal,
} from "@babojubot/files";
import type { ScriptCleanupReason } from "./antigravity-config-reasons.ts";
import { record } from "./record.ts";

const unsafe = 3;
const file = "mcp_config.json";
const given: unknown = JSON.parse(process.argv[2] ?? "");
const ownerMark: unknown = Array.isArray(given) ? given.at(0) : undefined;
if (typeof ownerMark !== "string")
  throw new Error("the configuration script was started without our mark");

/** 지우지 못한 까닭이 있었는가. 하나라도 남기면 끝남 코드 3이다. */
let unsafeReason = false;
/** 까닭 하나를 표준 오류에 JSON 한 줄로 남긴다. 사람이 읽을 글은 쓰지 않는다(서버가 정해진 값만 기록한다). */
function report(
  reason: ScriptCleanupReason,
  name: string,
  extra?: { keptAs?: string; keptCode?: string; code?: string }
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

/** 옮긴 파일을 다시 확인하지 못한 까닭. `removeConfirmed`는 되돌린 뒤 이 오류를 `ConfirmFailed`의 `cause`로 던진다. */
class Unconfirmed extends Error {
  readonly reason: "changed" | "not_regular";
  constructor(reason: "changed" | "not_regular") {
    super(`the moved file could not be confirmed (${reason})`);
    this.reason = reason;
  }
}

/** `removeConfirmed`에 넘기는 확인. 우리 것 아님은 `false`, 확인하지 못한 것은 `Unconfirmed`다. */
async function confirmOwned(moved: string): Promise<boolean> {
  const state = await owned(moved);
  switch (state) {
    case "owned":
      return true;
    case "unmarked":
      return false;
    case "not_regular":
      throw new Unconfirmed("not_regular");
    case "changed":
    case "missing":
      throw new Unconfirmed("changed");
    default: {
      const unhandled: never = state;
      throw new Error(`unhandled owned result ${String(unhandled)}`);
    }
  }
}

/**
 * 옮긴 이름에 남긴 파일의 위치(`.agents` 안의 이름)와, 예상 밖의 실패로 남겼으면 그 코드(`keptCode`). 까닭 줄에 함께 담는다. 남긴
 * 원인은 까닭 자신의 원인(`code`)과 다른 칸이라 둘이 함께 있어도 하나가 덮이지 않는다.
 */
const keptFields = (kept: Kept) => ({
  keptAs: kept.keptAs,
  ...(kept.because === undefined
    ? {}
    : { keptCode: failureCode(kept.because) }),
});

/** `removeConfirmed`의 결과를 빠짐없이 처리한다. 되돌렸으면 정리하지 못한 까닭이다. */
function handled(name: string, removal: Removal) {
  if (typeof removal === "object") {
    report("kept_aside", name, keptFields(removal));
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

/**
 * 우리 파일 하나를 확인해 지운다. 확인하지 못한 것은 되돌린 뒤(되돌리지 못했으면 남긴 위치와 함께) 그 까닭을 남긴다. 확인이 바뀐
 * 자리·일반 파일 아님이 아닌 이유(읽기 실패 등)로 던졌으면 확인할 수 없었던 것(`not_checkable`)으로 그 원인 코드와 함께 남긴다.
 * 어느 쪽이든 정해진 까닭 줄로 남겨, 스크립트가 죽어 남긴 위치를 잃지 않게 한다.
 */
async function removeOwned(name: string) {
  try {
    handled(name, await removeConfirmed(name, confirmOwned));
  } catch (error) {
    if (!(error instanceof ConfirmFailed)) throw error;
    const kept = error.kept === "restored" ? {} : keptFields(error.kept);
    if (error.cause instanceof Unconfirmed)
      report(error.cause.reason, name, kept);
    else
      report("not_checkable", name, {
        ...kept,
        code: failureCode(error.cause),
      });
  }
}
const temporary = (name: string) =>
  name.startsWith(".babojubot-") && name.endsWith(".tmp");

/** `.agents`로 들어가 우리 임시 파일과 설정을 확인해 지운다. 지우지 못한 까닭은 `report`로 남긴다. */
async function clear() {
  const agents = await orIfMissing(
    () => lstat(".agents", { bigint: true }),
    hasErrorCode("ENOENT"),
    undefined
  );
  if (agents === undefined) return;
  if (!agents.isDirectory() || !(await enterFolder(".agents", agents))) {
    report("not_checkable", ".agents");
    return;
  }
  for (const name of await readdir(".")) {
    if (!temporary(name)) continue;
    const state = await owned(name);
    switch (state) {
      case "owned":
        await removeOwned(name);
        break;
      case "missing":
      case "unmarked":
        // 우리 것 아님(이미 없거나 표시가 없다). 건드리지 않는다.
        break;
      case "not_regular":
      case "changed":
        // 우리 임시 파일 이름인데 확인하지 못했다. 설정 파일 쪽과 같은 기준으로 지우지 않고 그 까닭을 남긴다.
        report(state, name);
        break;
      default: {
        const unhandled: never = state;
        throw new Error(`unhandled owned result ${String(unhandled)}`);
      }
    }
  }
  const config = await owned(file);
  switch (config) {
    case "owned":
      await removeOwned(file);
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
}

await clear();
// `process.exit()`는 아직 다 쓰지 못한 표준 오류(파이프)를 버린다. 끝남 코드만 정하고, 쓰기가 끝나면 스스로 끝난다.
if (unsafeReason) process.exitCode = unsafe;
