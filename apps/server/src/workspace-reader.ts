// 조직 폴더 안의 파일 하나를 고정한 폴더에서 읽는 별도 프로세스다. 서버(workspace.ts의 `readPinned`)가 `organizations` 폴더를
// 현재 폴더로 띄우고, 인수는 JSON `[최대 바이트, 조직 ID, 요청 경로, 작업 폴더, 작업 폴더의 실제 경로]`다. 성공하면 표준 출력에
// 고른 위치(JSON 한 줄)와 파일 내용을 쓰고, 거부하면 `readerExit`의 코드로 끝난다.
//
// Node에는 폴더 핸들로 여는 기능이 없어 경로를 여러 번 확인해도 그 사이의 바꿔치기를 막지 못한다. 작업 폴더는 커널이 폴더
// 자체를 붙들므로 한 칸씩 들어가며 확인한 폴더인지 보고(@babojubot/files `enterFolder`), 고정된 폴더 안에서 연다(`openRegularFile`).
// 들어간 뒤에 바깥 경로가 바뀌어도 영향이 없다. 작업 폴더는 프로세스에 하나라 서버 안이 아니라 이 프로세스에서 한다.
// 요청 경로도 이 프로세스가 고정한 폴더 안에서 한 칸씩 직접 풀고, 링크는 안에 머무는 동안에만 따라간다. 바깥으로 나가는 `..`나
// 링크는 그 너머를 보지 않고 거부한다. 본 바로 뒤에 바뀐 칸은 `changed`다. 절대 경로의 작업 폴더 부분은 이름 하나씩 대조하고,
// 나머지는 글자로 먼저 줄이지 않고 상대 경로처럼 걸어가므로 링크 뒤의 `..`는 링크가 가리키는 자리에서 올라간다.
// 경로를 고정해도 처음 고른 폴더가 다른 조직이면 소용없으므로, 고정한 폴더가 자기 ID를 말하게 해 대조한다.
// Windows에서는 Win32가 다른 드라이브·장치·스트림으로 읽거나 끝의 점이나 공백을 떼는 이름을 파일 시스템에 닿기 전에 거부한다.
// 파일 작업은 차례로 하나씩 기다린다. 동시에 도는 작업이 없어 상대 경로는 늘 그때의 작업 폴더를 기준으로 풀린다.
import type { BigIntStats } from "node:fs";
import { lstat, readlink, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  failureCode,
  hasErrorCode,
  orIfProbeFailed,
  orIfUnreadable,
} from "@babojubot/contracts/failure";
import { enterFolder, openRegularFile, sameEntry } from "@babojubot/files";
import {
  identityFile,
  identityMaxBytes,
  readerExit,
} from "./workspace-reader-contract.ts";

const bigint = { bigint: true } as const;
const given: unknown = JSON.parse(process.argv[2] ?? "");
const values: readonly unknown[] = Array.isArray(given) ? given : [];
const [maxBytes, organizationId, requested, working, real] = values;
if (
  typeof maxBytes !== "number" ||
  typeof organizationId !== "string" ||
  typeof requested !== "string" ||
  typeof working !== "string" ||
  typeof real !== "string"
)
  throw new Error("the file reader was started with invalid arguments");

const windows = path.sep === "\\";
/** Windows는 경로의 ".."를 글자로 줄여 연다(Win32). 링크 대상은 이것만 따른다. */
const lexical = (value: string) => (windows ? path.normalize(value) : value);
/** 에이전트가 입력한 경로. Windows는 글자로 줄인 뒤 끝의 구분자도 떼고 연다(Win32). */
const typed = (value: string) => {
  if (!windows) return value;
  const cleaned = path.normalize(value);
  return cleaned.length > path.parse(cleaned).root.length
    ? cleaned.replace(/[\\/]+$/, "")
    : cleaned;
};
const separator = windows ? /[\\/]+/ : /\/+/;
/** Names of a path, without empty names or ".". ".." stays where it is. */
const names = (value: string) =>
  value.split(separator).filter((name) => name !== "" && name !== ".");
/**
 * 작업 폴더 부분의 이름 대조. 대소문자까지 같아야 한다. Windows도 폴더마다 대소문자를 가리게 할 수 있어 대소문자만 다른 이름은
 * 다른 폴더일 수 있다. 같은 폴더를 대소문자만 다르게 적은 경로는 밖으로 보는 안전한 오거부다. 드라이브 문자는 늘 같은 드라이브다.
 */
const sameName = (a: string, b: string) =>
  a === b ||
  (windows && /^[A-Za-z]:$/.test(a) && a.toLowerCase() === b.toLowerCase());
/** Windows가 이름 하나를 다른 것으로 읽는 경우의 거부 종료 코드. 없으면 undefined다(Go filepath.IsLocal·os.Root, cap-std, node-tar). */
const windowsName = (name: string) => {
  if (!windows) return undefined;
  // 드라이브 문자로 시작하면 그 드라이브의 현재 폴더 기준이다.
  if (/^[A-Za-z]:/.test(name)) return readerExit.outside;
  // 이름 중간의 ":"는 NTFS 스트림이다.
  if (name.includes(":")) return readerExit.notFile;
  // Win32는 끝의 점·공백을 떼고 연다. ".. "는 위 폴더가 된다.
  if (/[. ]$/.test(name)) return readerExit.notFile;
  // 예약된 장치 이름은 확장자가 붙어도 장치다.
  const base = (name.split(".")[0] ?? "").replace(/ +$/, "").toUpperCase();
  if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/.test(base))
    return readerExit.notFile;
  return undefined;
};
/** 절대 경로가 작업 폴더(그 실제 경로 포함) 안이면 작업 폴더 뒤의 이름들, 아니면 undefined. */
const inside = (absolute: string, clean: (value: string) => string) => {
  // 확장 표기는 같은 곳이다. "\\?\C:\…"는 "C:\…", "\\?\UNC\server\share\…"는 "\\server\share\…"다.
  const target = !windows
    ? absolute
    : absolute.startsWith("\\\\?\\UNC\\")
      ? "\\\\" + absolute.slice(8)
      : absolute.startsWith("\\\\?\\")
        ? absolute.slice(4)
        : absolute;
  const given = clean(target).split(separator);
  for (const base of [working, real]) {
    const prefix = names(base);
    let at = 0;
    let matched = 0;
    while (matched < prefix.length && at < given.length) {
      const name = given[at] ?? "";
      at += 1;
      if (name === "" || name === ".") continue;
      if (!sameName(name, prefix[matched] ?? "")) break;
      matched += 1;
    }
    if (matched === prefix.length) return given.slice(at);
  }
  return undefined;
};
/** 읽기를 막은 파일 시스템 오류를 거부 이유로 끝낸다. */
function fail(error: unknown): never {
  process.exit(
    hasErrorCode("ENOENT", "ENOTDIR", "ENAMETOOLONG")(error)
      ? readerExit.notFound
      : hasErrorCode("EACCES", "EPERM")(error)
        ? readerExit.unreadable
        : hasErrorCode("ELOOP")(error)
          ? readerExit.changed
          : readerExit.failed
  );
}
/** 서버가 넘긴 폴더(조직 폴더·shared)로 들어간다. 확인하지 못하면 표식 불일치처럼 서버 쪽 문제로 끝낸다. */
async function server(name: string) {
  const entered = await orIfProbeFailed(
    async () => {
      const expected = await lstat(name, bigint);
      return expected.isDirectory() && (await enterFolder(name, expected));
    },
    false,
    (error) =>
      process.stderr.write(
        `[reader] the server folder could not be entered (${failureCode(error)})\n`
      )
  );
  if (!entered) process.exit(readerExit.identity);
}
/** 걸으며 확인한 폴더로 들어간다. 그 사이 사라지거나 바뀌었으면 `changed`, 확인한 그 폴더에 권한이 없으면 `unreadable`이다. */
async function into(name: string, expected: BigIntStats) {
  let entered: boolean;
  try {
    entered = await enterFolder(name, expected);
  } catch (error) {
    if (hasErrorCode("ENOENT", "ENOTDIR", "ELOOP")(error))
      process.exit(readerExit.changed);
    if (hasErrorCode("EACCES", "EPERM")(error)) {
      const now = await orIfProbeFailed(
        () => lstat(name, bigint),
        undefined,
        (cause) =>
          process.stderr.write(
            `[reader] a folder could not be checked again (${failureCode(cause)})\n`
          )
      );
      if (now && sameEntry(expected, now) && now.isDirectory())
        process.exit(readerExit.unreadable);
      process.exit(readerExit.changed);
    }
    fail(error);
  }
  if (!entered) process.exit(readerExit.changed);
}
/** 연 파일을 그 크기만큼 읽는다. 읽는 사이 줄었으면 읽은 만큼이다. */
async function readAll(handle: FileHandle, size: bigint) {
  const buffer = Buffer.alloc(Number(size));
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      buffer.length - length,
      null
    );
    if (!bytesRead) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

await server(organizationId);
const claimed = await orIfProbeFailed(
  async () => {
    const opened = await openRegularFile(identityFile);
    if (typeof opened === "string") return undefined;
    try {
      if (opened.info.size > BigInt(identityMaxBytes)) return undefined;
      const text = (await readAll(opened.handle, opened.info.size)).toString(
        "utf8"
      );
      const parsed = orIfUnreadable((): unknown => JSON.parse(text), undefined);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as { organizationId?: unknown }).organizationId
        : undefined;
    } finally {
      await opened.handle.close();
    }
  },
  undefined,
  (error) =>
    process.stderr.write(
      `[reader] the folder mark could not be read (${failureCode(error)})\n`
    )
);
if (claimed !== organizationId) process.exit(readerExit.identity);
await server("shared");
try {
  const dirs: BigIntStats[] = [await stat(".", bigint)];
  const done: string[] = [];
  const up = async () => {
    dirs.pop();
    done.pop();
    const parent = dirs.at(-1);
    if (!parent || !(await enterFolder("..", parent)))
      process.exit(readerExit.changed);
  };
  let pending: string[];
  if (path.isAbsolute(requested)) {
    const fromRoot = inside(requested, typed);
    if (!fromRoot) process.exit(readerExit.outside);
    pending = fromRoot;
  } else pending = typed(requested).split(separator);
  let links = 0;
  let name: string | undefined;
  let checked: BigIntStats | undefined;
  while (pending.length > 0) {
    const part = pending.shift() ?? "";
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (done.length === 0) process.exit(readerExit.outside);
      await up();
      continue;
    }
    const refused = windowsName(part);
    if (refused !== undefined) process.exit(refused);
    let info: BigIntStats;
    try {
      info = await lstat(part, bigint);
    } catch (error) {
      fail(error);
    }
    if (info.isSymbolicLink()) {
      links += 1;
      if (links > 40) process.exit(readerExit.linkLoop);
      let target: string;
      try {
        target = await readlink(part);
      } catch (error) {
        if (hasErrorCode("ENOENT", "EINVAL", "ENOTDIR")(error))
          process.exit(readerExit.changed);
        fail(error);
      }
      if (path.isAbsolute(target)) {
        const fromRoot = inside(target, lexical);
        if (!fromRoot) process.exit(readerExit.outside);
        while (done.length > 0) await up();
        pending = [...fromRoot, ...pending];
      } else pending = [...lexical(target).split(separator), ...pending];
      continue;
    }
    if (pending.length === 0) {
      name = part;
      checked = info;
      break;
    }
    if (!info.isDirectory()) process.exit(readerExit.notFound);
    await into(part, info);
    dirs.push(info);
    done.push(part);
  }
  if (name === undefined || checked === undefined)
    process.exit(readerExit.notFile);
  if (!checked.isFile()) process.exit(readerExit.notFile);
  // 걸으며 확인한 그 파일을 연다. 다시 확인하면 그 사이에 사라지거나 바뀐 것을 없는 파일·다른 종류로 잘못 알린다.
  const opened = await openRegularFile(name);
  if (typeof opened === "string" || !sameEntry(checked, opened.info))
    process.exit(readerExit.changed);
  try {
    if (opened.info.size > BigInt(maxBytes)) process.exit(readerExit.tooLarge);
    if (opened.info.nlink !== 1n) process.exit(readerExit.hardLink);
    process.stdout.write(
      Buffer.concat([
        Buffer.from(JSON.stringify([...done, name]) + "\n"),
        await readAll(opened.handle, opened.info.size),
      ])
    );
  } finally {
    await opened.handle.close();
  }
} catch (error) {
  fail(error);
}
