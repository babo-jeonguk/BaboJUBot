import { randomUUID } from "node:crypto";
import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

/** 로그인 원본마다 링크 작업을 하나씩 한다. 여러 조직과 준비 확인이 한꺼번에 같은 로그인을 옮기면 서로 지운다. */
const linking = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (linking.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(task);
  linking.set(key, next);
  void next
    .finally(() => {
      if (linking.get(key) === next) linking.delete(key);
    })
    .catch(() => {});
  return next;
}
const warned = new Set<string>();
/**
 * 모든 조직이 연결의 로그인 하나를 쓴다. 원본(`original`)은 다른 내용이 없는 로그인 전용 폴더에 두고, `at`(연결 폴더나 조직 폴더의
 * 로그인 파일)은 원본을 가리키는 링크로 둔다. 프로그램은 링크를 따라가 원본 자리에서 바꿔 쓰므로 링크가 남는다.
 * Codex(0.166.0)와 Antigravity(agy 1.5.3)는 링크를 따라가 원본 자리에 바꿔 쓴다는 것을 확인했다.
 * `at`에 보통 파일이 있으면 가장 최근 로그인(예전 연결 폴더 로그인, 링크 대신 파일을 쓴 판)이므로 원본으로 옮긴다.
 * 원본 자리는 모든 조직 컨테이너가 쓸 수 있으므로 보통 파일이 아닌 것(다른 곳을 가리키는 링크 등)은 지운다. 남기면 이 컴퓨터에서 도는
 * 프로그램이 로그인을 갱신할 때 링크를 따라가 그 파일을 덮어쓴다.
 * 링크를 먼저 임시 이름으로 만들어 본 뒤에 옮기므로, 링크를 만들 수 없는 컴퓨터(권한 없는 Windows, 링크를 모르는 파일 시스템)면 아무것도 옮기지 않고 `false`이며 그 실행은 연결 폴더의 로그인으로 돈다. 같은 원본의 링크 작업은 `oneAtATime`으로 하나씩 한다.
 */
async function linkLogin(
  original: string,
  at: string,
  label: string
): Promise<boolean> {
  await mkdir(path.dirname(original), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(at), { recursive: true, mode: 0o700 });
  const source = await lstat(original).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (source && !source.isFile())
    await rm(original, { recursive: true, force: true });
  const current = await lstat(at).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current?.isSymbolicLink() && (await readlink(at)) === original)
    return true;
  const temporary = `${at}.${randomUUID()}.link`;
  try {
    await symlink(original, temporary, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      if (!warned.has(label)) {
        warned.add(label);
        console.warn(
          `[provider] this machine cannot create file links; ${label} runs share the connection folder`
        );
      }
      return false;
    }
    throw error;
  }
  try {
    if (current?.isFile()) await rename(at, original);
    else if (current) await rm(at, { recursive: true, force: true });
    await rename(temporary, at);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

/** 연결의 로그인 원본 `original` 하나를 여러 제품 폴더가 쓰게 한다. 돌려준 함수는 `at`을 원본을 가리키는 링크로 두고, 링크를 만들 수 없는 컴퓨터면 `false`다. */
export function loginLink(original: string, label: string) {
  return (at: string) =>
    oneAtATime(original, () => linkLogin(original, at, label));
}
