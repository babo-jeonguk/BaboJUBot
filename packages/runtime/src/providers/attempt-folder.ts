import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  attemptEach,
  failureCode,
  settled,
} from "@babojubot/contracts/failure";
import { inFolder } from "@babojubot/files";
import { removeFolder } from "@babojubot/process/remove-folder";

/** 실행 시도 폴더를 쓰는 프로그램. 지우기 전에 끝내고(`end`), 그 끝(`done`)을 기다린다. */
type Program = {
  end(): void;
  done: Promise<{ ended: boolean; causes: readonly string[] }>;
};
/** 진단에 적을 폴더의 종류와 실행 시도. */
type About = {
  kind: "attempt folder" | "log folder";
  connection: string;
  runId?: string;
};

/**
 * 실행 시도가 만든 폴더 하나(실행 시도 폴더, Antigravity 기록 폴더)와 그 정리. 만든 직후 감싼다. 이 폴더를 쓰는 자원은 폴더가
 * 스스로 얻는다(얻은 뒤에 등록받으면 지우기가 시작된 뒤의 등록이 정리 밖에 남는다, #286 PR #299 외부 리뷰 1회차).
 * - 자격 증명 사본(로그인 파일, 조직 도구 토큰이 든 설정)은 `credential(name, contents)`로 폴더가 쓴다. 이름을 먼저 기록하고 같은
 *   동기 구간에서 쓰기를 시작한다. 남길 때 지울 목록은 이 기록 하나다(이름 모양으로 찾지 않는다).
 * - 이 폴더를 쓰는 프로그램은 `usedBy(start)`로 폴더가 띄운다. `start`는 await 없이 프로그램을 돌려주고, 폴더는 같은 동기 구간에서
 *   그것을 맡는다.
 * - 지우기(`remove`)는 한 번이다(다시 불러도 같은 지우기). 시작하기 전 같은 동기 구간에서 지우는 중으로 표시하고, 그 뒤로는 띄우지도
 *   쓰지도 않고 `attempt_folder_removing`으로 거절한다. 쓰기가 끝났을 때 지우기가 시작됐으면 그 사본도 거절한다(사본은 지우기가 지운다).
 * - `remove`는 맡은 프로그램을 끝내고 그 끝과 진행 중인 사본 쓰기의 끝(이행·거절)을 기다린 뒤, 모두 끝을 확인했으면(`done.ended`:
 *   트리·출력·컨테이너의 끝) 폴더를 지운다.
 *   하나라도 끝을 확인하지 못했으면 그 프로그램이 아직 폴더를 쓸 수 있으므로 폴더는 남기고 기록한 자격 증명 사본만 지운 뒤, 폴더 위치와
 *   그 실행 시도가 남긴 실패 코드(`done.causes`)를 경고로 남긴다. 시작 실패·입력 실패처럼 끝을 확인한 실행 시도는 폴더를 지운다. 남은 폴더를 거두는 곳은 아직 없다. 자격 증명 사본을 지우지 못하면 그 실패도 경고에 담는다. 실행 결과는 바꾸지 않는다.
 * - 중계(`relay.ts` `own`)와 같은 순서다(얻기 전 기록, 얻는 사이 정리가 시작되면 거절, 정리는 진행 중 얻기의 끝 뒤). 서버의 듣기 시도는
 *   사건을 promise로 바꾸는 `listenAttempt`가 필요하지만 쓰기는 이미 promise라 묶을 도움이 없다.
 * 폴더는 이 사용자만 접근하는 곳에 만들지만, 이 컴퓨터에서 도는 프로그램은 같은 사용자라 그 안을 바꿀 수 있다. 그래서 자격 증명
 * 사본은 확인한 폴더를 거쳐 그 이름을 지운다(`inFolder`, CODING_STANDARDS 「제품 코드」).
 */
export function attemptFolder(folder: string, about: About) {
  const credentials: string[] = [];
  const programs: Program[] = [];
  /** 진행 중이거나 끝난 사본 쓰기의 끝(이행·거절 모두 이행). 지우기는 이것을 모두 본 뒤 지운다. */
  const writes: Promise<void>[] = [];
  /** 지우기(한 번). `removing`은 지우기를 시작하기 전에(같은 동기 구간) 세우고, 그 뒤 얻지 않는다. */
  let removal: Promise<void> | undefined;
  let removing = false;
  const refused = () =>
    Object.assign(
      new Error(
        `the ${about.kind} of run ${about.runId ?? "(none)"} is being removed; nothing new is started or written in it`
      ),
      { code: "attempt_folder_removing" }
    );
  /** 기록한 자격 증명 사본을 지운다. 그 실패의 코드를 돌려준다. */
  const removeCredentials = async () =>
    (
      await attemptEach(
        credentials.map((name) => async () => {
          const removed = await inFolder(folder, [], (inside) =>
            rm(inside.at(name), { force: true })
          );
          // 우리가 만든 폴더가 그 자리에 없으면(옮겨짐) 사본을 지웠다는 확인이 아니다. 확인할 수 없는 칸과 함께 실패로 센다.
          if (removed.state === "absent")
            throw Object.assign(new Error("the attempt folder is gone"), {
              code: "folder_absent",
            });
          if (removed.state === "unverifiable")
            throw Object.assign(
              new Error(`the attempt folder could not be checked`),
              { code: `folder_${removed.found}` }
            );
        })
      )
    ).map(failureCode);
  /** 이 폴더를 쓰는 프로그램을 띄우고 맡는다. 지우는 중이면 띄우지 않고 거절한다. */
  function usedBy<T extends Program>(start: () => T): T;
  function usedBy<T>(start: () => T, program: (started: T) => Program): T;
  function usedBy<T>(
    start: () => T,
    program: (started: T) => Program = (started) => started as Program
  ): T {
    if (removing) throw refused();
    const started = start();
    programs.push(program(started));
    return started;
  }
  return {
    path: folder,
    /**
     * 자격 증명 사본(폴더 바로 아래 한 칸)을 이 사용자만 읽게 새로 쓰고 그 경로를 돌려준다. 이름을 먼저 기록하고(쓰기가 실패해도 지우기가
     * 그 이름을 지운다) 같은 동기 구간에서 쓰기를 시작한다. 쓰기 실패는 그 오류로, 쓰기가 끝났을 때 지우는 중이면
     * `attempt_folder_removing`으로 거절한다.
     */
    async credential(name: string, contents: string): Promise<string> {
      if (removing) throw refused();
      if (path.basename(name) !== name)
        throw new Error(`a credential copy is one name in the folder: ${name}`);
      credentials.push(name);
      const at = path.join(folder, name);
      const writing = writeFile(at, contents, { mode: 0o600, flag: "wx" });
      // 지우기가 볼 쓰기의 끝(이행·거절 모두). 쓰기의 실패는 아래 await가 부른 쪽에 넘긴다.
      writes.push(settled(writing));
      await writing;
      if (removing) throw refused();
      return at;
    },
    usedBy,
    remove(): Promise<void> {
      if (!removal) {
        removing = true;
        removal = removeAll();
      }
      return removal;
    },
  };
  async function removeAll(): Promise<void> {
    for (const program of programs) program.end();
    const ended = await Promise.all(programs.map((program) => program.done));
    // 진행 중인 사본 쓰기가 끝난 뒤에 지운다(그 전에 지우면 쓰기가 끝나 사본이 남는다). 목록은 지우는 중 표시 뒤로 늘지 않는다.
    await Promise.all(writes);
    const causes = ended.flatMap((end) => (end.ended ? [] : end.causes));
    if (ended.every((end) => end.ended)) {
      await removeWhole(folder, about);
      return;
    }
    const failed = await removeCredentials();
    const copies =
      credentials.length === 0
        ? ""
        : failed.length === 0
          ? " without the credential copies put in it"
          : `; the credential copies put in it could not all be removed (${failed.join(", ")})`;
    console.warn(
      `[provider] the programs of run ${about.runId ?? "(none)"} on connection ${about.connection} were not confirmed ended (${causes.join(", ")}); its ${about.kind} is kept at ${folder}${copies}`
    );
  }
}
/**
 * 폴더가 있으면 그 폴더가 프로그램을 띄우고 맡으며(`usedBy`), 없으면(격리하지 않은 실행) 그대로 띄운다. `program`은 띄운 것에서 폴더가
 * 끝내고 기다릴 프로그램을 꺼낸다.
 */
export function startIn<T>(
  folder: AttemptFolder | undefined,
  start: () => T,
  program: (started: T) => Program
): T {
  return folder ? folder.usedBy(start, program) : start();
}
export type AttemptFolder = ReturnType<typeof attemptFolder>;

/**
 * 폴더를 지운다. 지우기는 `removeFolder`가 하므로 잠깐 잠긴 오류는 정해진 횟수만큼 다시 시도한다.
 * 그래도 지우지 못하면 폴더는 그대로 두고 이 경고가 기록이 된다(자동으로 거두는 곳은 없고, 그 폴더가 쥐고 있던 토큰은 이미 무효다).
 */
async function removeWhole(folder: string, about: About): Promise<void> {
  try {
    await removeFolder(folder);
  } catch (error) {
    console.warn(
      `[provider] could not remove the ${about.kind} of run ${about.runId ?? "(none)"} on connection ${about.connection}; it is left at ${folder} (${failureCode(error)})`
    );
  }
}
